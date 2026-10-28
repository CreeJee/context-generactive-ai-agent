import { assert, describe, it } from "@effect/vitest";
import { Config, Deferred, Effect, Fiber, Latch, Layer } from "effect";
import { TestClock } from "effect/testing";
import {
  AdmissionWait,
  ExecutionAdmission,
  type ExecutionAdmissionLimits,
  ExecutionSaturated,
} from "../src/runtime/execution-admission.ts";

const limits: ExecutionAdmissionLimits = {
  workflow: { active: 1, queued: 1 },
  model: { active: 1, queued: 1 },
  tool: { active: 1, queued: 1 },
};

describe("ExecutionAdmission", () => {
  it.effect("enforces active and queued capacity, then starts queued work after release", () =>
    Effect.gen(function* () {
      const services = yield* Layer.build(ExecutionAdmission.layer(limits));
      const admission = yield* Effect.provideContext(ExecutionAdmission, services);
      const holderStarted = yield* Deferred.make<void>();
      const releaseHolder = yield* Latch.make();

      const holder = yield* Effect.forkChild(
        admission.run(
          "workflow",
          Deferred.succeed(holderStarted, undefined).pipe(
            Effect.andThen(releaseHolder.await),
            Effect.as("holder" as const),
          ),
        ),
      );
      yield* Deferred.await(holderStarted);

      const queued = yield* Effect.forkChild(
        admission.run("workflow", Effect.succeed("queued" as const)),
      );
      yield* Effect.yieldNow;

      assert.deepStrictEqual(yield* admission.snapshot("workflow"), {
        active: 1,
        queued: 1,
        activeLimit: 1,
        queueCapacity: 1,
      });

      // A request starting new work waits a while for room, then hears the app is busy.
      const refused = yield* Effect.forkChild(
        Effect.flip(
          admission.run(
            "workflow",
            Effect.succeed("must not run"),
            AdmissionWait.upTo({ duration: "1 second" }),
          ),
        ),
      );
      yield* TestClock.adjust("5 seconds");
      const saturated = yield* Fiber.join(refused);
      assert.instanceOf(saturated, ExecutionSaturated);
      assert.deepStrictEqual(
        {
          kind: saturated.kind,
          active: saturated.active,
          queued: saturated.queued,
          capacity: saturated.capacity,
        },
        { kind: "workflow", active: 1, queued: 1, capacity: 2 },
      );

      yield* releaseHolder.open;
      assert.strictEqual(yield* Fiber.join(holder), "holder");
      assert.strictEqual(yield* Fiber.join(queued), "queued");
      assert.deepStrictEqual(yield* admission.snapshot("workflow"), {
        active: 0,
        queued: 0,
        activeLimit: 1,
        queueCapacity: 1,
      });
    }),
  );

  it.effect("running work waits out saturation and starts once a holder is interrupted", () =>
    Effect.gen(function* () {
      const services = yield* Layer.build(
        ExecutionAdmission.layer({
          ...limits,
          model: { active: 1, queued: 0 },
        }),
      );
      const admission = yield* Effect.provideContext(ExecutionAdmission, services);
      const holderStarted = yield* Deferred.make<void>();
      const neverRelease = yield* Latch.make();

      const holder = yield* Effect.forkChild(
        admission.run(
          "model",
          Deferred.succeed(holderStarted, undefined).pipe(Effect.andThen(neverRelease.await)),
        ),
      );
      yield* Deferred.await(holderStarted);

      // No room even to queue: work already running keeps trying instead of failing.
      const waiting = yield* Effect.forkChild(admission.run("model", Effect.succeed("waited")));
      yield* TestClock.adjust("10 seconds");
      assert.isUndefined(waiting.pollUnsafe());

      yield* Fiber.interrupt(holder);
      yield* TestClock.adjust("3 seconds");
      assert.strictEqual(yield* Fiber.join(waiting), "waited");
      assert.deepStrictEqual(yield* admission.snapshot("model"), {
        active: 0,
        queued: 0,
        activeLimit: 1,
        queueCapacity: 0,
      });
    }),
  );

  it.effect("fails layer construction for invalid limit overrides", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        Layer.build(
          ExecutionAdmission.layer({
            ...limits,
            tool: { active: 0, queued: 1 },
          }),
        ),
      );
      assert.instanceOf(failure, Config.ConfigError);
    }),
  );
});
