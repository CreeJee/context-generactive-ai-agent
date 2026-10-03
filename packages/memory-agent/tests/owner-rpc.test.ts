import { Cause, Context, Deferred, Effect, Exit, Fiber } from "effect";
import { describe, expect, it } from "vite-plus/test";
import {
  makeInMemoryOwnerRpcLedger,
  makeOwnerRpc,
  makeOwnerRpcEffect,
  OwnerRpcFailure,
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
function fixture(execute = async (input: { value: string }) => input) {
  let current = { ...capability };
  let calls = 0;
  const ledger = makeInMemoryOwnerRpcLedger();
  const rpc = makeOwnerRpc<Operations>({
    ledger,
    permits: (claim) =>
      claim.sessionId === current.sessionId &&
      claim.runId === current.runId &&
      claim.goalInstanceId === current.goalInstanceId &&
      claim.goalVersion === current.goalVersion &&
      claim.planVersion === current.planVersion &&
      claim.workflowRevisionId === current.workflowRevisionId &&
      claim.generation === current.generation &&
      claim.token === current.token,
    handlers: {
      tool: {
        sideEffect: true,
        execute: async (input) => {
          calls++;
          return execute(input);
        },
      },
      middleware: { sideEffect: false, execute: async () => "context" },
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
  "test/OwnerValue",
) {}

describe("Effect-native owner RPC", () => {
  it("is lazy and cancellation before admission creates no reservation or handler call", async () => {
    let reservations = 0;
    let calls = 0;
    const inner = makeInMemoryOwnerRpcLedger();
    const rpc = makeOwnerRpcEffect<Operations>({
      permits: () => true,
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
    await Effect.runPromise(
      Effect.gen(function* () {
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
      }),
    );
    expect(reservations).toBe(0);
    expect(calls).toBe(0);
    expect(await Effect.runPromise(rpc(nativeRequest))).toMatchObject({ type: "succeeded" });
    expect(reservations).toBe(1);
    expect(calls).toBe(1);
  });

  it("interruption after admission retains pending uncertainty without settlement or replay execution", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        let calls = 0;
        let settlements = 0;
        let finalized = 0;
        const inner = makeInMemoryOwnerRpcLedger();
        const rpc = makeOwnerRpcEffect<Operations>({
          permits: () => true,
          ledger: {
            reserve: (...args) => inner.reserve(...args),
            settle: (...args) => {
              settlements++;
              inner.settle(...args);
            },
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
  });

  it("keeps real settlement when the late authority check fails, without redispatch", async () => {
    const inner = makeInMemoryOwnerRpcLedger();
    const keys: string[] = [];
    let calls = 0;
    let settlements = 0;
    const defect = new Error("owner authority lookup unavailable");
    const rpc = makeOwnerRpcEffect<Operations>({
      permits: () => {
        if (calls > 0) throw defect;
        return true;
      },
      ledger: {
        reserve: (...args) => {
          keys.push(args[0]);
          return inner.reserve(...args);
        },
        settle: (...args) => {
          settlements++;
          inner.settle(...args);
        },
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
      const failure = await Effect.runPromise(
        rpc(nativeRequest).pipe(
          Effect.catchTag("OwnerRpcFailure", (error) => Effect.succeed(error)),
        ),
      );
      expect(failure).toMatchObject({ _tag: "OwnerRpcFailure", phase: "authority", cause: defect });
    }
    expect(keys).toHaveLength(1);
    expect(calls).toBe(1);
    expect(settlements).toBe(1);
    expect(inner.reserve(keys[0]!, 1, "not reused for dispatch", true)).toMatchObject({
      type: "existing",
      record: { reply: { type: "succeeded", operationId: 1, output: { value: "hello" } } },
    });
  });

  it("exposes typed reserve and settle failures without manufacturing a completed reply", async () => {
    for (const phase of ["reserve", "settle"] as const) {
      const inner = makeInMemoryOwnerRpcLedger();
      let calls = 0;
      const defect = new Error(`ledger ${phase} unavailable`);
      const rpc = makeOwnerRpcEffect<Operations>({
        permits: () => true,
        ledger: {
          reserve: (...args) => {
            if (phase === "reserve") throw defect;
            return inner.reserve(...args);
          },
          settle: () => {
            throw defect;
          },
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
      const failure = await Effect.runPromise(
        rpc(nativeRequest).pipe(
          Effect.catchTag("OwnerRpcFailure", (error) => Effect.succeed(error)),
        ),
      );
      expect(failure).toBeInstanceOf(OwnerRpcFailure);
      expect(failure).toMatchObject({ phase, cause: defect });
      expect(calls).toBe(phase === "reserve" ? 0 : 1);
      if (phase === "settle") {
        expect(await Effect.runPromise(rpc(nativeRequest))).toEqual({
          type: "pending",
          operationId: 1,
        });
        expect(await Effect.runPromise(rpc({ ...nativeRequest, operationId: 2 }))).toMatchObject({
          reason: "uncertain_run",
        });
        expect(calls).toBe(1);
      }
    }
  });

  it("composes handler context, freezes detached inputs and sanitizes output before settlement", async () => {
    const rpc = makeOwnerRpcEffect<Operations, never, OwnerValue>({
      permits: () => true,
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
      await Effect.runPromise(
        rpc(nativeRequest).pipe(Effect.provideService(OwnerValue, { value: "owner context" })),
      ),
    ).toMatchObject({ type: "succeeded", output: { value: "owner context" } });
    expect(nativeRequest.input).toEqual({ value: "hello" });
    expect(capability.token).toBe("owner-secret");
    const invalid = makeOwnerRpcEffect<Operations>({
      permits: () => true,
      ledger: makeInMemoryOwnerRpcLedger(),
      handlers: {
        tool: {
          sideEffect: true,
          execute: () => Effect.succeed({ value: "invalid", extra: Infinity }),
        },
        middleware: { sideEffect: false, execute: () => Effect.succeed("context") },
      },
    });
    expect(await Effect.runPromise(invalid(nativeRequest))).toEqual({
      type: "uncertain",
      operationId: 1,
    });
    expect(await Effect.runPromise(invalid({ ...nativeRequest, operationId: 2 }))).toMatchObject({
      reason: "uncertain_run",
    });
  });
});

describe("owner RPC protocol foundation", () => {
  it("checks pure handler authorization before reserve, including false/throw without a fence", async () => {
    const inner = makeInMemoryOwnerRpcLedger();
    let reservations = 0;
    let executions = 0;
    let active = true;
    let authorizations = 0;
    const rpc = makeOwnerRpc<Operations>({
      permits: () => active,
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
          execute: async (input) => {
            executions++;
            return input;
          },
        },
        middleware: { sideEffect: false, execute: async () => "context" },
      },
    });
    const request = {
      type: "owner-rpc-request" as const,
      capability,
      operationId: 1,
      operation: "tool" as const,
      input: { value: "unsafe" },
    };
    expect(await rpc(request)).toMatchObject({ reason: "invalid_operation" });
    expect(await rpc({ ...request, input: { value: "throw" } })).toMatchObject({
      reason: "invalid_operation",
    });
    expect(reservations).toBe(0);
    expect(executions).toBe(0);
    expect(await rpc({ ...request, input: { value: "safe" } })).toMatchObject({
      type: "succeeded",
      output: { value: "safe" },
    });
    expect(await rpc({ ...request, input: { value: "safe" } })).toMatchObject({
      type: "succeeded",
      output: { value: "safe" },
    });
    expect(executions).toBe(1);
    active = false;
    const before = authorizations;
    expect(await rpc({ ...request, operationId: 2, input: { value: "safe" } })).toMatchObject({
      reason: "unauthorized",
    });
    expect(authorizations).toBe(before);
    expect(reservations).toBe(2);
  });

  it("a handler predicate never widens revoked finalization or run authority", async () => {
    let predicateCalls = 0;
    const rpc = makeOwnerRpc<Operations>({
      permits: () => false,
      permitsFinalization: () => false,
      ledger: makeInMemoryOwnerRpcLedger(),
      handlers: {
        tool: {
          sideEffect: true,
          finalization: () => true,
          authorize: () => {
            predicateCalls++;
            return true;
          },
          execute: async (input) => input,
        },
        middleware: { sideEffect: false, execute: async () => "context" },
      },
    });
    expect(
      await rpc({
        type: "owner-rpc-request",
        capability,
        operationId: 1,
        operation: "tool",
        input: { value: "safe" },
      }),
    ).toMatchObject({ reason: "unauthorized" });
    expect(predicateCalls).toBe(0);
  });

  it("terminal cleanup excludes tools, arbitrary hooks, replay and revoked authority", async () => {
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
      permits: () => active && issued,
      permitsFinalization: () => issued,
      handlers: {
        tool: {
          sideEffect: true,
          execute: async () => {
            tools++;
            return null;
          },
        },
        middleware: {
          sideEffect: true,
          finalization: (input) => input.hook === "onFinish",
          execute: async () => {
            active = false;
            recorded++;
            return null;
          },
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
    expect(await rpc(request)).toMatchObject({ type: "succeeded" });
    expect(await rpc(request)).toMatchObject({ reason: "unauthorized" });
    expect(await rpc({ ...request, operationId: 2, operation: "tool", input: null })).toMatchObject(
      { reason: "unauthorized" },
    );
    expect(
      await rpc({ ...request, operationId: 2, input: { hook: "onBeforeToolCall" } }),
    ).toMatchObject({ reason: "unauthorized" });
    expect(await rpc({ ...request, operationId: 2 })).toMatchObject({ type: "succeeded" });
    issued = false;
    expect(await rpc({ ...request, operationId: 3 })).toMatchObject({ reason: "unauthorized" });
    expect(tools).toBe(0);
    expect(recorded).toBe(2);
  });

  it("fences every binding field and token before dispatch", async () => {
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
        await f.rpc({ ...request, capability: { ...request.capability, ...patch } }),
      ).toMatchObject({ type: "rejected", reason: "unauthorized" });
    }
    expect(f.calls()).toBe(0);
  });

  it("returns immutable-by-copy idempotent replies and rejects ID reuse with different input", async () => {
    const f = fixture();
    const first = await f.rpc(f.request());
    expect(first).toEqual({ type: "succeeded", operationId: 1, output: { value: "hello" } });
    if (first.type === "succeeded") Object.assign(first.output!, { value: "mutated" });
    expect(await f.rpc(f.request())).toMatchObject({ output: { value: "hello" } });
    const request = f.request();
    expect(await f.rpc({ ...request, input: { value: "changed" } })).toMatchObject({
      type: "rejected",
      reason: "operation_conflict",
    });
    expect(f.calls()).toBe(1);
  });

  it("rejects nonmonotonic new operations, invalid IDs and unknown operations", async () => {
    const f = fixture();
    await f.rpc(f.request(3));
    expect(await f.rpc(f.request(2))).toMatchObject({ reason: "non_monotonic" });
    for (const id of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])
      expect(await f.rpc(f.request(id))).toMatchObject({ reason: "invalid_operation" });
    // Deliberately corrupt a typed request to exercise the transport runtime guard.
    const malformed = f.request(4);
    Object.assign(malformed, { operation: "toString" });
    expect(await f.rpc(malformed)).toMatchObject({ reason: "invalid_operation" });
    expect(f.calls()).toBe(1);
  });

  it("reserves before dispatch and never executes concurrent duplicate operations", async () => {
    let release!: (value: { value: string }) => void;
    const f = fixture(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const first = f.rpc(f.request());
    expect(await f.rpc(f.request())).toEqual({ type: "pending", operationId: 1 });
    expect(await f.rpc(f.request(2))).toMatchObject({ reason: "uncertain_run" });
    release({ value: "done" });
    expect(await first).toMatchObject({ type: "succeeded" });
    expect(await f.rpc(f.request())).toMatchObject({ output: { value: "done" } });
    expect(f.calls()).toBe(1);
  });

  it("fences uncertain effects across new IDs and generation changes, allowing read middleware", async () => {
    const f = fixture(async () => {
      throw new Error("effect happened; reply lost");
    });
    expect(await f.rpc(f.request())).toEqual({ type: "uncertain", operationId: 1 });
    expect(await f.rpc(f.request())).toEqual({ type: "uncertain", operationId: 1 });
    const stale = f.request();
    f.rotate();
    expect(await f.rpc(stale)).toMatchObject({ reason: "unauthorized" });
    expect(await f.rpc(f.request())).toMatchObject({ type: "uncertain" });
    expect(await f.rpc(f.request(2))).toMatchObject({ reason: "uncertain_run" });
    expect(await f.rpc({ ...f.request(2), operation: "middleware", input: null })).toMatchObject({
      type: "succeeded",
      output: "context",
    });
    expect(f.calls()).toBe(1);
  });

  it("rejects late replies after revocation without redispatching completed effects", async () => {
    let release!: (value: { value: string }) => void;
    const f = fixture(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const stale = f.request();
    const result = f.rpc(stale);
    f.rotate();
    release({ value: "done" });
    expect(await result).toMatchObject({ reason: "unauthorized" });
    expect(await f.rpc(stale)).toMatchObject({ reason: "unauthorized" });
    expect(await f.rpc(f.request())).toMatchObject({
      type: "succeeded",
      output: { value: "done" },
    });
    expect(f.calls()).toBe(1);
  });
});
