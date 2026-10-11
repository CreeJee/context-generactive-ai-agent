import { withTestPlatform } from "./support/platform.ts";
import { Schema } from "effect";
import { it as effectTest } from "@effect/vitest";
// Real MessagePorts exercise the native worker transport; Scope owns ports, handlers and storage.
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { describe, expect } from "vite-plus/test";
import { Cause, Deferred, Effect, Fiber, FileSystem, Path, Scope, Context, Exit } from "effect";
import { DatabaseSync } from "node:sqlite";
import { migrations } from "../src/db/migrations.ts";
import { makeSqliteOwnerRpcLedger } from "../src/agent/owner-rpc-ledger.ts";
import {
  makeOwnerRpc,
  makeInMemoryOwnerRpcLedger,
  type OwnerRpcRequest,
} from "../src/agent/owner-rpc.ts";
import {
  makeOwnerRpcPortClient,
  serveOwnerRpcPort,
  serveOwnerRpcPortEffect,
} from "../src/agent/owner-rpc-transport.ts";

const sdkCall = Effect.fn("ownerTransportTest.sdkCall")(function* <A>(
  operation: () => A | PromiseLike<A>,
) {
  return yield* Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: (cause) => new Cause.UnknownError(cause),
  });
});
const channels = () =>
  Effect.acquireRelease(
    Effect.sync(() => new MessageChannel()),
    (ports) =>
      Effect.sync(() => {
        ports.port1.close();
        ports.port2.close();
      }),
  );
const portEvent = (port: MessagePort, event: "close" | "message") =>
  Effect.callback<void>((resume) => {
    const listener = () => resume(Effect.void);
    port.once(event, listener);
    return Effect.sync(() => port.off(event, listener));
  });
type Operations = { tool: { input: string; output: string } };
const request = (operationId = 1): OwnerRpcRequest<Operations> => ({
  type: "owner-rpc-request",
  operation: "tool",
  operationId,
  input: "value",
  capability: {
    sessionId: "s",
    runId: "r",
    goalInstanceId: "g",
    goalVersion: 1,
    planVersion: null,
    workflowRevisionId: 1,
    generation: "one",
    token: "secret",
  },
});
const fixture = Effect.fn("ownerTransportTest.fixture")(function* (
  execute: () => Promise<string> = () => Promise.resolve("done"),
) {
  const { port1, port2 } = yield* channels();
  let calls = 0;
  const owner = serveOwnerRpcPort<Operations>(port1, {
    permits: (claim) => claim.token === "secret",
    ledger: makeInMemoryOwnerRpcLedger(),
    handlers: {
      tool: {
        sideEffect: true,
        execute: () =>
          Promise.resolve().then(() => {
            calls++;
            return execute();
          }),
      },
    },
  });
  const client = makeOwnerRpcPortClient<Operations>(port2);
  return {
    client,
    owner,
    calls: () => calls,
    close: () => {
      client.close();
      owner.close();
    },
  };
});

describe("owner MessagePort RPC", () => {
  effectTest.live(
    "interrupts a native suspended handler on real peer close and preserves durable pending",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "port-ledger-" });
        const file = path.join(dir, "owner.sqlite");
        let sqlite = new DatabaseSync(file);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (sqlite.isOpen) sqlite.close();
          }),
        );
        for (const migration of migrations) sqlite.exec(migration);
        sqlite.exec(`INSERT INTO projects (id, root, name, created_at) VALUES ('p', '/test', 'test', 'now');
      INSERT INTO sessions (id, project_id, created_at) VALUES ('s', 'p', 'now');
      INSERT INTO workflow_goal_identities VALUES ('s', 'g', 'now');
      INSERT INTO workflow_state_revisions
      (id, session_id, state_json, goal_version, plan_version, provenance, created_at, goal_instance_id)
      VALUES (1, 's', '{}', 1, NULL, 'recorded', 'now', 'g');
      INSERT INTO workflow_run_bindings VALUES ('r', 's', 'g', 1, NULL, 1, 'now');`);
        const ledger = () =>
          makeSqliteOwnerRpcLedger({
            sqlite,
            atomic: (work) => {
              sqlite.exec("BEGIN IMMEDIATE");
              try {
                const result = work();
                sqlite.exec("COMMIT");
                return result;
              } catch (error) {
                sqlite.exec("ROLLBACK");
                throw error;
              }
            },
          });
        const scope = yield* Scope.fork(yield* Effect.scope);
        const { port1, port2 } = yield* channels();
        const ready = yield* Deferred.make<void>();
        const interrupted = yield* Deferred.make<void>();
        const started = () => Deferred.doneUnsafe(ready, Effect.void);
        const stopped = () => Deferred.doneUnsafe(interrupted, Effect.void);
        let calls = 0;
        let replies = 0;
        port2.on("message", () => {
          replies++;
        });
        const endpoint = yield* Effect.provide(
          serveOwnerRpcPortEffect<Operations>(port1, {
            permits: () => true,
            ledger: ledger(),
            handlers: {
              tool: {
                sideEffect: true,
                execute: () =>
                  Effect.sync(() => {
                    calls++;
                    started();
                  }).pipe(Effect.andThen(Effect.never), Effect.ensuring(Effect.sync(stopped))),
              },
            },
          }),
          Context.make(Scope.Scope, scope),
        );
        try {
          port2.postMessage({ type: "request", requestId: 1, request: request() });
          yield* Deferred.await(ready);
          port2.close();
          yield* Deferred.await(interrupted);
          yield* endpoint.close;
          expect(port1.listenerCount("message")).toBe(0);
          expect(port1.listenerCount("close")).toBe(0);
          expect(port1.listenerCount("messageerror")).toBe(0);
          expect(replies).toBe(0);
          sqlite.close();
          sqlite = new DatabaseSync(file);

          const rpc = makeOwnerRpc<Operations>({
            permits: () => true,
            ledger: ledger(),
            handlers: {
              tool: {
                sideEffect: true,
                execute: () =>
                  Promise.resolve().then(() => {
                    calls++;
                    return "bad";
                  }),
              },
            },
          });
          expect(yield* sdkCall(() => rpc(request()))).toEqual({ type: "pending", operationId: 1 });
          expect(yield* sdkCall(() => rpc(request(2)))).toMatchObject({ reason: "uncertain_run" });
          expect(calls).toBe(1);
        } finally {
          yield* Scope.close(scope, Exit.void);
          port2.close();
          sqlite.close();
        }
      }).pipe(withTestPlatform),
  );

  effectTest.effect(
    "sanitizes acquisition failure and removes partially registered listeners",
    () =>
      Effect.gen(function* () {
        const { port1, port2 } = yield* channels();
        const scope = yield* Scope.fork(yield* Effect.scope);
        port1.start = () => {
          throw new Error("private-start-secret");
        };
        const acquire = Effect.provide(
          serveOwnerRpcPortEffect<Operations>(port1, {
            permits: () => true,
            ledger: makeInMemoryOwnerRpcLedger(),
            handlers: { tool: { sideEffect: true, execute: () => Effect.succeed("done") } },
          }),
          Context.make(Scope.Scope, scope),
        );
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* Scope.close(scope, Exit.void);
            port2.close();
          }),
        );

        const error = yield* acquire.pipe(Effect.flip);
        expect(error).toMatchObject({
          reason: "protocol",
          message: "Owner RPC transport protocol; dispatched effects may be uncertain",
        });
        expect(
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(error),
        ).not.toContain("private-start-secret");
        expect(port1.listenerCount("message")).toBe(0);
        expect(port1.listenerCount("close")).toBe(0);
        expect(port1.listenerCount("messageerror")).toBe(0);
      }),
  );

  effectTest.live("close before delivery never reserves or dispatches", () =>
    Effect.gen(function* () {
      const { port1, port2 } = yield* channels();
      let reservations = 0;
      let calls = 0;
      const base = makeInMemoryOwnerRpcLedger();
      const owner = serveOwnerRpcPort<Operations>(port1, {
        permits: () => true,
        ledger: {
          ...base,
          reserve: (...args) => {
            reservations++;
            return base.reserve(...args);
          },
        },
        handlers: {
          tool: {
            sideEffect: true,
            execute: () =>
              Promise.resolve().then(() => {
                calls++;
                return "done";
              }),
          },
        },
      });
      const closed = yield* Effect.forkChild(portEvent(port2, "close"), { startImmediately: true });
      port2.postMessage({ type: "request", requestId: 1, request: request() });
      owner.close();
      yield* Fiber.join(closed);
      expect(reservations).toBe(0);
      expect(calls).toBe(0);
      expect(port1.listenerCount("message")).toBe(0);
    }).pipe(withTestPlatform),
  );

  effectTest.live(
    "sanitizes infrastructure errors and closes without sending raw capabilities",
    () =>
      Effect.gen(function* () {
        const { port1, port2 } = yield* channels();
        let messages = 0;
        port2.on("message", () => {
          messages++;
        });
        const owner = serveOwnerRpcPort<Operations>(port1, {
          permits: () => {
            throw new Error("private-secret-token");
          },
          ledger: makeInMemoryOwnerRpcLedger(),
          handlers: { tool: { sideEffect: true, execute: () => Promise.resolve("done") } },
        });
        const client = makeOwnerRpcPortClient<Operations>(port2);
        try {
          yield* sdkCall(() =>
            expect(client.request(request())).rejects.toMatchObject({
              reason: "closed",
              message: "Owner RPC transport closed; dispatched effects may be uncertain",
            }),
          );
          expect(messages).toBe(0);
          expect(port1.listenerCount("message")).toBe(0);
        } finally {
          client.close();
          owner.close();
        }
      }).pipe(withTestPlatform),
  );
  effectTest.live("invokes once and replays duplicates through owner ledger", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      try {
        expect(yield* sdkCall(() => f.client.request(request()))).toEqual({
          type: "succeeded",
          operationId: 1,
          output: "done",
        });
        expect(yield* sdkCall(() => f.client.request(request()))).toEqual({
          type: "succeeded",
          operationId: 1,
          output: "done",
        });
        expect(f.calls()).toBe(1);
      } finally {
        f.close();
      }
    }).pipe(withTestPlatform),
  );
  effectTest.live("preserves uncertain effects and never retries", () =>
    Effect.gen(function* () {
      const f = yield* fixture(() =>
        Promise.resolve().then(() => {
          throw new Error("effect may have happened");
        }),
      );
      try {
        expect(yield* sdkCall(() => f.client.request(request()))).toEqual({
          type: "uncertain",
          operationId: 1,
        });
        expect(yield* sdkCall(() => f.client.request(request()))).toEqual({
          type: "uncertain",
          operationId: 1,
        });
        expect(yield* sdkCall(() => f.client.request(request(2)))).toEqual({
          type: "rejected",
          operationId: 2,
          reason: "uncertain_run",
        });
        expect(f.calls()).toBe(1);
      } finally {
        f.close();
      }
    }).pipe(withTestPlatform),
  );
  effectTest.live(
    "rejects pending calls on remote closure without retrying dispatched effect",
    () =>
      Effect.gen(function* () {
        const ready = yield* Deferred.make<void>();
        const reply = yield* Deferred.make<string>();
        const runNative = Effect.runPromiseWith(yield* Effect.context());
        const started = () => Deferred.doneUnsafe(ready, Effect.void);
        const finish = (value: string) => Deferred.doneUnsafe(reply, Effect.succeed(value));
        const f = yield* fixture(() => {
          started();
          return runNative(Deferred.await(reply));
        });
        yield* Effect.addFinalizer(() => Deferred.succeed(reply, "fixture cleanup"));
        const result = f.client.request(request());
        const rejected = expect(result).rejects.toMatchObject({ reason: "closed" });
        yield* Deferred.await(ready);
        f.owner.close();
        yield* sdkCall(() => rejected);
        finish("done");
        expect(f.calls()).toBe(1);
        f.close();
      }).pipe(withTestPlatform),
  );
  effectTest.live("cancellation rejects locally but allows late settlement without replay", () => {
    const controller = new AbortController();
    return Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();
      const reply = yield* Deferred.make<string>();
      const runNative = Effect.runPromiseWith(yield* Effect.context());
      const started = () => Deferred.doneUnsafe(ready, Effect.void);
      const finish = (value: string) => Deferred.doneUnsafe(reply, Effect.succeed(value));
      const f = yield* fixture(() => {
        started();
        return runNative(Deferred.await(reply));
      });
      yield* Effect.addFinalizer(() => Deferred.succeed(reply, "fixture cleanup"));
      try {
        const mutableRequest = { ...request() };
        const result = f.client.request(mutableRequest, controller.signal);
        // Caller mutation must not change the correlation of the already sent frame.
        mutableRequest.operationId = 999;
        mutableRequest.capability = { ...mutableRequest.capability, token: "changed" };
        const rejected = expect(result).rejects.toMatchObject({ reason: "cancelled" });
        yield* Deferred.await(ready);
        controller.abort();
        yield* sdkCall(() => rejected);
        finish("done");
        // FIFO delivery on a real port ensures the late cancelled reply is consumed first.
        expect(yield* sdkCall(() => f.client.request(request()))).toEqual({
          type: "succeeded",
          operationId: 1,
          output: "done",
        });
        expect(f.calls()).toBe(1);
      } finally {
        f.close();
      }
    }).pipe(withTestPlatform);
  });
  effectTest.live.each([
    null,
    { type: "request", requestId: 1, request: { ...request(), input: undefined } },
    { type: "request", requestId: 1, request: { ...request(), operationId: NaN } },
  ])("fails closed on malformed requests", (raw) =>
    Effect.gen(function* () {
      const { port1, port2 } = yield* channels();
      let calls = 0;
      const owner = serveOwnerRpcPort<Operations>(port1, {
        permits: () => true,
        ledger: makeInMemoryOwnerRpcLedger(),
        handlers: {
          tool: {
            sideEffect: true,
            execute: () =>
              Promise.resolve().then(() => {
                calls++;
                return "done";
              }),
          },
        },
      });
      const closed = yield* Effect.forkChild(portEvent(port2, "close"), { startImmediately: true });
      port2.postMessage(raw);
      yield* Fiber.join(closed);
      expect(calls).toBe(0);
      owner.close();
    }),
  );
  effectTest.live.each([
    null,
    { type: "reply", requestId: 999, reply: { type: "succeeded", operationId: 1, output: "done" } },
    { type: "reply", requestId: 1, reply: { type: "succeeded", operationId: 2, output: "done" } },
    {
      type: "reply",
      requestId: 1,
      reply: { type: "succeeded", operationId: 1, output: undefined },
    },
  ])("rejects malformed or mismatched replies", (raw) =>
    Effect.gen(function* () {
      const { port1, port2 } = yield* channels();
      const client = makeOwnerRpcPortClient<Operations>(port2);
      const result = client.request(request());
      const rejected = expect(result).rejects.toMatchObject({ reason: "protocol" });
      port1.postMessage(raw);
      yield* sdkCall(() => rejected);
      client.close();
      port1.close();
    }),
  );
});

effectTest.live.each(["1", "__proto__"])(
  "owner transport rejects non-numeric reply ID %s",
  (requestId) =>
    Effect.gen(function* () {
      const { port1, port2 } = yield* channels();
      const client = makeOwnerRpcPortClient<Operations>(port1);
      try {
        const received = yield* Effect.forkChild(portEvent(port2, "message"), {
          startImmediately: true,
        });
        const pending = client.request(request());
        const rejected = expect(pending).rejects.toMatchObject({ reason: "protocol" });
        yield* Fiber.join(received);
        port2.postMessage({
          type: "reply",
          requestId,
          reply: { type: "succeeded", operationId: 1, output: "unexpected" },
        });
        yield* sdkCall(() => rejected);
      } finally {
        client.close();
        port2.close();
      }
    }),
);
