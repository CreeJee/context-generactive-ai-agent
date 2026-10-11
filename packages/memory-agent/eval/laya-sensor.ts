import { Function as EffectFunction } from "effect";
import { isTruthy } from "../src/truthy.ts";
import { Context, Effect, Fiber, Layer, ManagedRuntime } from "effect";
import { LayaWorkerProcess } from "./laya-worker-process.ts";
import type { RecallSensorInput, RecallSensorResult } from "../src/agent/recall-sensor.ts";
import {
  layaProvenance,
  // oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- This eval composition root constructs the per-turn runner, never production runtime code.
  makeLayaProcess,
  type LayaProcessOptions,
  type LayaResult,
} from "./laya-process.ts";

export const layaNodeSensorVersion = `${layaProvenance.model}@${layaProvenance.revision}:node-cold-process`;

function sensorResult(result: LayaResult): RecallSensorResult {
  const version = layaNodeSensorVersion;
  switch (result._tag) {
    case "success":
      return { status: "evaluated", score: result.value.score, version };
    case "skip":
      return { status: result.reason === "disabled" ? "disabled" : "skipped", version };
    case "unavailable":
      return { status: "unavailable", version };
    case "timeout":
      return { status: "timeout", version };
    case "cancelled":
      return { status: "cancelled", version };
    case "error":
      return { status: "error", version };
  }
}

class EvalSensor extends Context.Service<
  EvalSensor,
  {
    evaluate(input: RecallSensorInput): Effect.Effect<RecallSensorResult>;
  }
>()("memory-agent/eval/laya-sensor/EvalSensor") {}

/** Eval-only, per-turn bridge. The caller supplies a trusted platform layer; no implicit SDK loading. */
export const createLayaSensor: {
  (
    spawnerLayer: Layer.Layer<LayaWorkerProcess>,
  ): (options: LayaProcessOptions) => ReturnType<typeof createLayaSensorBody>;
} & typeof createLayaSensorBody = EffectFunction.dual(2, createLayaSensorBody);
function createLayaSensorBody(
  options: LayaProcessOptions,
  spawnerLayer: Layer.Layer<LayaWorkerProcess>,
) {
  const layer = Layer.effect(
    EvalSensor,
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const spawner = yield* LayaWorkerProcess;
      const runner = yield* makeLayaProcess(options);
      const evaluate = Effect.fnUntraced(function* (input: RecallSensorInput) {
        if (!(options.enabled === true)) return sensorResult({ _tag: "skip", reason: "disabled" });
        if (input.signal?.aborted === true) return sensorResult({ _tag: "cancelled" });
        if (input.resourceAllowed === false || !isTruthy(input.redactedText.trim()))
          return sensorResult({ _tag: "skip", reason: "resource" });
        const text = input.redactedText.slice(0, 2048);
        const task =
          input.signal !== undefined ? runner.runAbortable(text, input.signal) : runner.run(text);
        const fiber = yield* Effect.forkIn(
          task.pipe(Effect.provideService(LayaWorkerProcess, spawner)),
          scope,
        );
        return sensorResult(yield* Fiber.join(fiber));
      });
      return EvalSensor.of({ evaluate });
    }),
  ).pipe(Layer.provide(spawnerLayer));
  const runtime = ManagedRuntime.make(layer);
  return {
    evaluate: (input: RecallSensorInput) =>
      runtime.runPromise(EvalSensor.use((sensor) => sensor.evaluate(input))),
    close: () => runtime.dispose(),
  };
}
