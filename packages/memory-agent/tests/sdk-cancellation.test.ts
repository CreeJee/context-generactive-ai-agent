import { expect, it } from "@effect/vitest";
import { EventType, memoryStream, toServerSentEventsResponse } from "@tanstack/ai";
import { Context, Deferred, Effect, Exit, Fiber, Layer, Scope, Stream } from "effect";
import { SdkCancellations } from "../src/runtime/sdk-cancellation.ts";
import { SdkRequestFailed } from "../src/runtime/sdk-promise.ts";
import { createLiveRuns } from "../src/agent/live-runs.ts";

const fixture = Effect.gen(function* () {
  const owner = yield* Scope.fork(yield* Effect.scope);
  const context = yield* Layer.build(SdkCancellations.layer).pipe(
    Effect.provideService(Scope.Scope, owner),
  );
  return { owner, cancellations: Context.get(context, SdkCancellations) };
});

it.effect(
  "a session stays claimed until execution cleanup completes, including setup failure",
  () =>
    Effect.gen(function* () {
      const { cancellations } = yield* fixture;
      const run = yield* cancellations.allocate("service_shutdown");
      const runs = yield* createLiveRuns;
      const started = yield* Deferred.make<void>();
      const allowClose = yield* Deferred.make<void>();
      let endings = 0;
      const claim = yield* runs.claim(
        "session",
        "run",
        run.controller,
        () => {
          endings++;
        },
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(allowClose)),
          Effect.andThen(run.release),
        ),
      );
      expect(claim).not.toBeNull();
      if (claim === null) return;
      const releasing = yield* Effect.forkScoped(claim.release);
      yield* Deferred.await(started);
      expect(runs.get("session")?.runId).toBe("run");
      expect(yield* runs.claim("session", "next", run.controller)).toBeNull();
      yield* Deferred.succeed(allowClose, undefined);
      yield* Fiber.join(releasing);
      expect(runs.get("session")).toBeNull();
      yield* claim.release;
      expect(endings).toBe(1);
    }),
);

it.effect("producer survives the request scope and delivers committed terminal frames", () =>
  Effect.gen(function* () {
    const { owner, cancellations } = yield* fixture;
    const run = yield* cancellations.allocate("service_shutdown");
    const delivery = yield* run.delivery;
    run.controller.abort("worker_teardown");
    const output = yield* Effect.scoped(
      run.publish(Stream.toAsyncIterable(Stream.fromIterable(["partial", "RUN_ERROR"]))),
    );
    const frames = yield* Stream.runCollect(output);
    expect(frames).toEqual(["partial", "RUN_ERROR"]);
    yield* Scope.close(owner, Exit.void);
    expect(delivery.signal.aborted).toBe(false);
  }),
);

it.effect.each(["manual", "shutdown"] as const)(
  "%s waits for pending SDK reads and iterator cleanup",
  (mode) =>
    Effect.gen(function* () {
      const { owner, cancellations } = yield* fixture;
      const run = yield* cancellations.allocate("service_shutdown");
      const started = yield* Deferred.make<void>();
      const closing = yield* Deferred.make<void>();
      const allowClose = yield* Deferred.make<void>();
      let closed = false;
      const runEffect = Effect.runPromiseWith(yield* Effect.context());
      // This mock implements the SDK's Promise/AbortSignal boundary.
      const sdk: AsyncIterable<string> = {
        [Symbol.asyncIterator]: () => ({
          next: () =>
            runEffect(Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)), {
              signal: run.controller.signal,
            }),
          return: () =>
            runEffect(
              Deferred.succeed(closing, undefined).pipe(
                Effect.andThen(Deferred.await(allowClose)),
                Effect.andThen(
                  Effect.sync(() => {
                    closed = true;
                    return { done: true as const, value: undefined };
                  }),
                ),
              ),
            ),
        }),
      };
      const output = yield* run.publish(sdk);
      const consuming = yield* Effect.forkScoped(Stream.runDrain(output).pipe(Effect.exit));
      yield* Deferred.await(started);
      const cancelling = yield* Effect.forkScoped(
        mode === "manual" ? run.cancel : Scope.close(owner, Exit.void),
      );
      yield* Deferred.await(closing);
      expect(closed).toBe(false);
      yield* Deferred.succeed(allowClose, undefined);
      yield* Fiber.join(cancelling);
      yield* Fiber.join(consuming);
      expect(run.controller.signal.aborted).toBe(true);
      if (mode === "shutdown") expect(run.controller.signal.reason).toBe("service_shutdown");
      expect(closed).toBe(true);
    }),
);

it.effect("HTTP disconnection keeps producing and persists the final frame for replay", () =>
  Effect.gen(function* () {
    const { cancellations } = yield* fixture;
    const run = yield* cancellations.allocate("service_shutdown");
    const finish = yield* Deferred.make<void>();
    const closed = yield* Deferred.make<void>();
    const runEffect = Effect.runPromiseWith(yield* Effect.context());
    const request = <A>(execute: () => Promise<A>) =>
      Effect.tryPromise({
        try: execute,
        catch: (cause) => SdkRequestFailed.make({ cause }),
      });
    const source = Stream.make({
      type: EventType.RUN_STARTED,
      threadId: "fiber-thread",
      runId: "fiber-run",
      timestamp: 0,
    }).pipe(
      Stream.concat(
        Stream.fromEffect(
          Deferred.await(finish).pipe(
            Effect.as({
              type: EventType.RUN_FINISHED as const,
              threadId: "fiber-thread",
              runId: "fiber-run",
              timestamp: 1,
            }),
          ),
        ),
      ),
    );
    const published = yield* run.publish(Stream.toAsyncIterable(source));
    const durable = memoryStream({ runId: "fiber-run" });
    const response = toServerSentEventsResponse(Stream.toAsyncIterable(published), {
      abortController: run.controller,
      durability: {
        batch: 1,
        adapter: {
          ...durable,
          close: () =>
            runEffect(
              request(() => durable.close()).pipe(
                Effect.andThen(Deferred.succeed(closed, undefined)),
                Effect.asVoid,
              ),
            ),
        },
      },
    });
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    if (reader === undefined) return;
    yield* request(() => reader.read());
    yield* request(() => reader.cancel());
    expect(run.controller.signal.aborted).toBe(false);
    yield* Deferred.succeed(finish, undefined);
    yield* Deferred.await(closed);
    const saved = yield* request(() => durable.snapshot());
    expect(saved.map((entry) => entry.chunk.type)).toEqual([
      "CUSTOM",
      "RUN_STARTED",
      "RUN_FINISHED",
    ]);
    expect(run.controller.signal.aborted).toBe(false);
  }),
);

it.effect("request completion keeps the run alive, owner shutdown cancels it", () =>
  Effect.gen(function* () {
    const { owner, cancellations } = yield* fixture;
    const run = yield* Effect.scoped(cancellations.allocate("app_shutdown"));
    expect(run.controller.signal.aborted).toBe(false);
    yield* Scope.close(owner, Exit.void);
    expect(run.controller.signal.aborted).toBe(true);
    expect(run.controller.signal.reason).toBe("app_shutdown");
  }),
);

it.effect("worker teardown preserves delivery, while delivery cancellation stops execution", () =>
  Effect.gen(function* () {
    const { cancellations } = yield* fixture;
    const failed = yield* cancellations.allocate("service_shutdown");
    const delivery = yield* failed.delivery;
    failed.controller.abort("worker_teardown");
    expect(delivery.signal.aborted).toBe(false);
    yield* failed.release;
    expect(delivery.signal.aborted).toBe(false);

    const cancelled = yield* cancellations.allocate("service_shutdown");
    const cancelledDelivery = yield* cancelled.delivery;
    cancelledDelivery.abort("run_cancelled");
    expect(cancelled.controller.signal.aborted).toBe(true);
    expect(cancelled.controller.signal.reason).toBe("run_cancelled");
    yield* cancelled.release;
  }),
);

it.effect(
  "successful release detaches controllers and owner shutdown only cancels active runs",
  () =>
    Effect.gen(function* () {
      const { owner, cancellations } = yield* fixture;
      const completed = yield* cancellations.allocate("service_shutdown");
      const delivery = yield* completed.delivery;
      yield* completed.release;
      yield* completed.release;
      const active = yield* cancellations.allocate("service_shutdown");
      yield* Scope.close(owner, Exit.void);
      expect(completed.controller.signal.aborted).toBe(false);
      expect(delivery.signal.aborted).toBe(false);
      expect(active.controller.signal.aborted).toBe(true);
    }),
);
