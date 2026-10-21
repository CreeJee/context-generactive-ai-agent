import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Ref } from "effect";
import { TestClock } from "effect/testing";
import { KanbanStorageFailed, KanbanStorageReason } from "../kanban/card-attempts.ts";
import { DefectReporter } from "./defect-reporter.ts";
import { LoopHealth, LoopStep, superviseLoopStep } from "./loop-health.ts";

const storageFailed = KanbanStorageFailed.make({
  operation: "card",
  reason: KanbanStorageReason.cases.Missing.make({}),
});

const supervised = Effect.gen(function* () {
  const seen = yield* Ref.make<LoopHealth[]>([]);
  const runs = yield* Ref.make(0);
  const supervise = superviseLoopStep({
    message: "loop step failed",
    setHealth: (health) => Ref.update(seen, (all) => [...all, health]),
  });
  return { seen, runs, supervise };
});

describe("superviseLoopStep", () => {
  it.effect("retries an expected failure five times with backoff, then stops as exhausted", () =>
    Effect.gen(function* () {
      const { seen, runs, supervise } = yield* supervised;
      const fiber = yield* Effect.forkChild(
        supervise(
          Effect.andThen(
            Ref.update(runs, (n) => n + 1),
            Effect.fail(storageFailed),
          ),
        ),
      );
      // 10s, 20s, 40s, 80s, 160s: well under the 5 minute cap.
      yield* TestClock.adjust("9 seconds");
      expect(yield* Ref.get(runs)).toBe(1);
      yield* TestClock.adjust("301 seconds");
      expect(yield* Ref.get(runs)).toBe(6);
      const outcome = yield* Fiber.join(fiber);
      expect(yield* Ref.get(runs)).toBe(6);
      const exhausted = LoopHealth.cases.Exhausted.make({ error: "KanbanStorageFailed" });
      expect(outcome).toEqual(LoopStep.Stopped({ health: exhausted }));
      expect(yield* Ref.get(seen)).toEqual([
        ...[1, 2, 3, 4, 5].map((attempt) => LoopHealth.cases.Retrying.make({ attempt, of: 5 })),
        exhausted,
      ]);
    }),
  );

  it.effect("a success after retries makes the loop healthy again", () =>
    Effect.gen(function* () {
      const { seen, runs, supervise } = yield* supervised;
      const fiber = yield* Effect.forkChild(
        supervise(
          Ref.updateAndGet(runs, (n) => n + 1).pipe(
            Effect.filterOrFail(
              (n) => n >= 3,
              () => storageFailed,
            ),
          ),
        ),
      );
      yield* TestClock.adjust("1 minute");
      expect(yield* Fiber.join(fiber)).toEqual(LoopStep.Continued({ value: 3 }));
      expect((yield* Ref.get(seen)).at(-1)).toEqual(LoopHealth.cases.Healthy.make({}));
    }),
  );

  it.effect("stops on a defect at once, without retrying, and reports it", () =>
    Effect.gen(function* () {
      const { seen, runs, supervise } = yield* supervised;
      const reported = yield* Ref.make<string[]>([]);
      const outcome = yield* supervise(
        Effect.andThen(
          Ref.update(runs, (n) => n + 1),
          Effect.die("bug"),
        ),
      ).pipe(
        Effect.provideService(DefectReporter, {
          report: (event) => Ref.update(reported, (all) => [...all, event.message]),
          recent: Effect.succeed([]),
        }),
      );
      const defected = LoopHealth.cases.Defected.make({});
      expect(outcome).toEqual(LoopStep.Stopped({ health: defected }));
      expect(yield* Ref.get(runs)).toBe(1);
      expect(yield* Ref.get(seen)).toEqual([defected]);
      expect(yield* Ref.get(reported)).toEqual(["loop step failed"]);
    }),
  );
});
