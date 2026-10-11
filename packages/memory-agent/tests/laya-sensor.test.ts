import { Cause, Deferred, Effect, Layer, Schema, Stream } from "effect";
import { LayaWorkerProcess } from "../eval/laya-worker-process.ts";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import { createLayaSensor, layaNodeSensorVersion } from "../eval/laya-sensor.ts";

const options = {
  enabled: true,
  resourceAvailable: true,
  sdkDir: "/sdk",
  modelDir: "/model",
  workerPath: "/worker.mjs",
};

it.live("bridges the recall contract with Node provenance and bounded input", () =>
  Effect.gen(function* () {
    let calls = 0;
    const handle = {
      exitCode: Effect.succeed(0),
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      stdout: Stream.make(
        new TextEncoder().encode(
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
            score: 0.7,
            tokens: 3,
            loadMs: 1,
            inferenceMs: 2,
            rssBytes: 1024,
          }),
        ),
      ),
    };
    const layer = Layer.succeed(LayaWorkerProcess, {
      spawn: () =>
        Effect.sync(() => {
          calls++;
          return handle;
        }),
    });
    const sensor = yield* Effect.acquireRelease(
      Effect.sync(() => createLayaSensor(options, layer)),
      (sensor) => Effect.promise(() => sensor.close()),
    );
    expect(
      yield* Effect.tryPromise({
        try: () => sensor.evaluate({ turnId: "1", redactedText: "x".repeat(3000) }),
        catch: (cause) => new Cause.UnknownError(cause),
      }),
    ).toEqual({
      status: "evaluated",
      score: 0.7,
      version: layaNodeSensorVersion,
    });
    expect(
      yield* Effect.tryPromise({
        try: () =>
          sensor.evaluate({
            turnId: "1",
            redactedText: "x".repeat(3000),
            resourceAllowed: false,
          }),
        catch: (cause) => new Cause.UnknownError(cause),
      }),
    ).toEqual({ status: "skipped", version: layaNodeSensorVersion });
    expect(calls).toBe(1);
  }),
);

it.live("close interrupts active children and awaits their exit", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const killed = yield* Deferred.make<void>();
    const exit = yield* Deferred.make<number>();
    const handle = {
      exitCode: Deferred.await(exit),
      isRunning: Effect.succeed(true),
      kill: () => Deferred.succeed(killed, undefined).pipe(Effect.asVoid),
      stdout: Stream.fromEffect(Effect.never),
    };
    const layer = Layer.succeed(LayaWorkerProcess, {
      spawn: () => Deferred.succeed(started, undefined).pipe(Effect.as(handle)),
    });
    const sensor = yield* Effect.acquireRelease(
      Effect.sync(() => createLayaSensor(options, layer)),
      (sensor) => Effect.promise(() => sensor.close()),
    );
    yield* Effect.addFinalizer(() => Deferred.succeed(exit, 137));
    const evaluation = sensor.evaluate({ turnId: "1", redactedText: "hi" });
    // Observe rejection immediately: close preserves interruption, not a fabricated fallback.
    const observed = evaluation.then(
      () => "success",
      () => "interrupted",
    );
    yield* Deferred.await(started);
    let closed = false;
    const closing = sensor.close().then(() => {
      closed = true;
    });
    yield* Deferred.await(killed);
    expect(closed).toBe(false);
    yield* Deferred.succeed(exit, 137);
    yield* Effect.tryPromise({
      try: () => closing,
      catch: (cause) => new Cause.UnknownError(cause),
    });
    expect(
      yield* Effect.tryPromise({
        try: () => observed,
        catch: (cause) => new Cause.UnknownError(cause),
      }),
    ).toBe("interrupted");
  }),
);
