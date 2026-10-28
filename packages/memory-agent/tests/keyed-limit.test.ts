import { it } from "@effect/vitest";
import { MutableHashMap, MutableRef, Option, Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect } from "vite-plus/test";
import { keyedSerialLimit } from "../src/concurrency/keyed-limit.ts";

describe("keyedSerialLimit", () => {
  it.effect("serializes equal keys while allowing different keys to overlap", () =>
    Effect.gen(function* () {
      const limit = yield* keyedSerialLimit();
      const active = MutableHashMap.empty<string, number>();
      const peak = MutableHashMap.empty<string, number>();
      const globallyActive = MutableRef.make(0);
      const globalPeak = MutableRef.make(0);
      const work = (key: string) =>
        limit(
          key,
          Effect.gen(function* () {
            const count = (Option.getOrUndefined(MutableHashMap.get(active, key)) ?? 0) + 1;
            MutableHashMap.set(active, key, count);
            MutableHashMap.set(
              peak,
              key,
              Math.max(Option.getOrUndefined(MutableHashMap.get(peak, key)) ?? 0, count),
            );
            const running = MutableRef.incrementAndGet(globallyActive);
            MutableRef.update(globalPeak, (current) => Math.max(current, running));
            yield* Effect.sleep("10 millis");
            MutableHashMap.set(active, key, Option.getOrThrow(MutableHashMap.get(active, key)) - 1);
            MutableRef.decrement(globallyActive);
          }),
        );
      const fiber = yield* Effect.forkChild(
        Effect.all([work("a"), work("a"), work("b"), work("b")], { concurrency: 4 }),
      );
      yield* TestClock.adjust("20 millis");
      yield* Fiber.join(fiber);
      expect(Option.getOrThrow(MutableHashMap.get(peak, "a"))).toBe(1);
      expect(Option.getOrThrow(MutableHashMap.get(peak, "b"))).toBe(1);
      expect(MutableRef.get(globalPeak)).toBeGreaterThan(1);
    }),
  );

  it.effect("an interrupted holder releases its key for a waiting job", () =>
    Effect.gen(function* () {
      const limit = yield* keyedSerialLimit();
      const started = yield* Deferred.make<void>();
      const first = yield* Effect.forkChild(
        limit("agent", Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))),
      );
      yield* Deferred.await(started);
      const second = yield* Effect.forkChild(limit("agent", Effect.succeed("continued")));
      yield* Fiber.interrupt(first);
      expect(yield* Fiber.join(second)).toBe("continued");
    }),
  );
});
