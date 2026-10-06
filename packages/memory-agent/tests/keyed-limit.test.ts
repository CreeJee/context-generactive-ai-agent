// Test/benchmark SDK boundary uses native Promise callbacks, I/O fixtures and synchronous codec assertions.
// @effect-diagnostics asyncFunction:off
import { MutableHashMap, Option, Deferred, Effect, Fiber } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { keyedSerialLimit } from "../src/concurrency/keyed-limit.ts";

describe("keyedSerialLimit", () => {
  test("serializes equal keys while allowing different keys to overlap", async () => {
    const active = MutableHashMap.empty<string, number>();
    const peak = MutableHashMap.empty<string, number>();
    let globallyActive = 0;
    let globalPeak = 0;

    const program = Effect.gen(function* () {
      const limit = yield* keyedSerialLimit();
      const work = (key: string) =>
        limit(
          key,
          Effect.gen(function* () {
            yield* Effect.sync(() => {
              const count = (Option.getOrUndefined(MutableHashMap.get(active, key)) ?? 0) + 1;
              MutableHashMap.set(active, key, count);
              MutableHashMap.set(
                peak,
                key,
                Math.max(Option.getOrUndefined(MutableHashMap.get(peak, key)) ?? 0, count),
              );
              globallyActive += 1;
              globalPeak = Math.max(globalPeak, globallyActive);
            });
            yield* Effect.sleep("10 millis");
            yield* Effect.sync(() => {
              MutableHashMap.set(
                active,
                key,
                Option.getOrUndefined(MutableHashMap.get(active, key))! - 1,
              );
              globallyActive -= 1;
            });
          }),
        );

      yield* Effect.all([work("a"), work("a"), work("b"), work("b")], { concurrency: "unbounded" });
    });
    await Effect.runPromise(Effect.scoped(program));

    expect(Option.getOrUndefined(MutableHashMap.get(peak, "a"))).toBe(1);
    expect(Option.getOrUndefined(MutableHashMap.get(peak, "b"))).toBe(1);
    expect(globalPeak).toBeGreaterThan(1);
  });

  test("an interrupted holder releases its key for a waiting job", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const limit = yield* keyedSerialLimit();
          const started = yield* Deferred.make<void>();
          const first = yield* Effect.forkChild(
            limit(
              "agent",
              Effect.gen(function* () {
                yield* Deferred.succeed(started, undefined);
                return yield* Effect.never;
              }),
            ),
          );
          yield* Deferred.await(started);
          const second = yield* Effect.forkChild(limit("agent", Effect.succeed("continued")));
          yield* Fiber.interrupt(first);
          return yield* Fiber.join(second);
        }),
      ),
    );
    expect(result).toBe("continued");
  });
});
