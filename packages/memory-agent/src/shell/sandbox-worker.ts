// One sandboxed shell-skill run, in its own worker thread. The sandbox runtime keeps one policy,
// one filtering proxy and one violation store per module instance, so a worker per run keeps
// concurrent runs from sharing an allowlist. The host spawns the wrapped command itself and keeps
// this worker alive, serving the proxy, until the command has exited. In a checkout Node runs this
// file as TypeScript; the executable ships it bundled (`scripts/package.ts`).
import { parentPort, workerData } from "node:worker_threads";
import { Cause, Effect, Exit, Schema } from "effect";
import { requireRuntime } from "../runtime/resources.ts";
import { SandboxFinish, SandboxSetup, type SandboxReply } from "./sandbox-protocol.ts";

const port = parentPort;
if (!(port !== null)) throw new Error("the sandbox worker runs only as a worker thread");
const reply = (message: SandboxReply) => port.postMessage(message);

const reasonOf = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

const start = Effect.gen(function* () {
  const setup = yield* Schema.decodeUnknownEffect(Schema.Struct({ sandbox: SandboxSetup }))(
    workerData,
  );
  const { SandboxManager } = requireRuntime("@anthropic-ai/sandbox-runtime");
  if (!SandboxManager.isSupportedPlatform())
    return reply({ _tag: "Unavailable", reason: "unsupported_platform", detail: process.platform });
  const missing = SandboxManager.checkDependencies().errors;
  if (missing.length > 0)
    return reply({
      _tag: "Unavailable",
      reason: "missing_dependencies",
      detail: missing.join("; "),
    });
  const { command, commandId, network, allowLocalBinding, allowWrite, denyRead, denyWrite } =
    setup.sandbox;
  yield* Effect.tryPromise(() =>
    SandboxManager.initialize({
      // No ask callback: a host off the list is refused, and the run reports it.
      network: {
        allowedDomains: [...network],
        deniedDomains: [],
        strictAllowlist: true,
        allowLocalBinding,
      },
      filesystem: {
        denyRead: [...denyRead],
        allowWrite: [...allowWrite],
        denyWrite: [...denyWrite],
      },
    }),
  );
  const wrapped = yield* Effect.tryPromise(() =>
    SandboxManager.wrapWithSandbox(command, "/bin/sh", undefined, undefined, { commandId }),
  );
  port.once("message", (message) => {
    const finish = Schema.decodeUnknownEffect(SandboxFinish)(message).pipe(
      Effect.flatMap(({ stderr }) =>
        Effect.try(() => SandboxManager.annotateStderrWithSandboxFailures(commandId, stderr)),
      ),
      Effect.ensuring(Effect.ignore(Effect.tryPromise(() => SandboxManager.reset()))),
    );
    void Effect.runPromiseExit(finish).then((exit) =>
      reply({
        _tag: "Finished",
        stderr: Exit.match(exit, { onSuccess: (stderr) => stderr, onFailure: () => null }),
      }),
    );
  });
  reply({ _tag: "Wrapped", command: wrapped });
});

void Effect.runPromiseExit(start).then((exit) =>
  Exit.match(exit, {
    onSuccess: () => undefined,
    onFailure: (cause) =>
      reply({ _tag: "Unavailable", reason: "setup_failed", detail: reasonOf(cause) }),
  }),
);
