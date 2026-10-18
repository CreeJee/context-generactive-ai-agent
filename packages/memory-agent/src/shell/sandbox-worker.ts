// One sandboxed shell-skill run, in its own worker thread. The sandbox runtime keeps one policy,
// one filtering proxy and one violation store per module instance, so a worker per run keeps
// concurrent runs from sharing an allowlist. The host spawns the wrapped command itself and keeps
// this worker alive, serving the proxy, until the command has exited. In a checkout Node runs this
// file as TypeScript; the executable ships it bundled (`scripts/package.ts`).
import { ignoreLogged } from "../runtime/logged-failures.ts";
import * as NodeWorkerRunner from "@effect/platform-node/NodeWorkerRunner";
import { workerData } from "node:worker_threads";
import { Effect, Layer, Schema } from "effect";
import { RpcServer } from "effect/rpc";
import { runNativeEffect } from "../runtime/native-effect.ts";
import { requireRuntime } from "../runtime/resources.ts";
import {
  SandboxReportFailed,
  SandboxRpcs,
  SandboxSetup,
  SandboxUnavailable,
} from "./sandbox-protocol.ts";

const setupFailed = <E>(cause: E) =>
  SandboxUnavailable.make({
    reason: "setup_failed",
    detail: cause instanceof Error ? cause.message : String(cause),
  });

/** Sets the sandbox up for this worker's one command; the worker's Scope resets it. */
const prepare = Effect.gen(function* () {
  const { sandbox } = yield* Schema.decodeUnknownEffect(Schema.Struct({ sandbox: SandboxSetup }))(
    workerData,
  ).pipe(Effect.mapError(setupFailed));
  const { SandboxManager } = yield* Effect.try({
    try: () => requireRuntime("@anthropic-ai/sandbox-runtime"),
    catch: setupFailed,
  });
  yield* Effect.sync(() => SandboxManager.isSupportedPlatform()).pipe(
    Effect.filterOrFail(
      (supported) => supported,
      () => SandboxUnavailable.make({ reason: "unsupported_platform", detail: process.platform }),
    ),
  );
  yield* Effect.sync(() => SandboxManager.checkDependencies().errors).pipe(
    Effect.filterOrFail(
      (missing) => missing.length === 0,
      (missing) =>
        SandboxUnavailable.make({ reason: "missing_dependencies", detail: missing.join("; ") }),
    ),
  );
  const { command, commandId, network, allowLocalBinding, allowWrite, denyRead, denyWrite } =
    sandbox;
  yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
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
      catch: setupFailed,
    }),
    () =>
      Effect.tryPromise(() => SandboxManager.reset()).pipe(ignoreLogged("sandbox_reset_failed")),
  );
  const wrapped = yield* Effect.tryPromise({
    try: (signal) =>
      SandboxManager.wrapWithSandbox(command, "/bin/sh", undefined, signal, { commandId }),
    catch: setupFailed,
  });
  return {
    wrapped,
    annotate: (stderr: string) =>
      Effect.try({
        try: () => SandboxManager.annotateStderrWithSandboxFailures(commandId, stderr),
        catch: () => SandboxReportFailed.make({ reason: "annotate_failed" }),
      }),
  };
});

const handlers = SandboxRpcs.toLayer(
  Effect.gen(function* () {
    // A failed setup is kept and reported by Prepare, so the host learns why instead of an exit.
    const prepared = yield* Effect.exit(prepare);
    return SandboxRpcs.of({
      Prepare: () => Effect.map(prepared, (current) => current.wrapped),
      Finish: ({ stderr }) =>
        prepared.pipe(
          Effect.mapError(() => SandboxReportFailed.make({ reason: "annotate_failed" })),
          Effect.flatMap((current) => current.annotate(stderr)),
        ),
    });
  }),
);

const protocol = RpcServer.layerProtocolWorkerRunner.pipe(Layer.provide(NodeWorkerRunner.layer));
// One command per worker: Prepare, then Finish once it has exited.
const server = RpcServer.layer(SandboxRpcs, { concurrency: 1 }).pipe(
  Layer.provide(handlers),
  Layer.provide(protocol),
);

await runNativeEffect(Layer.launch(server));
