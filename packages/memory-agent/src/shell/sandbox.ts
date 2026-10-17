// Native host boundary: worker threads and a scratch folder for the sandbox runtime's sockets.
import { homedir, tmpdir } from "node:os";
import { Worker } from "node:worker_threads";
import {
  Cause,
  Duration,
  Effect,
  FileSystem,
  Function as EffectFunction,
  Option,
  Queue,
  Schema,
} from "effect";
import { path } from "../runtime/synchronous-path.ts";
import { runtimeWorker, runtimeWorkerOptions } from "../runtime/resources.ts";
import type { CommandResult } from "./run.ts";
import {
  SandboxReply,
  SandboxUnavailableReason,
  type SandboxFinish,
  type SandboxSetup,
} from "./sandbox-protocol.ts";

export class SandboxUnavailable extends Schema.TaggedError<SandboxUnavailable>()(
  "SandboxUnavailable",
  { reason: SandboxUnavailableReason, detail: Schema.String },
) {
  override get message() {
    return `sandbox_unavailable (${this.reason}): ${this.detail}`;
  }
}

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
 * What a shell skill's script may touch. Writes: the project, temp folders and caches, but not the
 * project's skills, which change only through `save_shell_skill`. Reads: everything except
 * credential stores and the app's own storage. Network: only the script's approved hosts.
 * Loopback ports (local test and dev servers) only when the hosts include `localhost`, because that
 * also reaches every local service, this app's own server included. The sandbox runtime adds its
 * own write protection (shell profiles, `.git/hooks`, `.git/config`, …).
 */
export const sandboxPolicy = (input: {
  readonly projectRoot: string;
  readonly storageRoot: string;
  readonly network: readonly string[];
}) => {
  const home = homedir();
  return {
    network: input.network,
    allowLocalBinding: input.network.includes("localhost"),
    allowWrite: [
      input.projectRoot,
      "/tmp",
      tmpdir(),
      ...cacheHomePaths.map((entry) => path.join(home, entry)),
    ],
    denyRead: [...credentialHomePaths.map((entry) => path.join(home, entry)), input.storageRoot],
    denyWrite: [path.join(input.projectRoot, ".agents", "skills")],
  };
};

/** What a worker's uncaught error carries that is safe to show. */
const WorkerError = Schema.Struct({ message: Schema.String });

/** The wrapped command line from the worker's first reply, or why the sandbox cannot run it. */
const wrappedCommand = (
  reply: SandboxReply,
  unavailable: (detail: string) => SandboxUnavailable,
): Effect.Effect<string, SandboxUnavailable> => {
  switch (reply._tag) {
    case "Wrapped":
      return Effect.succeed(reply.command);
    case "Unavailable":
      return Effect.fail(SandboxUnavailable.make({ reason: reply.reason, detail: reply.detail }));
    case "Finished":
      return Effect.fail(unavailable("the sandbox worker finished before it started"));
  }
};

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
      const replies = yield* Queue.unbounded<SandboxReply, SandboxUnavailable>();
      const lost = (detail: string) =>
        Queue.failCauseUnsafe(replies, Cause.fail(unavailable(detail)));
      const worker = yield* Effect.acquireRelease(
        Effect.try({
          try: () =>
            new Worker(runtimeWorker("sandbox-worker"), {
              ...runtimeWorkerOptions({ sandbox: setup }),
              env: { ...process.env, TMPDIR: scratch },
            }),
          catch: () => unavailable("could not start the sandbox worker"),
        }),
        (worker) => Effect.promise(() => worker.terminate()),
      );
      worker.on("message", (message) =>
        Option.match(Schema.decodeUnknownOption(SandboxReply)(message), {
          onNone: () => lost("invalid sandbox worker reply"),
          onSome: (reply) => Queue.offerUnsafe(replies, reply),
        }),
      );
      worker.on("error", (error) =>
        lost(
          Option.match(Schema.decodeUnknownOption(WorkerError)(error), {
            onNone: () => "the sandbox worker failed",
            onSome: ({ message }) => message,
          }),
        ),
      );
      worker.on("exit", () => lost("the sandbox worker stopped"));

      const prepared = yield* Queue.take(replies);
      const command = yield* wrappedCommand(prepared, unavailable);
      const result = yield* run(command);
      worker.postMessage({ _tag: "Finish", stderr: result.stderr } satisfies SandboxFinish);
      const finished = yield* Queue.take(replies).pipe(
        Effect.timeoutOption(finishTimeout),
        Effect.orElseSucceed(() => Option.none()),
      );
      const stderr = Option.match(finished, {
        onNone: () => null,
        onSome: (reply) => (reply._tag === "Finished" ? reply.stderr : null),
      });
      return { ...result, stderr: stderr ?? result.stderr };
    }),
  );
}
