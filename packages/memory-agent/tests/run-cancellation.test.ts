import { expect, it } from "@effect/vitest";
import { Context, Deferred, Effect, Exit, Fiber, Layer, Ref, Scope, Stream } from "effect";
import { RunCancellations } from "../src/runtime/run-cancellation.ts";
import { createLiveRuns } from "../src/agent/live-runs.ts";

const fixture = Effect.gen(function* () {
  const owner = yield* Scope.fork(yield* Effect.scope);
  const context = yield* Layer.build(RunCancellations.layer).pipe(
    Effect.provideService(Scope.Scope, owner),
  );
  return { owner, cancellations: Context.get(context, RunCancellations) };
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
    run.controller.abort("worker_teardown");
    const output = yield* Effect.scoped(run.publish(Stream.fromIterable(["partial", "RUN_ERROR"])));
    const frames = yield* Stream.runCollect(output);
    expect(frames).toEqual(["partial", "RUN_ERROR"]);
    yield* Scope.close(owner, Exit.void);
  }),
);

it.effect.each(["manual", "shutdown"] as const)(
  "%s waits for the run's events to stop and clean up",
  (mode) =>
    Effect.gen(function* () {
      const { owner, cancellations } = yield* fixture;
      const run = yield* cancellations.allocate("service_shutdown");
      const started = yield* Deferred.make<void>();
      const closing = yield* Deferred.make<void>();
      const allowClose = yield* Deferred.make<void>();
      const closed = yield* Ref.make(false);
      // Events that never come, and a cleanup that waits until the test lets it finish.
      const events = Stream.fromEffect(
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      ).pipe(
        Stream.ensuring(
          Deferred.succeed(closing, undefined).pipe(
            Effect.andThen(Deferred.await(allowClose)),
            Effect.andThen(Ref.set(closed, true)),
          ),
        ),
      );
      const output = yield* run.publish(events);
      const consuming = yield* Effect.forkScoped(Stream.runDrain(output).pipe(Effect.exit));
      yield* Deferred.await(started);
      const cancelling = yield* Effect.forkScoped(
        mode === "manual" ? run.cancel : Scope.close(owner, Exit.void),
      );
      yield* Deferred.await(closing);
      expect(yield* Ref.get(closed)).toBe(false);
      yield* Deferred.succeed(allowClose, undefined);
      yield* Fiber.join(cancelling);
      yield* Fiber.join(consuming);
      expect(run.controller.signal.aborted).toBe(true);
      if (mode === "shutdown") expect(run.controller.signal.reason).toBe("service_shutdown");
      expect(yield* Ref.get(closed)).toBe(true);
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

it.effect(
  "successful release detaches controllers and owner shutdown only cancels active runs",
  () =>
    Effect.gen(function* () {
      const { owner, cancellations } = yield* fixture;
      const completed = yield* cancellations.allocate("service_shutdown");
      yield* completed.release;
      yield* completed.release;
      const active = yield* cancellations.allocate("service_shutdown");
      yield* Scope.close(owner, Exit.void);
      expect(completed.controller.signal.aborted).toBe(false);
      expect(active.controller.signal.aborted).toBe(true);
    }),
);
