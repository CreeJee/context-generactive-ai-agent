// Native host boundary: worker threads and a scratch folder for the sandbox runtime's sockets.
import { NodeWorker } from "@effect/platform-node";
import { Worker } from "node:worker_threads";
import {
  Data,
  Duration,
  Effect,
  FileSystem,
  Function as EffectFunction,
  Layer,
  Option,
} from "effect";
import { RpcClient } from "effect/rpc";
import { failureAnnotations } from "../runtime/logged-failures.ts";
import { writableRoots } from "../files/path-policy.ts";
import { credentialNameGlobs } from "../files/paths.ts";
import { homeDirectory } from "../runtime/host-system.ts";
import { path } from "../runtime/synchronous-path.ts";
import { runtimeWorker, runtimeWorkerOptions } from "../runtime/resources.ts";
import type { CommandResult } from "./run.ts";
import { SandboxRpcs, SandboxUnavailable, type SandboxSetup } from "./sandbox-protocol.ts";

export { SandboxUnavailable } from "./sandbox-protocol.ts";

/**
 * Credential stores under the home folder that scripts cannot read. The file tools' name-based
 * guard (`isCredentialPath`) covers project files; a script reads with the user's rights, so its
 * sandbox names the well-known stores directly, agent and browser logins included.
 */
const credentialHomePaths = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  ".password-store",
  ".netrc",
  ".pgpass",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  ".config/git/credentials",
  ".config/gh",
  ".config/gcloud",
  ".config/op",
  ".config/github-copilot",
  ".cargo/credentials.toml",
  ".cargo/credentials.d",
  ".codex",
  ".claude.json",
  ".claude/.credentials.json",
  ".gemini",
  ".mcp-auth",
  ".mozilla",
  ".thunderbird",
  "Library/Keychains",
  "Library/Cookies",
  "Library/Application Support/Google/Chrome",
  "Library/Application Support/Chromium",
  "Library/Application Support/BraveSoftware",
  "Library/Application Support/Firefox",
] as const;

/** Package-manager and toolchain caches under the home folder that installs and builds write to. */
const cacheHomePaths = [
  ".npm",
  ".cache",
  "Library/Caches",
  "Library/pnpm",
  ".local/share/pnpm",
  ".pnpm-store",
  ".yarn",
  ".bun/install/cache",
  ".deno",
  ".cargo/registry",
  ".cargo/git",
  "go/pkg/mod",
  ".gradle/caches",
  ".m2/repository",
  ".vite-plus",
] as const;

/** How much a sandboxed script may do. */
export type SandboxAccess = Data.TaggedEnum<{
  /**
   * Only look: no file outside the temporary folders changes and no host is reached, so nothing the
   * script does outlasts it. It needs no approval, which is why it also cannot read the project's
   * credential-named files, as the file tools cannot.
   */
  Read: {};
  /** Change the run's root and reach `network`: what an approved script does. */
  Write: { readonly network: readonly string[] };
}>;
export const SandboxAccess = Data.taggedEnum<SandboxAccess>();

/**
 * What a sandboxed script may touch, by its {@link SandboxAccess}.
 *
 * `Write`: writes reach the run's root (a card's worktree in a kanban card) and the temporary
 * folders, as the path policy names them (`writableRoots`), and caches, but not the project's
 * skills, which change only through `save_code_skill`. Network: only the script's approved hosts.
 * Loopback ports (local test and dev servers) only when the hosts include `localhost`, because that
 * also reaches every local service, this app's own server included.
 *
 * `Read`: writes reach the temporary folders alone, never the run's folders even when those lie
 * below a temporary folder, and no host. Caches are left out too: a package cache written now is
 * code that runs later outside the sandbox.
 *
 * Reads, for both: everything except credential stores and the app's own storage. The sandbox
 * runtime adds its own write protection (shell profiles, `.git/hooks`, `.git/config`, …).
 */
export const sandboxPolicy = Effect.fnUntraced(function* (input: {
  readonly projectRoot: string;
  /** The user's project folder, when the run works in a copy of it (a kanban card). */
  readonly userRoot?: string;
  readonly storageRoot: string;
  readonly access: SandboxAccess;
}) {
  const home = yield* homeDirectory;
  const fs = yield* FileSystem.FileSystem;
  // macOS checks the real path, and the runtime leaves a bare `/tmp` unresolved because its link
  // leaves the folder (`/private/tmp`): the rule then matched nothing. A path that does not exist
  // yet keeps its spelling.
  const real = (paths: readonly string[]) =>
    Effect.forEach(paths, (entry) => fs.realPath(entry).pipe(Effect.orElseSucceed(() => entry)));
  const writable = yield* writableRoots(input.projectRoot);
  const stores = [...credentialHomePaths.map((entry) => path.join(home, entry)), input.storageRoot];
  return yield* SandboxAccess.$match(input.access, {
    Read: () =>
      Effect.map(real(Option.toArray(Option.fromNullishOr(input.userRoot))), (userRoots) => {
        const folders = [writable.root, ...userRoots];
        return {
          network: [],
          allowLocalBinding: false,
          allowWrite: writable.temporary,
          denyRead: [
            ...stores,
            ...folders.flatMap((folder) =>
              credentialNameGlobs.map((glob) => path.join(folder, glob)),
            ),
          ],
          denyWrite: folders,
        };
      }),
    Write: ({ network }) =>
      Effect.map(real(cacheHomePaths.map((entry) => path.join(home, entry))), (caches) => ({
        network,
        allowLocalBinding: network.includes("localhost"),
        allowWrite: [writable.root, ...writable.temporary, ...caches],
        denyRead: stores,
        denyWrite: [path.join(writable.root, ".agents", "skills")],
      })),
  });
});

/** How long the worker gets to report what it blocked once the command has exited. */
const finishTimeout = Duration.seconds(5);

/**
 * Runs one command inside the OS sandbox: a worker thread prepares the sandbox and serves its
 * network filter, `run` executes the wrapped command line, and the worker then appends what the
 * sandbox blocked to stderr. The worker and its scratch folder end with the scope, whether the
 * command finished, failed or was interrupted.
 */
type Sandboxed<E, R> = Effect.Effect<
  CommandResult,
  E | SandboxUnavailable,
  FileSystem.FileSystem | R
>;

export const runSandboxed: {
  <E, R>(
    run: (command: string) => Effect.Effect<CommandResult, E, R>,
  ): (setup: SandboxSetup) => Sandboxed<E, R>;
  <E, R>(
    setup: SandboxSetup,
    run: (command: string) => Effect.Effect<CommandResult, E, R>,
  ): Sandboxed<E, R>;
} = EffectFunction.dual(2, runSandboxedBody);
function runSandboxedBody<E, R>(
  setup: SandboxSetup,
  run: (command: string) => Effect.Effect<CommandResult, E, R>,
): Sandboxed<E, R> {
  return Effect.scoped(
    Effect.gen(function* () {
      const unavailable = (detail: string) =>
        SandboxUnavailable.make({ reason: "setup_failed", detail });
      // The runtime names its proxy sockets after the process id, so concurrent workers each need
      // their own TMPDIR.
      const fileSystem = yield* FileSystem.FileSystem;
      const scratch = yield* fileSystem
        .makeTempDirectoryScoped({ prefix: "context-agent-sandbox-" })
        .pipe(Effect.mapError(() => unavailable("could not create the sandbox's scratch folder")));
      const file = yield* runtimeWorker("sandbox-worker").pipe(
        Effect.mapError(() => unavailable("could not start the sandbox worker")),
      );
      const options = yield* runtimeWorkerOptions({ sandbox: setup });
      const workers = NodeWorker.layer(
        () => new Worker(file, { ...options, env: { ...process.env, TMPDIR: scratch } }),
      );
      const protocol = yield* Layer.build(
        RpcClient.layerProtocolWorker({ size: 1, concurrency: 1 }).pipe(Layer.provide(workers)),
      ).pipe(Effect.mapError(() => unavailable("could not start the sandbox worker")));
      const client = yield* RpcClient.make(SandboxRpcs).pipe(Effect.provideContext(protocol));

      const command = yield* client
        .Prepare()
        .pipe(
          Effect.catchTag("RpcClientError", () =>
            Effect.fail(unavailable("the sandbox worker stopped")),
          ),
        );
      const result = yield* run(command);
      // Without the worker's report the command's own stderr stands.
      const stderr = yield* client.Finish({ stderr: result.stderr }).pipe(
        Effect.timeoutOption(finishTimeout),
        Effect.catch((error) =>
          Effect.as(
            Effect.logDebug("sandbox_report_unavailable", {
              ...failureAnnotations(error),
            }),
            Option.none<string>(),
          ),
        ),
        Effect.map(Option.getOrElse(() => result.stderr)),
      );
      return { ...result, stderr };
    }),
  );
}
