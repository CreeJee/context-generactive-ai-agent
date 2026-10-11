// Finite, synthetic owner-thread observation. Timers are benchmark instrumentation only.
// Uses the actual production client/worker; no application DB/model calls or operational cache.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { NativeOwner } from "../packages/memory-agent/src/memory/native-search/client.ts";

class ObservationFailed extends Schema.TaggedError<ObservationFailed>()("ObservationFailed", {
  reason: Schema.Literals(["fixture", "reply", "no-heartbeat"]),
}) {}

const count = 50_000;
const dimensions = 384;
const ids = Array.from({ length: count }, (_, index) => String(index + 1));
const matrix = new Float32Array(count * dimensions);
for (let row = 0; row < count; row++) {
  let norm = 0;
  for (let column = 0; column < dimensions; column++) {
    const value = Math.sin(row * 0.17 + column * 0.31);
    matrix[row * dimensions + column] = value;
    norm += value * value;
  }
  for (let column = 0; column < dimensions; column++)
    matrix[row * dimensions + column]! /= Math.sqrt(norm);
}

const observe = Effect.scoped(
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.try({
        try: () => mkdtempSync(join(tmpdir(), "native-responsive-")),
        catch: () => new ObservationFailed({ reason: "fixture" }),
      }),
      (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
    );
    return yield* Effect.gen(function* () {
      const owner = yield* NativeOwner;
      yield* owner.execute({
        kind: "add",
        epoch: owner.epoch,
        requestId: "seed",
        vectors: matrix,
        ids,
      });
      const ticks: bigint[] = [];
      yield* Effect.acquireRelease(
        Effect.sync(() => setInterval(() => ticks.push(process.hrtime.bigint()), 1)),
        (timer) => Effect.sync(() => clearInterval(timer)),
      );
      const observations: { nativeBoundaryMs: number; mainHeartbeatInsideNativeCall: number }[] =
        [];
      for (let iteration = 0; iteration < 10; iteration++) {
        const reply = yield* owner.execute({
          kind: "vector-search",
          epoch: owner.epoch,
          requestId: `search-${iteration}`,
          query: matrix.slice(0, dimensions),
          k: 48,
          allowedIds: ids,
        });
        if (
          reply.kind !== "vector-hits" ||
          reply.nativeWindow === undefined ||
          reply.ids.length !== 48
        )
          return yield* new ObservationFailed({ reason: "reply" });
        const start = BigInt(reply.nativeWindow.startNs);
        const end = BigInt(reply.nativeWindow.endNs);
        const during = ticks.filter((tick) => tick > start && tick < end).length;
        observations.push({
          nativeBoundaryMs: Number(end - start) / 1e6,
          mainHeartbeatInsideNativeCall: during,
        });
        ticks.splice(0);
      }
      if (observations.every((sample) => sample.mainHeartbeatInsideNativeCall === 0))
        return yield* new ObservationFailed({ reason: "no-heartbeat" });
      console.log(
        JSON.stringify(
          {
            count,
            dimensions,
            bits: 4,
            k: 48,
            nativeWorkerThreadId: owner.threadId,
            observations,
            note: "Main hrtime heartbeat timestamps strictly inside actual worker native-call windows. Includes N-API conversion, not pure inner CPU. Fixture preparation, allowlist marshaling and SQL/graph work are not this measurement. This does not prove active native cancellation or budget.",
          },
          null,
          2,
        ),
      );
    }).pipe(
      Effect.provide(
        NativeOwner.layer(
          {
            kind: "setup",
            epoch: "responsiveness",
            dimensions,
            bits: 4,
            cacheDirectory: directory,
          },
          new URL("../packages/memory-agent/src/memory/native-search/worker.ts", import.meta.url),
        ),
      ),
    );
  }),
).pipe(Effect.timeout("30 seconds"));

await Effect.runPromise(observe);
