import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Ref } from "effect";
import { TestClock } from "effect/testing";
import { KanbanStorageFailed } from "../kanban/card-attempts.ts";
import { DefectReporter } from "./defect-reporter.ts";
import { superviseLoopStep, type LoopHealth } from "./loop-health.ts";

const storageFailed = KanbanStorageFailed.make({ operation: "card", reason: { _tag: "Missing" } });

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
      expect(outcome).toEqual({
        _tag: "Stopped",
        health: { _tag: "Exhausted", error: "KanbanStorageFailed" },
      });
      expect((yield* Ref.get(seen)).map((health) => health._tag)).toEqual([
        "Retrying",
        "Retrying",
        "Retrying",
        "Retrying",
        "Retrying",
        "Exhausted",
      ]);
      expect((yield* Ref.get(seen))[4]).toEqual({ _tag: "Retrying", attempt: 5, of: 5 });
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
      expect(yield* Fiber.join(fiber)).toEqual({ _tag: "Continued", value: 3 });
      expect((yield* Ref.get(seen)).at(-1)).toEqual({ _tag: "Healthy" });
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
        }),
      );
      expect(outcome).toEqual({ _tag: "Stopped", health: { _tag: "Defected" } });
      expect(yield* Ref.get(runs)).toBe(1);
      expect(yield* Ref.get(seen)).toEqual([{ _tag: "Defected" }]);
      expect(yield* Ref.get(reported)).toEqual(["loop step failed"]);
    }),
  );
});
