import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Latch, Layer } from "effect";
import {
  ExecutionAdmission,
  type ExecutionAdmissionLimits,
  ExecutionSaturated,
} from "../src/runtime/execution-admission.ts";

const limits: ExecutionAdmissionLimits = {
  workflow: { active: 1, queued: 1 },
  worker: { active: 1, queued: 1 },
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

      const saturated = yield* Effect.flip(
        admission.run("workflow", Effect.succeed("must not run")),
      );
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

  it.effect("releases active and admission capacity when a holder is interrupted", () =>
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

      const saturated = yield* Effect.flip(admission.run("model", Effect.succeed("must not run")));
      assert.instanceOf(saturated, ExecutionSaturated);

      yield* Fiber.interrupt(holder);
      assert.strictEqual(
        yield* admission.run("model", Effect.succeed("replacement")),
        "replacement",
      );
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
      assert.strictEqual(failure._tag, "ConfigError");
    }),
  );
});
