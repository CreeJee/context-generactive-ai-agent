import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { keyedSerialLimit } from "../src/concurrency/keyed-limit.ts";

describe("keyedSerialLimit", () => {
  test("serializes equal keys while allowing different keys to overlap", async () => {
    const limit = keyedSerialLimit();
    const active = new Map<string, number>();
    const peak = new Map<string, number>();
    let globallyActive = 0;
    let globalPeak = 0;

    const work = (key: string) =>
      limit(
        key,
        Effect.gen(function* () {
          yield* Effect.sync(() => {
            const count = (active.get(key) ?? 0) + 1;
            active.set(key, count);
            peak.set(key, Math.max(peak.get(key) ?? 0, count));
            globallyActive += 1;
            globalPeak = Math.max(globalPeak, globallyActive);
          });
          yield* Effect.sleep("10 millis");
          yield* Effect.sync(() => {
            active.set(key, active.get(key)! - 1);
            globallyActive -= 1;
          });
        }),
      );

    await Effect.runPromise(
      Effect.all([work("a"), work("a"), work("b"), work("b")], {
        concurrency: "unbounded",
      }),
    );

    expect(peak.get("a")).toBe(1);
    expect(peak.get("b")).toBe(1);
    expect(globalPeak).toBeGreaterThan(1);
  });

  test("an interrupted holder releases its key for a waiting job", async () => {
    const limit = keyedSerialLimit();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const first = yield* Effect.fork(
          limit(
            "agent",
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              yield* Effect.never;
            }),
          ),
        );
        yield* Deferred.await(started);
        const second = yield* Effect.fork(limit("agent", Effect.succeed("continued")));
        yield* Fiber.interrupt(first);
        return yield* Fiber.join(second);
      }),
    );
    expect(result).toBe("continued");
  });
});
