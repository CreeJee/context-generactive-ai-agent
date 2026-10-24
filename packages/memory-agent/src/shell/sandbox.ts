// Native host boundary: worker threads and a scratch folder for the sandbox runtime's sockets.
import { NodeWorker } from "@effect/platform-node";
import { Worker } from "node:worker_threads";
import {
  Cause,
  Duration,
  Effect,
  FileSystem,
  Function as EffectFunction,
  Layer,
  Option,
} from "effect";
import { RpcClient } from "effect/rpc";
import { failureTags } from "../runtime/logged-failures.ts";
import { homeDirectory, temporaryDirectory } from "../runtime/host-system.ts";
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

/**
 * What a sh skill's script may touch. Writes: the project, temp folders and caches, but not the
 * project's skills, which change only through `save_code_skill`. Reads: everything except
 * credential stores and the app's own storage. Network: only the script's approved hosts.
 * Loopback ports (local test and dev servers) only when the hosts include `localhost`, because that
 * also reaches every local service, this app's own server included. The sandbox runtime adds its
 * own write protection (shell profiles, `.git/hooks`, `.git/config`, …).
 */
export const sandboxPolicy = (input: {
  readonly projectRoot: string;
  readonly storageRoot: string;
  readonly network: readonly string[];
}) =>
  Effect.map(Effect.all([homeDirectory, temporaryDirectory]), ([home, temporary]) => ({
    network: input.network,
    allowLocalBinding: input.network.includes("localhost"),
    allowWrite: [
      input.projectRoot,
      "/tmp",
      temporary,
      ...cacheHomePaths.map((entry) => path.join(home, entry)),
    ],
    denyRead: [...credentialHomePaths.map((entry) => path.join(home, entry)), input.storageRoot],
    denyWrite: [path.join(input.projectRoot, ".agents", "skills")],
  }));

/** How long the worker gets to report what it blocked once the command has exited. */
const finishTimeout = Duration.seconds(5);

/**
 * Runs one command inside the OS sandbox: a worker thread prepares the sandbox and serves its
 * network filter, `run` executes the wrapped command line, and the worker then appends what the
 * sandbox blocked to stderr. The worker and its scratch folder end with the scope, whether the
 * command finished, failed or was interrupted.
 */
type Sandboxed<E> = Effect.Effect<CommandResult, E | SandboxUnavailable, FileSystem.FileSystem>;

export const runSandboxed: {
  <E>(
    run: (command: string) => Effect.Effect<CommandResult, E>,
  ): (setup: SandboxSetup) => Sandboxed<E>;
  <E>(setup: SandboxSetup, run: (command: string) => Effect.Effect<CommandResult, E>): Sandboxed<E>;
} = EffectFunction.dual(2, runSandboxedBody);
function runSandboxedBody<E>(
  setup: SandboxSetup,
  run: (command: string) => Effect.Effect<CommandResult, E>,
): Sandboxed<E> {
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
      const workers = NodeWorker.layer(
        () =>
          new Worker(runtimeWorker("sandbox-worker"), {
            ...runtimeWorkerOptions({ sandbox: setup }),
            env: { ...process.env, TMPDIR: scratch },
          }),
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
              error: failureTags(Cause.fail(error)),
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
