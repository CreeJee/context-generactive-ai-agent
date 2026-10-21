import { DatabaseSync } from "node:sqlite";
import type { AnyTextAdapter } from "@tanstack/ai";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import {
  Cause,
  Effect,
  FileSystem,
  Fiber,
  Function as EffectFunction,
  Layer,
  Path,
  Result,
  Schema,
  Stream,
} from "effect";
import type { ChatExecutionCapabilities } from "../../src/agent/chat-execution.ts";
import {
  createFullLoopExecution,
  type FullLoopOwner,
} from "../../src/agent/full-loop-execution.ts";
import type { OwnerRpcCapability } from "../../src/agent/owner-rpc.ts";
// The fixture owns a standalone owner ledger outside any agent composition root.
// oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports
import { makeSqliteOwnerRpcLedger } from "../../src/agent/owner-rpc-ledger.ts";
import { connectionContext } from "../../src/db/database.ts";
import { migrations } from "../../src/db/migrations.ts";
import { ExecutionAdmission } from "../../src/runtime/execution-admission.ts";

/** Native SDK calls (iterator pulls, tool executes) cross into Effect here. */
export const sdkCall = <A>(call: () => A | PromiseLike<A>) =>
  Effect.tryPromise(() => Promise.resolve(call()));

/** The turn every fixture run executes: run `r` of session `s`. */
export const ownerTurn = { messages: [], runId: "r", threadId: "s" };

/** What an owner fixture needs when no agent provides it. */
export const ownerLayer = Layer.mergeAll(
  ExecutionAdmission.layer(),
  NodeFileSystem.layer,
  NodePath.layer,
);

/**
 * An owner database apart from any agent, with run `r` of session `s` bound to Goal `g`, and the
 * owner capability that admits a real full-loop worker for that run.
 */
export const ownerFixture = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "full-loop-owner-" });
  const file = path.join(directory, "owner.sqlite");
  const sqlite = yield* Effect.acquireRelease(
    Effect.sync(() => new DatabaseSync(file)),
    (sqlite) =>
      Effect.sync(() => {
        if (sqlite.isOpen) sqlite.close();
      }),
  );
  for (const step of migrations) sqlite.exec(step);
  sqlite.exec(`INSERT INTO projects (id, root, name, created_at) VALUES ('p', '/test', 'test', 'now');
    INSERT INTO sessions (id, project_id, created_at) VALUES ('s', 'p', 'now');
    INSERT INTO workflow_goal_identities VALUES ('s', 'g', 'now');
    INSERT INTO workflow_state_revisions (id, session_id, state_json, goal_version, plan_version, provenance, created_at, goal_instance_id)
    VALUES (1, 's', '{}', 1, NULL, 'recorded', 'now', 'g');
    INSERT INTO workflow_run_bindings VALUES ('r', 's', 'g', 1, NULL, 1, 'now');`);
  const ledger = yield* Effect.flatMap(connectionContext(sqlite), (context) =>
    Effect.provideContext(makeSqliteOwnerRpcLedger, context),
  );
  const capability: OwnerRpcCapability = {
    runId: "r",
    sessionId: "s",
    goalInstanceId: "g",
    goalVersion: 1,
    planVersion: null,
    workflowRevisionId: 1,
    generation: "one",
    token: "secret",
  };
  const owner: FullLoopOwner = {
    admission: yield* ExecutionAdmission,
    ledger,
    capability,
    lastOperationId: 0,
    permits: (candidate) =>
      Effect.sync(() =>
        Object.entries(capability).every(([key, value]) =>
          Object.entries(candidate).some(
            ([candidateKey, candidateValue]) => candidateKey === key && candidateValue === value,
          ),
        ),
      ),
    workerUrl: new URL("../../src/agent/full-loop-worker.ts", import.meta.url),
  };
  return {
    sqlite,
    owner,
    /** A second connection, as a restarted owner would read the ledger. */
    reopenRead: Effect.acquireRelease(
      Effect.sync(() => new DatabaseSync(file)),
      (reopened) =>
        Effect.sync(() => {
          if (reopened.isOpen) reopened.close();
        }),
    ),
    /** Durable owner RPC reservations of every kind. */
    operations: () =>
      sqlite.prepare("SELECT count(*) AS count FROM owner_rpc_operations").get()?.count,
    /** Settlement of each reserved tool call. */
    toolStatuses: () =>
      sqlite
        .prepare(
          `SELECT status FROM owner_rpc_operations WHERE fingerprint LIKE '%"operation":"tool"%'`,
        )
        .all(),
  };
});

export type OwnerFixture = Effect.Success<ReturnType<typeof ownerFixture>>;

/** The native SDK caller's own abort controller; the worker run aborts it when it ends. */
export const callerController = () => new AbortController();

/** SDK capabilities with no tools or middleware unless given, and their own abort controller. */
type CapabilityOptions<TAdapter extends AnyTextAdapter> = Partial<
  Omit<ChatExecutionCapabilities<TAdapter>, "model">
>;

const isModel = Schema.is(Schema.Struct({ adapter: Schema.ObjectKeyword }));

export const capabilities: {
  <TAdapter extends AnyTextAdapter>(
    model: ChatExecutionCapabilities<TAdapter>["model"],
    rest?: CapabilityOptions<TAdapter>,
  ): ChatExecutionCapabilities<TAdapter>;
  <TAdapter extends AnyTextAdapter>(
    rest?: CapabilityOptions<TAdapter>,
  ): (model: ChatExecutionCapabilities<TAdapter>["model"]) => ChatExecutionCapabilities<TAdapter>;
} = EffectFunction.dual(
  (args) => isModel(args[0]),
  <TAdapter extends AnyTextAdapter>(
    model: ChatExecutionCapabilities<TAdapter>["model"],
    rest: CapabilityOptions<TAdapter> = {},
  ): ChatExecutionCapabilities<TAdapter> => ({
    model,
    tools: [],
    middleware: [],
    stream: { abortController: callerController() },
    ...rest,
  }),
);

/** Every chunk of one full-loop run through the real worker. */
export const collect = Effect.fnUntraced(function* <TAdapter extends AnyTextAdapter>(
  owner: FullLoopOwner,
  run: ChatExecutionCapabilities<TAdapter>,
  turn: Parameters<ReturnType<typeof createFullLoopExecution<TAdapter>>["execute"]>[0] = ownerTurn,
) {
  return yield* Stream.runCollect(
    Stream.fromAsyncIterable(
      createFullLoopExecution<TAdapter>(owner).execute(turn, run),
      (cause) => new Cause.UnknownError(cause),
    ),
  );
});

/**
 * Runs owner-side Effects from native SDK callbacks (tool executes, middleware hooks) in the
 * test's own Scope, so a gate they await is released with the test.
 */
export const sdkRunner = Effect.fnUntraced(function* () {
  const scope = yield* Effect.scope;
  const run = Effect.runPromiseWith(yield* Effect.context());
  return <A>(program: Effect.Effect<A, Cause.UnknownError>) =>
    run(Effect.forkIn(Effect.result(program), scope).pipe(Effect.flatMap(Fiber.join))).then(
      Result.match({
        onSuccess: (value) => value,
        onFailure: (failure) => Promise.reject(failure.cause),
      }),
    );
});

/**
 * A worker speaking the real RPC protocol whose run body is `source`; it calls the owner through
 * `rpc(operation, input)` to probe what the owner accepts.
 */
export function maliciousWorker(source: string) {
  const effectUrl = import.meta.resolve("effect");
  const rpcUrl = import.meta.resolve("effect/rpc");
  const platformNodeUrl = import.meta.resolve("@effect/platform-node");
  const nativeEffectUrl = new URL("../../src/runtime/native-effect.ts", import.meta.url).href;
  const codecUrl = new URL("../../src/agent/full-loop-codec.ts", import.meta.url).href;
  const rpcDefinitionsUrl = new URL("../../src/agent/full-loop-effect-rpc.ts", import.meta.url)
    .href;
  const messagePortUrl = new URL("../../src/agent/effect-rpc-message-port.ts", import.meta.url)
    .href;
  return new URL(
    `data:text/javascript;base64,${Buffer.from(`
    import { NodeWorkerRunner } from ${JSON.stringify(platformNodeUrl)};
    import { Effect, Layer, Stream } from ${JSON.stringify(effectUrl)};
    import { RpcClient, RpcServer } from ${JSON.stringify(rpcUrl)};
    import { runNativeEffect } from ${JSON.stringify(nativeEffectUrl)};
    import { encodeFullLoopValue, decodeFullLoopValue } from ${JSON.stringify(codecUrl)};
    import {
      FullLoopCapabilityMiddleware,
      FullLoopOwnerReply,
      FullLoopOwnerRpcGroup,
      FullLoopRpcError,
      FullLoopRpcGroup,
    } from ${JSON.stringify(rpcDefinitionsUrl)};
    import { layerMessagePortRpcClient } from ${JSON.stringify(messagePortUrl)};

    const runFullLoop = (payload) => Stream.unwrap(Effect.gen(function* () {
      const ownerProtocolContext = yield* Layer.build(layerMessagePortRpcClient(payload.ownerPort));
      const owner = yield* RpcClient.make(FullLoopOwnerRpcGroup).pipe(
        Effect.provide(ownerProtocolContext),
      );
      let id = payload.lastOperationId;
      const rpc = (operation, input) => runNativeEffect(owner.OwnerCall({
        type: 'owner-rpc-request', capability: payload.capability,
        operationId: ++id, operation, input: encodeFullLoopValue(input),
      }));
      const result = yield* Effect.tryPromise({
        try: async () => {
          ${source}
        },
        catch: () => FullLoopRpcError.make({ reason: 'worker_failed' }),
      });
      return Stream.make(result);
    }));

    const handlers = FullLoopRpcGroup.toLayer({ RunFullLoop: runFullLoop });
    const authorization = Layer.succeed(FullLoopCapabilityMiddleware, (effect) => effect);
    const protocol = RpcServer.layerProtocolWorkerRunner.pipe(Layer.provide(NodeWorkerRunner.layer));
    const server = RpcServer.layer(FullLoopRpcGroup, {
      concurrency: 1,
      disableFatalDefects: true,
    }).pipe(Layer.provide(handlers), Layer.provide(authorization), Layer.provide(protocol));
    await runNativeEffect(Layer.launch(server));
  `).toString("base64")}`,
  );
}
