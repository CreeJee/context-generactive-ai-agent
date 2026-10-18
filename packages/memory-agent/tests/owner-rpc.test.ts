import { it as effectTest } from "@effect/vitest";
import { Cause, Context, Deferred, Effect, Exit, Fiber } from "effect";
import { describe, expect } from "vite-plus/test";
import {
  makeInMemoryOwnerRpcLedger,
  makeOwnerRpc,
  makeOwnerRpcEffect,
  OwnerAuthorityError,
  OwnerRpcFailure,
  OwnerRpcLedgerError,
  type OwnerRpcCapability,
  type OwnerRpcRequest,
} from "../src/agent/owner-rpc.ts";

type Operations = {
  tool: { input: { value: string }; output: { value: string } };
  middleware: { input: null; output: string };
};
const capability: OwnerRpcCapability = {
  sessionId: "session",
  goalInstanceId: "goal",
  goalVersion: 1,
  planVersion: 2,
  workflowRevisionId: 3,
  runId: "run",
  generation: "generation-1",
  token: "owner-secret",
};
/** Promise return type is required by the legacy SDK handler contract. */
const legacyHandler = <A>(work: () => A): Promise<Awaited<A>> =>
  Promise.resolve().then(() => Promise.resolve(work()));
const legacyResult = <A>(result: Deferred.Deferred<A>): Promise<A> =>
  Effect.runPromise(Deferred.await(result));

function fixture(execute = (input: { value: string }) => legacyHandler(() => input)) {
  let current = { ...capability };
  let calls = 0;
  const ledger = makeInMemoryOwnerRpcLedger();
  const rpc = makeOwnerRpc<Operations>({
    ledger,
    permits: (claim) =>
      Effect.sync(
        () =>
          claim.sessionId === current.sessionId &&
          claim.runId === current.runId &&
          claim.goalInstanceId === current.goalInstanceId &&
          claim.goalVersion === current.goalVersion &&
          claim.planVersion === current.planVersion &&
          claim.workflowRevisionId === current.workflowRevisionId &&
          claim.generation === current.generation &&
          claim.token === current.token,
      ),
    handlers: {
      tool: {
        sideEffect: true,
        execute: (input) =>
          legacyHandler(() => {
            calls++;
            return execute(input);
          }),
      },
      middleware: { sideEffect: false, execute: () => legacyHandler(() => "context") },
    },
  });
  const request = (
    operationId = 1,
  ): Extract<OwnerRpcRequest<Operations>, { operation: "tool" }> => ({
    type: "owner-rpc-request",
    capability: { ...current },
    operationId,
    operation: "tool",
    input: { value: "hello" },
  });
  return {
    rpc,
    request,
    calls: () => calls,
    rotate: () => {
      current = { ...current, generation: "generation-2", token: "new-secret" };
    },
  };
}

const nativeRequest: OwnerRpcRequest<Operations> = {
  type: "owner-rpc-request",
  capability,
  operationId: 1,
  operation: "tool",
  input: { value: "hello" },
};

class OwnerValue extends Context.Service<OwnerValue, { readonly value: string }>()(
  "memory-agent/tests/owner-rpc.test/OwnerValue",
) {}

describe("Effect-native owner RPC", () => {
  effectTest.effect(
    "is lazy and cancellation before admission creates no reservation or handler call",
    () =>
      Effect.gen(function* () {
        let reservations = 0;
        let calls = 0;
        const inner = makeInMemoryOwnerRpcLedger();
        const rpc = makeOwnerRpcEffect<Operations>({
          permits: () => Effect.succeed(true),
          ledger: {
            reserve: (...args) => {
              reservations++;
              return inner.reserve(...args);
            },
            settle: (...args) => inner.settle(...args),
          },
          handlers: {
            tool: {
              sideEffect: true,
              execute: (input) =>
                Effect.sync(() => {
                  calls++;
                  return input;
                }),
            },
            middleware: { sideEffect: false, execute: () => Effect.succeed("context") },
          },
        });
        const execution = rpc(nativeRequest);
        expect(reservations).toBe(0);
        // Cancel the composing caller while it is waiting to submit to the owner.
        // Use native Fiber interruption, not an already-aborted host signal: the
        // installed runtime can finish a synchronous effect before observing that signal.
        {
          const ready = yield* Deferred.make<void>();
          const admission = yield* Deferred.make<void>();
          const fiber = yield* Effect.forkChild(
            Deferred.succeed(ready, undefined).pipe(
              Effect.andThen(Deferred.await(admission)),
              Effect.andThen(execution),
            ),
          );
          yield* Deferred.await(ready);
          yield* Fiber.interrupt(fiber);
          const exit = yield* Fiber.await(fiber);
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true);
        }
        expect(reservations).toBe(0);
        expect(calls).toBe(0);
        expect(yield* rpc(nativeRequest)).toMatchObject({ type: "succeeded" });
        expect(reservations).toBe(1);
        expect(calls).toBe(1);
      }),
  );

  effectTest.effect(
    "interruption after admission retains pending uncertainty without settlement or replay execution",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        let calls = 0;
        let settlements = 0;
        let finalized = 0;
        const inner = makeInMemoryOwnerRpcLedger();
        const rpc = makeOwnerRpcEffect<Operations>({
          permits: () => Effect.succeed(true),
          ledger: {
            reserve: (...args) => inner.reserve(...args),
            settle: (...args) =>
              Effect.suspend(() => {
                settlements++;
                return inner.settle(...args);
              }),
          },
          handlers: {
            tool: {
              sideEffect: true,
              execute: Effect.fnUntraced(
                function* () {
                  calls++;
                  yield* Deferred.succeed(entered, undefined);
                  return yield* Effect.never;
                },
                Effect.ensuring(
                  Effect.sync(() => {
                    finalized++;
                  }),
                ),
              ),
            },
            middleware: { sideEffect: false, execute: () => Effect.succeed("context") },
          },
        });
        const fiber = yield* Effect.forkChild(rpc(nativeRequest));
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(fiber);
        const exit = yield* Fiber.await(fiber);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true);
        expect(finalized).toBe(1);
        expect(settlements).toBe(0);
        expect(yield* rpc(nativeRequest)).toEqual({ type: "pending", operationId: 1 });
        expect(yield* rpc({ ...nativeRequest, operationId: 2 })).toMatchObject({
          reason: "uncertain_run",
        });
        expect(calls).toBe(1);
      }),
  );

  effectTest.effect(
    "keeps real settlement when the late authority check fails, without redispatch",
    () =>
      Effect.gen(function* () {
        const inner = makeInMemoryOwnerRpcLedger();
        const keys: string[] = [];
        let calls = 0;
        let settlements = 0;
        const defect = new Error("owner authority lookup unavailable");
        const rpc = makeOwnerRpcEffect<Operations>({
          permits: () =>
            calls > 0
              ? Effect.fail(OwnerAuthorityError.make({ cause: defect }))
              : Effect.succeed(true),
          ledger: {
            reserve: (...args) => {
              keys.push(args[0]);
              return inner.reserve(...args);
            },
            settle: (...args) =>
              Effect.suspend(() => {
                settlements++;
                return inner.settle(...args);
              }),
          },
          handlers: {
            tool: {
              sideEffect: true,
              execute: (input) =>
                Effect.sync(() => {
                  calls++;
                  return input;
                }),
            },
            middleware: { sideEffect: false, execute: () => Effect.succeed("context") },
          },
        });
        for (let attempt = 0; attempt < 2; attempt++) {
          const failure = yield* rpc(nativeRequest).pipe(
            Effect.catchTag("OwnerRpcFailure", (error) => Effect.succeed(error)),
          );
          expect(failure).toMatchObject({
            _tag: "OwnerRpcFailure",
            phase: "authority",
            cause: expect.objectContaining({ _tag: "OwnerAuthorityError", cause: defect }),
          });
        }
        expect(keys).toHaveLength(1);
        expect(calls).toBe(1);
        expect(settlements).toBe(1);
        expect(yield* inner.reserve(keys[0]!, 1, "not reused for dispatch", true)).toMatchObject({
          type: "existing",
          record: { reply: { type: "succeeded", operationId: 1, output: { value: "hello" } } },
        });
      }),
  );

  effectTest.effect(
    "exposes typed reserve and settle failures without manufacturing a completed reply",
    () =>
      Effect.gen(function* () {
        for (const phase of ["reserve", "settle"] as const) {
          const inner = makeInMemoryOwnerRpcLedger();
          let calls = 0;
          const defect = new Error(`ledger ${phase} unavailable`);
          const rpc = makeOwnerRpcEffect<Operations>({
            permits: () => Effect.succeed(true),
            ledger: {
              reserve: (...args) =>
                phase === "reserve"
                  ? Effect.fail(OwnerRpcLedgerError.make({ reason: "storage", cause: defect }))
                  : inner.reserve(...args),
              settle: () =>
                Effect.fail(OwnerRpcLedgerError.make({ reason: "storage", cause: defect })),
            },
            handlers: {
              tool: {
                sideEffect: true,
                execute: (input) =>
                  Effect.sync(() => {
                    calls++;
                    return input;
                  }),
              },
              middleware: { sideEffect: false, execute: () => Effect.succeed("context") },
            },
          });
          const failure = yield* rpc(nativeRequest).pipe(
            Effect.catchTag("OwnerRpcFailure", (error) => Effect.succeed(error)),
          );
          expect(failure).toBeInstanceOf(OwnerRpcFailure);
          expect(failure).toMatchObject({
            phase,
            cause: expect.objectContaining({ reason: "storage", cause: defect }),
          });
          expect(calls).toBe(phase === "reserve" ? 0 : 1);
          if (phase === "settle") {
            expect(yield* rpc(nativeRequest)).toEqual({
              type: "pending",
              operationId: 1,
            });
            expect(yield* rpc({ ...nativeRequest, operationId: 2 })).toMatchObject({
              reason: "uncertain_run",
            });
            expect(calls).toBe(1);
          }
        }
      }),
  );

  effectTest.effect(
    "composes handler context, freezes detached inputs and sanitizes output before settlement",
    () =>
      Effect.gen(function* () {
        const rpc = makeOwnerRpcEffect<Operations, never, OwnerValue>({
          permits: () => Effect.succeed(true),
          ledger: makeInMemoryOwnerRpcLedger(),
          handlers: {
            tool: {
              sideEffect: true,
              execute: Effect.fnUntraced(function* (input, claim) {
                expect(Object.isFrozen(input)).toBe(true);
                expect(Object.isFrozen(claim)).toBe(true);
                expect(() => Object.assign(input, { value: "changed" })).toThrow();
                expect(() => Object.assign(claim, { token: "changed" })).toThrow();
                const service = yield* OwnerValue;
                return { value: service.value };
              }),
            },
            middleware: { sideEffect: false, execute: () => Effect.succeed("context") },
          },
        });
        expect(
          yield* rpc(nativeRequest).pipe(
            Effect.provideService(OwnerValue, { value: "owner context" }),
          ),
        ).toMatchObject({ type: "succeeded", output: { value: "owner context" } });
        expect(nativeRequest.input).toEqual({ value: "hello" });
        expect(capability.token).toBe("owner-secret");
        const invalid = makeOwnerRpcEffect<Operations>({
          permits: () => Effect.succeed(true),
          ledger: makeInMemoryOwnerRpcLedger(),
          handlers: {
            tool: {
              sideEffect: true,
              execute: () => Effect.succeed({ value: "invalid", extra: Infinity }),
            },
            middleware: { sideEffect: false, execute: () => Effect.succeed("context") },
          },
        });
        expect(yield* invalid(nativeRequest)).toEqual({
          type: "uncertain",
          operationId: 1,
        });
        expect(yield* invalid({ ...nativeRequest, operationId: 2 })).toMatchObject({
          reason: "uncertain_run",
        });
      }),
  );
});

describe("owner RPC protocol foundation", () => {
  effectTest.effect(
    "checks pure handler authorization before reserve, including false/throw without a fence",
    () =>
      Effect.gen(function* () {
        const inner = makeInMemoryOwnerRpcLedger();
        let reservations = 0;
        let executions = 0;
        let active = true;
        let authorizations = 0;
        const rpc = makeOwnerRpc<Operations>({
          permits: () => Effect.sync(() => active),
          ledger: {
            reserve(...args) {
              reservations++;
              return inner.reserve(...args);
            },
            settle: (...args) => inner.settle(...args),
          },
          handlers: {
            tool: {
              sideEffect: true,
              authorize: (input, claim) => {
                authorizations++;
                expect(claim).toEqual(capability);
                if (input.value === "throw") throw new Error("malformed owner precondition");
                const valid = input.value === "safe";
                input.value = "predicate cannot alter execution";
                return valid;
              },
              execute: (input) =>
                legacyHandler(() => {
                  executions++;
                  return input;
                }),
            },
            middleware: { sideEffect: false, execute: () => legacyHandler(() => "context") },
          },
        });
        const request = {
          type: "owner-rpc-request" as const,
          capability,
          operationId: 1,
          operation: "tool" as const,
          input: { value: "unsafe" },
        };
        expect(yield* Effect.tryPromise(() => rpc(request))).toMatchObject({
          reason: "invalid_operation",
        });
        expect(
          yield* Effect.tryPromise(() => rpc({ ...request, input: { value: "throw" } })),
        ).toMatchObject({
          reason: "invalid_operation",
        });
        expect(reservations).toBe(0);
        expect(executions).toBe(0);
        expect(
          yield* Effect.tryPromise(() => rpc({ ...request, input: { value: "safe" } })),
        ).toMatchObject({
          type: "succeeded",
          output: { value: "safe" },
        });
        expect(
          yield* Effect.tryPromise(() => rpc({ ...request, input: { value: "safe" } })),
        ).toMatchObject({
          type: "succeeded",
          output: { value: "safe" },
        });
        expect(executions).toBe(1);
        active = false;
        const before = authorizations;
        expect(
          yield* Effect.tryPromise(() =>
            rpc({ ...request, operationId: 2, input: { value: "safe" } }),
          ),
        ).toMatchObject({
          reason: "unauthorized",
        });
        expect(authorizations).toBe(before);
        expect(reservations).toBe(2);
      }),
  );

  effectTest.effect("a handler predicate never widens revoked finalization or run authority", () =>
    Effect.gen(function* () {
      let predicateCalls = 0;
      const rpc = makeOwnerRpc<Operations>({
        permits: () => Effect.succeed(false),
        permitsFinalization: () => Effect.succeed(false),
        ledger: makeInMemoryOwnerRpcLedger(),
        handlers: {
          tool: {
            sideEffect: true,
            finalization: () => true,
            authorize: () => {
              predicateCalls++;
              return true;
            },
            execute: (input) => legacyHandler(() => input),
          },
          middleware: { sideEffect: false, execute: () => legacyHandler(() => "context") },
        },
      });
      expect(
        yield* Effect.tryPromise(() =>
          rpc({
            type: "owner-rpc-request",
            capability,
            operationId: 1,
            operation: "tool",
            input: { value: "safe" },
          }),
        ),
      ).toMatchObject({ reason: "unauthorized" });
      expect(predicateCalls).toBe(0);
    }),
  );

  effectTest.effect(
    "terminal cleanup excludes tools, arbitrary hooks, replay and revoked authority",
    () =>
      Effect.gen(function* () {
        type FinalOperations = {
          tool: { input: null; output: null };
          middleware: { input: { hook: string }; output: null };
        };
        let active = true;
        let issued = true;
        let tools = 0;
        let recorded = 0;
        const rpc = makeOwnerRpc<FinalOperations>({
          ledger: makeInMemoryOwnerRpcLedger(),
          permits: () => Effect.sync(() => active && issued),
          permitsFinalization: () => Effect.sync(() => issued),
          handlers: {
            tool: {
              sideEffect: true,
              execute: () =>
                legacyHandler(() => {
                  tools++;
                  return null;
                }),
            },
            middleware: {
              sideEffect: true,
              finalization: (input) => input.hook === "onFinish",
              execute: () =>
                legacyHandler(() => {
                  active = false;
                  recorded++;
                  return null;
                }),
            },
          },
        });
        const request = {
          type: "owner-rpc-request" as const,
          capability,
          operationId: 1,
          operation: "middleware" as const,
          input: { hook: "onFinish" },
        };
        expect(yield* Effect.tryPromise(() => rpc(request))).toMatchObject({ type: "succeeded" });
        expect(yield* Effect.tryPromise(() => rpc(request))).toMatchObject({
          reason: "unauthorized",
        });
        expect(
          yield* Effect.tryPromise(() =>
            rpc({ ...request, operationId: 2, operation: "tool", input: null }),
          ),
        ).toMatchObject({ reason: "unauthorized" });
        expect(
          yield* Effect.tryPromise(() =>
            rpc({ ...request, operationId: 2, input: { hook: "onBeforeToolCall" } }),
          ),
        ).toMatchObject({ reason: "unauthorized" });
        expect(yield* Effect.tryPromise(() => rpc({ ...request, operationId: 2 }))).toMatchObject({
          type: "succeeded",
        });
        issued = false;
        expect(yield* Effect.tryPromise(() => rpc({ ...request, operationId: 3 }))).toMatchObject({
          reason: "unauthorized",
        });
        expect(tools).toBe(0);
        expect(recorded).toBe(2);
      }),
  );

  effectTest.effect("fences every binding field and token before dispatch", () =>
    Effect.gen(function* () {
      const f = fixture();
      for (const patch of [
        { sessionId: "other" },
        { goalInstanceId: "other" },
        { goalVersion: 9 },
        { planVersion: null },
        { workflowRevisionId: 8 },
        { runId: "other" },
        { generation: "old" },
        { token: "forged" },
      ]) {
        const request = f.request();
        expect(
          yield* Effect.tryPromise(() =>
            f.rpc({ ...request, capability: { ...request.capability, ...patch } }),
          ),
        ).toMatchObject({ type: "rejected", reason: "unauthorized" });
      }
      expect(f.calls()).toBe(0);
    }),
  );

  effectTest.effect(
    "returns immutable-by-copy idempotent replies and rejects ID reuse with different input",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        const first = yield* Effect.tryPromise(() => f.rpc(f.request()));
        expect(first).toEqual({ type: "succeeded", operationId: 1, output: { value: "hello" } });
        if (first.type === "succeeded") Object.assign(first.output!, { value: "mutated" });
        expect(yield* Effect.tryPromise(() => f.rpc(f.request()))).toMatchObject({
          output: { value: "hello" },
        });
        const request = f.request();
        expect(
          yield* Effect.tryPromise(() => f.rpc({ ...request, input: { value: "changed" } })),
        ).toMatchObject({
          type: "rejected",
          reason: "operation_conflict",
        });
        expect(f.calls()).toBe(1);
      }),
  );

  effectTest.effect("rejects nonmonotonic new operations, invalid IDs and unknown operations", () =>
    Effect.gen(function* () {
      const f = fixture();
      yield* Effect.tryPromise(() => f.rpc(f.request(3)));
      expect(yield* Effect.tryPromise(() => f.rpc(f.request(2)))).toMatchObject({
        reason: "non_monotonic",
      });
      for (const id of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])
        expect(yield* Effect.tryPromise(() => f.rpc(f.request(id)))).toMatchObject({
          reason: "invalid_operation",
        });
      // Deliberately corrupt a typed request to exercise the transport runtime guard.
      const malformed = f.request(4);
      Object.assign(malformed, { operation: "toString" });
      expect(yield* Effect.tryPromise(() => f.rpc(malformed))).toMatchObject({
        reason: "invalid_operation",
      });
      expect(f.calls()).toBe(1);
    }),
  );

  effectTest.effect(
    "reserves before dispatch and never executes concurrent duplicate operations",
    () =>
      Effect.gen(function* () {
        const reply = yield* Deferred.make<{ value: string }>();
        yield* Effect.addFinalizer(() => Deferred.succeed(reply, { value: "done" }));
        const f = fixture(() => legacyResult(reply));
        const first = f.rpc(f.request());
        expect(yield* Effect.tryPromise(() => f.rpc(f.request()))).toEqual({
          type: "pending",
          operationId: 1,
        });
        expect(yield* Effect.tryPromise(() => f.rpc(f.request(2)))).toMatchObject({
          reason: "uncertain_run",
        });
        yield* Deferred.succeed(reply, { value: "done" });
        expect(yield* Effect.tryPromise(() => first)).toMatchObject({ type: "succeeded" });
        expect(yield* Effect.tryPromise(() => f.rpc(f.request()))).toMatchObject({
          output: { value: "done" },
        });
        expect(f.calls()).toBe(1);
      }),
  );

  effectTest.effect(
    "fences uncertain effects across new IDs and generation changes, allowing read middleware",
    () =>
      Effect.gen(function* () {
        const f = fixture(() =>
          legacyHandler(() => {
            throw new Error("effect happened; reply lost");
          }),
        );
        expect(yield* Effect.tryPromise(() => f.rpc(f.request()))).toEqual({
          type: "uncertain",
          operationId: 1,
        });
        expect(yield* Effect.tryPromise(() => f.rpc(f.request()))).toEqual({
          type: "uncertain",
          operationId: 1,
        });
        const stale = f.request();
        f.rotate();
        expect(yield* Effect.tryPromise(() => f.rpc(stale))).toMatchObject({
          reason: "unauthorized",
        });
        expect(yield* Effect.tryPromise(() => f.rpc(f.request()))).toMatchObject({
          type: "uncertain",
        });
        expect(yield* Effect.tryPromise(() => f.rpc(f.request(2)))).toMatchObject({
          reason: "uncertain_run",
        });
        expect(
          yield* Effect.tryPromise(() =>
            f.rpc({ ...f.request(2), operation: "middleware", input: null }),
          ),
        ).toMatchObject({
          type: "succeeded",
          output: "context",
        });
        expect(f.calls()).toBe(1);
      }),
  );

  effectTest.effect(
    "rejects late replies after revocation without redispatching completed effects",
    () =>
      Effect.gen(function* () {
        const reply = yield* Deferred.make<{ value: string }>();
        yield* Effect.addFinalizer(() => Deferred.succeed(reply, { value: "done" }));
        const f = fixture(() => legacyResult(reply));
        const stale = f.request();
        const result = f.rpc(stale);
        f.rotate();
        yield* Deferred.succeed(reply, { value: "done" });
        expect(yield* Effect.tryPromise(() => result)).toMatchObject({ reason: "unauthorized" });
        expect(yield* Effect.tryPromise(() => f.rpc(stale))).toMatchObject({
          reason: "unauthorized",
        });
        expect(yield* Effect.tryPromise(() => f.rpc(f.request()))).toMatchObject({
          type: "succeeded",
          output: { value: "done" },
        });
        expect(f.calls()).toBe(1);
      }),
  );
});
