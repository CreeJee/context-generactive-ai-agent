import { isTruthy } from "../src/truthy.ts";
import { it } from "@effect/vitest";
import {
  Schema,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  PlatformError,
  Ref,
  Scope,
  Stream,
} from "effect";
import { LayaWorkerProcess } from "../eval/laya-worker-process.ts";
import { TestClock } from "effect/testing";
import { expect } from "vite-plus/test";
import { layaProvenance, makeLayaProcess } from "../eval/laya-process.ts";

const stringifyJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const options = {
  enabled: true,
  resourceAvailable: true,
  sdkDir: "/sdk",
  modelDir: "/model",
  workerPath: "/worker.mjs",
  startupTimeoutMs: 100,
};
const value = { score: 0.5, tokens: 2, loadMs: 1, inferenceMs: 2, rssBytes: 1024 };

const mock = Effect.fnUntraced(function* (output?: string, code = 0, blocked = false) {
  const outputText = output ?? (yield* stringifyJson(value));
  const started = yield* Deferred.make<void>();
  const killed = yield* Deferred.make<void>();
  const exit = yield* Deferred.make<number>();
  const calls = yield* Ref.make(0);
  const running = yield* Ref.make(blocked);
  if (!isTruthy(blocked)) yield* Deferred.succeed(exit, Number(code));
  const handle = {
    exitCode: Deferred.await(exit),
    isRunning: Ref.get(running),
    kill: () => Deferred.succeed(killed, undefined).pipe(Effect.asVoid),
    stdout: isTruthy(blocked)
      ? Stream.fromEffect(Effect.never)
      : Stream.make(new TextEncoder().encode(outputText)),
  };
  const layer = Layer.succeed(LayaWorkerProcess, {
    spawn: () =>
      Ref.update(calls, (n) => n + 1).pipe(
        Effect.andThen(Deferred.succeed(started, undefined)),
        Effect.as(handle),
      ),
  });
  return { layer, calls, started, killed, exit, running };
});

it.effect("success carries Node model provenance and memoizes the bounded text", () =>
  Effect.gen(function* () {
    const m = yield* mock();
    const runner = yield* makeLayaProcess(options);
    // Test entry point owns this Layer and its resource scope.
    const result = yield* runner.run("hello").pipe(
      Effect.fnUntraced(function* <A, E, R>(program: Effect.Effect<A, E, R>) {
        const services = yield* Layer.build(m.layer);
        return yield* Effect.provideContext(program, services);
      }, Effect.scoped),
    );
    expect(result).toEqual({ _tag: "success", value, provenance: layaProvenance });
    // Test entry point owns this Layer and its resource scope.
    expect(
      yield* runner.run("hello").pipe(
        Effect.fnUntraced(function* <A, E, R>(program: Effect.Effect<A, E, R>) {
          const services = yield* Layer.build(m.layer);
          return yield* Effect.provideContext(program, services);
        }, Effect.scoped),
      ),
    ).toEqual(result);
    // Test entry point owns this Layer and its resource scope.
    expect(
      yield* runner.run("hello", false).pipe(
        Effect.fnUntraced(function* <A, E, R>(program: Effect.Effect<A, E, R>) {
          const services = yield* Layer.build(m.layer);
          return yield* Effect.provideContext(program, services);
        }, Effect.scoped),
      ),
    ).toEqual({
      _tag: "skip",
      reason: "resource",
    });
    expect(yield* Ref.get(m.calls)).toBe(1);
  }),
);

it.effect("pre-aborted signal at execution never spawns", () =>
  Effect.gen(function* () {
    const m = yield* mock();
    const runner = yield* makeLayaProcess(options);
    const signalScope = yield* Scope.fork(yield* Scope.Scope, "sequential");
    const signal = yield* Effect.provideService(Effect.abortSignal, Scope.Scope, signalScope);
    const task = runner.runAbortable("hello", signal);
    yield* Scope.close(signalScope, Exit.void);
    // Test entry point owns this Layer and its resource scope.
    expect(
      yield* task.pipe(
        Effect.fnUntraced(function* <A, E, R>(program: Effect.Effect<A, E, R>) {
          const services = yield* Layer.build(m.layer);
          return yield* Effect.provideContext(program, services);
        }, Effect.scoped),
      ),
    ).toEqual({ _tag: "cancelled" });
    expect(yield* Ref.get(m.calls)).toBe(0);
  }),
);

it.effect("disabled, resource and oversized inputs never spawn", () =>
  Effect.gen(function* () {
    const m = yield* mock();
    for (const [config, text, result] of [
      [{ ...options, enabled: false }, "hi", { _tag: "skip", reason: "disabled" }],
      [{ ...options, resourceAvailable: false }, "hi", { _tag: "skip", reason: "resource" }],
      [options, "x".repeat(2049), { _tag: "error", stage: "input" }],
    ] as const) {
      const runner = yield* makeLayaProcess(config);
      // Test entry point owns this Layer and its resource scope.
      expect(
        yield* runner.run(text).pipe(
          Effect.fnUntraced(function* <A, E, R>(program: Effect.Effect<A, E, R>) {
            const services = yield* Layer.build(m.layer);
            return yield* Effect.provideContext(program, services);
          }, Effect.scoped),
        ),
      ).toEqual(result);
    }
    expect(yield* Ref.get(m.calls)).toBe(0);
  }),
);

it.effect("invalid JSON, schema, exit and oversized output fall back", () =>
  Effect.gen(function* () {
    for (const [output, code, stage] of [
      ["{", 0, "output"],
      [yield* stringifyJson({ ...value, score: 2 }), 0, "output"],
      [yield* stringifyJson({ ...value, tokens: 513 }), 0, "output"],
      [yield* stringifyJson(value), 1, "process"],
      ["x".repeat(8193), 0, "output"],
    ] as const) {
      const m = yield* mock(output, code);
      const runner = yield* makeLayaProcess(options);
      // Test entry point owns this Layer and its resource scope.
      expect(
        yield* runner.run("hi").pipe(
          Effect.fnUntraced(function* <A, E, R>(program: Effect.Effect<A, E, R>) {
            const services = yield* Layer.build(m.layer);
            return yield* Effect.provideContext(program, services);
          }, Effect.scoped),
        ),
      ).toEqual({
        _tag: "error",
        stage,
      });
    }
  }),
);

it.effect("same and different text busy-skip; timeout awaits kill and exit", () =>
  Effect.gen(function* () {
    const m = yield* mock("", 0, true);
    const runner = yield* makeLayaProcess(options);
    // Test entry point owns this Layer and its resource scope.
    const fiber = yield* runner.run("one").pipe(
      Effect.fnUntraced(function* <A, E, R>(program: Effect.Effect<A, E, R>) {
        const services = yield* Layer.build(m.layer);
        return yield* Effect.provideContext(program, services);
      }, Effect.scoped),
      Effect.forkChild,
    );
    yield* Deferred.await(m.started);
    for (const text of ["one", "two"])
      // Test entry point owns this Layer and its resource scope.
      expect(
        yield* runner.run(text).pipe(
          Effect.fnUntraced(function* <A, E, R>(program: Effect.Effect<A, E, R>) {
            const services = yield* Layer.build(m.layer);
            return yield* Effect.provideContext(program, services);
          }, Effect.scoped),
        ),
      ).toEqual({
        _tag: "skip",
        reason: "busy",
      });
    yield* TestClock.adjust(100);
    yield* Deferred.await(m.killed);
    expect(fiber.pollUnsafe()).toBeUndefined();
    yield* Ref.set(m.running, false);
    yield* Deferred.succeed(m.exit, 137);
    expect(yield* Fiber.join(fiber)).toEqual({ _tag: "timeout" });
    expect(yield* Ref.get(m.calls)).toBe(1);
  }),
);

it.effect("interruption awaits hard cleanup without becoming domain failure", () =>
  Effect.gen(function* () {
    const m = yield* mock("", 0, true);
    const runner = yield* makeLayaProcess(options);
    // Test entry point owns this Layer and its resource scope.
    const fiber = yield* runner.run("hi").pipe(
      Effect.fnUntraced(function* <A, E, R>(program: Effect.Effect<A, E, R>) {
        const services = yield* Layer.build(m.layer);
        return yield* Effect.provideContext(program, services);
      }, Effect.scoped),
      Effect.forkChild,
    );
    yield* Deferred.await(m.started);
    const interrupted = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild);
    yield* Deferred.await(m.killed);
    expect(interrupted.pollUnsafe()).toBeUndefined();
    yield* Ref.set(m.running, false);
    yield* Deferred.succeed(m.exit, 137);
    yield* Fiber.join(interrupted);
  }),
);

it.effect("typed spawn failure is memoized as process fallback", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const layer = Layer.succeed(LayaWorkerProcess, {
      spawn: () =>
        Ref.update(calls, (n) => n + 1).pipe(
          Effect.andThen(
            Effect.fail(
              new PlatformError.PlatformError(
                new PlatformError.BadArgument({ module: "ChildProcess", method: "spawn" }),
              ),
            ),
          ),
        ),
    });
    const runner = yield* makeLayaProcess(options);
    for (let i = 0; i < 2; i++)
      // Test entry point owns this Layer and its resource scope.
      expect(
        yield* runner.run("hi").pipe(
          Effect.fnUntraced(function* <A, E, R>(program: Effect.Effect<A, E, R>) {
            const services = yield* Layer.build(layer);
            return yield* Effect.provideContext(program, services);
          }, Effect.scoped),
        ),
      ).toEqual({
        _tag: "error",
        stage: "process",
      });
    expect(yield* Ref.get(calls)).toBe(1);
  }),
);

it.effect("abort cancellation waits for child exit", () =>
  Effect.gen(function* () {
    const m = yield* mock("", 0, true);
    const signalScope = yield* Scope.fork(yield* Scope.Scope, "sequential");
    const signal = yield* Effect.provideService(Effect.abortSignal, Scope.Scope, signalScope);
    const runner = yield* makeLayaProcess(options);
    const fiber = yield* runner
      .runAbortable("hi", signal)
      // Test entry point owns this Layer and its resource scope.
      .pipe(
        Effect.fnUntraced(function* <A, E, R>(program: Effect.Effect<A, E, R>) {
          const services = yield* Layer.build(m.layer);
          return yield* Effect.provideContext(program, services);
        }, Effect.scoped),
        Effect.forkChild,
      );
    yield* Deferred.await(m.started);
    yield* Scope.close(signalScope, Exit.void);
    yield* Deferred.await(m.killed);
    expect(fiber.pollUnsafe()).toBeUndefined();
    yield* Ref.set(m.running, false);
    yield* Deferred.succeed(m.exit, 137);
    expect(yield* Fiber.join(fiber)).toEqual({ _tag: "cancelled" });
  }),
);
