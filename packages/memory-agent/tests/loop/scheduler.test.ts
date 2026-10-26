import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Ref } from "effect";
import { describe, expect } from "vite-plus/test";
import {
  type Admission,
  CallOutcome,
  Run,
  type StepCall,
  stepScheduler,
} from "../../src/loop/scheduler.ts";

/**
 * The scheduler's rules (docs/effect-ai-migration.md "도구 실행 방식"): a read starts when it is
 * admitted, a write after a complete finish without waiting for other calls, an incomplete
 * response's writes never run, and outcomes come back in call order. Types cannot check an order.
 */

const read = (id: string): StepCall => ({ id, name: "read_file", params: {} });
const write = (id: string): StepCall => ({ id, name: "write_file", params: {} });

/** Calls that each record their start and then wait for their own release. */
const harness = Effect.fnUntraced(function* (ids: ReadonlyArray<string>) {
  const started = yield* Ref.make<ReadonlyArray<string>>([]);
  const gates: Record<string, Deferred.Deferred<void>> = Object.fromEntries(
    yield* Effect.forEach(ids, (id) => Effect.map(Deferred.make<void>(), (gate) => [id, gate])),
  );
  const release = (id: string) => Deferred.succeed(gates[id], undefined);
  const admit = (call: StepCall): Effect.Effect<Admission<string>> =>
    Effect.succeed(
      Run(
        Ref.update(started, (all) => [...all, call.id]).pipe(
          Effect.andThen(Deferred.await(gates[call.id])),
          Effect.as(call.id),
        ),
      ),
    );
  const scheduler = yield* stepScheduler({ admit, answered: () => Effect.void });
  return { scheduler, started: Ref.get(started), release };
});

describe("step scheduler", () => {
  it.effect("starts a read when it is admitted, before the response finishes", () =>
    Effect.gen(function* () {
      const { scheduler, started, release } = yield* harness(["r1", "w1"]);
      yield* scheduler.offer(read("r1"));
      yield* scheduler.offer(write("w1"));
      yield* Effect.yieldNow;
      expect(yield* started).toEqual(["r1"]);
      yield* release("r1");
      yield* release("w1");
      yield* Effect.forkChild(scheduler.settle(true));
    }).pipe(Effect.scoped),
  );

  it.effect("starts every write after a complete finish without waiting for other calls", () =>
    Effect.gen(function* () {
      const { scheduler, started, release } = yield* harness(["r1", "w1", "w2"]);
      yield* scheduler.offer(read("r1"));
      yield* scheduler.offer(write("w1"));
      yield* scheduler.offer(write("w2"));
      const settled = yield* Effect.forkChild(scheduler.settle(true));
      yield* Effect.yieldNow;
      // r1 is still running and neither write waits for it or for the other.
      expect(yield* started).toEqual(["r1", "w1", "w2"]);
      yield* release("w2");
      yield* release("r1");
      yield* release("w1");
      expect(yield* Fiber.join(settled)).toEqual([
        CallOutcome.Returned({ result: "r1" }),
        CallOutcome.Returned({ result: "w1" }),
        CallOutcome.Returned({ result: "w2" }),
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("answers the writes of an incomplete response without running them", () =>
    Effect.gen(function* () {
      const { scheduler, started, release } = yield* harness(["r1", "w1"]);
      yield* scheduler.offer(read("r1"));
      yield* scheduler.offer(write("w1"));
      const settled = yield* Effect.forkChild(scheduler.settle(false));
      yield* Effect.yieldNow;
      // The running read is not cut; it still gives its result.
      yield* release("r1");
      const outcomes = yield* Fiber.join(settled);
      expect(yield* started).toEqual(["r1"]);
      expect(outcomes[0]).toEqual(CallOutcome.Returned({ result: "r1" }));
      expect(outcomes[1]).toMatchObject({
        _tag: "Failed",
        result: { error: "response_incomplete" },
      });
    }).pipe(Effect.scoped),
  );

  it.effect("runs the other calls while one waits for the user", () =>
    Effect.gen(function* () {
      const ran = yield* Ref.make(0);
      const scheduler = yield* stepScheduler<string, never, never>({
        admit: (call) =>
          Effect.succeed(
            call.id === "ask"
              ? CallOutcome.Waiting({ request: "approve?" })
              : Run(
                  Effect.as(
                    Ref.update(ran, (count) => count + 1),
                    "done",
                  ),
                ),
          ),
        answered: () => Effect.void,
      });
      yield* scheduler.offer(write("ask"));
      yield* scheduler.offer(write("w1"));
      yield* scheduler.offer(read("r1"));
      expect(yield* scheduler.settle(true)).toEqual([
        CallOutcome.Waiting({ request: "approve?" }),
        CallOutcome.Returned({ result: "done" }),
        CallOutcome.Returned({ result: "done" }),
      ]);
      expect(yield* Ref.get(ran)).toBe(2);
    }).pipe(Effect.scoped),
  );
});
