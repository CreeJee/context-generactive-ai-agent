import { nativePromise, runNativeEffect } from "../runtime/native-effect.ts";
import { isTruthy } from "../truthy.ts";
import { path as platformPath } from "../runtime/synchronous-path.ts";
import { Context, Effect, Fiber, Layer, ManagedRuntime, Schema, Scope } from "effect";
import {
  layaSensorVersion,
  type RecallSensorInput,
  type RecallSensorResult,
} from "./recall-sensor.ts";

/** Inject only an already-installed SDK. This module never imports/downloads a SDK or model. */
export interface LocalLayaSession {
  systemOne(input: {
    state: string;
    questions: { recall_useful: { type: "noul"; instructions: string } };
  }): Promise<LocalLayaResponse>;
  close(): Promise<void>;
}
export interface LocalLayaLoader {
  load(options: {
    modelDir: string;
    executionProviders: ["cpu"];
    sessionOptions: { intraOpNumThreads: 2 };
  }): Promise<LocalLayaSession>;
}
export type LocalRecallSensorConfig =
  | { readonly mode?: "disabled" }
  | {
      readonly mode: "local";
      readonly modelDir: string;
      readonly loader: LocalLayaLoader;
      readonly timeoutMs?: number;
    };

export class LocalRecallSensorError extends Schema.TaggedError<LocalRecallSensorError>()(
  "LocalRecallSensorError",
  { stage: Schema.Literals(["configuration", "load", "inference", "output", "close"]) },
) {}

const ModelDir = Schema.NonEmptyString.pipe(
  Schema.check(
    Schema.makeFilter((path: string) => path.trim().length > 0 && platformPath.isAbsolute(path)),
  ),
);
const Probability = Schema.Finite.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.check(Schema.isLessThanOrEqualTo(1)),
);
const Response = Schema.Struct({
  answers: Schema.Struct({
    recall_useful: Schema.Struct({ type: Schema.Literal("noul"), noul: Probability }),
  }),
});
/** SDK's question-ID-keyed noul response for this adapter's single question.
 * The SDK type is not a trust guarantee; decode it at runtime before using its probability.
 */
export type LocalLayaResponse = typeof Response.Type;

const outcome = (
  status: Exclude<RecallSensorResult["status"], "evaluated">,
): RecallSensorResult => ({ status, version: layaSensorVersion });

class LocalEvaluator extends Context.Service<
  LocalEvaluator,
  {
    evaluate(input: RecallSensorInput): Effect.Effect<RecallSensorResult>;
  }
>()("memory-agent/agent/recall-sensor-local/LocalEvaluator") {}

/**
 * Preparation only; default off, no production wiring. One-turn memo (not a history).
 * Native inference has NO hard cancellation. Timeout/abort interrupt the owning Fiber,
 * but completion and close wait for the uninterruptible SDK call. A hung SDK can hang close.
 * Calls during an active turn are skipped; use a fresh adapter for separate run ownership.
 */
export function createLocalRecallSensor(config: LocalRecallSensorConfig = { mode: "disabled" }) {
  const layer = Layer.effect(
    LocalEvaluator,
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      let session: LocalLayaSession | undefined;
      const infer = Effect.fnUntraced(function* (input: RecallSensorInput) {
        if (config.mode !== "local") return outcome("disabled");
        const modelDir = yield* Schema.decodeEffect(ModelDir)(config.modelDir).pipe(
          Effect.mapError(() => LocalRecallSensorError.make({ stage: "configuration" })),
        );
        if (!(session !== undefined)) {
          session = yield* Effect.acquireRelease(
            Effect.tryPromise({
              try: () =>
                config.loader.load({
                  modelDir,
                  executionProviders: ["cpu"],
                  sessionOptions: { intraOpNumThreads: 2 },
                }),
              catch: () => LocalRecallSensorError.make({ stage: "load" }),
            }),
            (loaded) =>
              Effect.tryPromise({
                try: () => loaded.close(),
                catch: () => LocalRecallSensorError.make({ stage: "close" }),
              }).pipe(Effect.orDie),
          ).pipe(Effect.provideService(Scope.Scope, scope));
        }
        const value = yield* Effect.tryPromise({
          try: () =>
            session!.systemOne({
              state: input.redactedText.slice(0, 2048),
              questions: {
                recall_useful: {
                  type: "noul",
                  instructions:
                    "Would recalling earlier conversation context help answer this turn?",
                },
              },
            }),
          catch: () => LocalRecallSensorError.make({ stage: "inference" }),
        });
        const decoded = yield* Schema.decodeEffect(Response)(value).pipe(
          Effect.mapError(() => LocalRecallSensorError.make({ stage: "output" })),
        );
        return {
          status: "evaluated",
          version: layaSensorVersion,
          score: decoded.answers.recall_useful.noul,
        } satisfies RecallSensorResult;
      });
      const evaluate = Effect.fnUntraced(function* (input: RecallSensorInput) {
        if (config.mode !== "local") return outcome("disabled");
        if (input.signal?.aborted === true) return outcome("cancelled");
        if (input.resourceAllowed === false || !isTruthy(input.redactedText.trim()))
          return outcome("skipped");
        const timeoutMs =
          Number.isFinite(config.timeoutMs) && (config.timeoutMs ?? 0) > 0
            ? Math.min(config.timeoutMs!, 30_000)
            : 1500;
        const abort = Effect.callback<RecallSensorResult>((resume) => {
          const cancel = () => resume(Effect.succeed(outcome("cancelled")));
          input.signal?.addEventListener("abort", cancel, { once: true });
          if (input.signal?.aborted === true) cancel();
          return Effect.sync(() => input.signal?.removeEventListener("abort", cancel));
        });
        return yield* Effect.scoped(
          Effect.gen(function* () {
            // Uninterruptible only at the non-cancellable SDK boundary: never release while native work runs.
            const fiber = yield* Effect.forkScoped(
              infer(input).pipe(
                Effect.catchTag("LocalRecallSensorError", (error) =>
                  Effect.succeed(
                    outcome(error.stage === "configuration" ? "unavailable" : "error"),
                  ),
                ),
                Effect.uninterruptible,
              ),
            );
            return yield* Effect.raceFirst(
              Fiber.join(fiber),
              Effect.raceFirst(abort, Effect.sleep(timeoutMs).pipe(Effect.as(outcome("timeout")))),
            ).pipe(Effect.ensuring(Fiber.interrupt(fiber)));
          }),
        );
      });
      return LocalEvaluator.of({ evaluate });
    }),
  );
  const runtime = ManagedRuntime.make(layer);
  let closed = false;
  let busy = false;
  let memo: { turnId: string; result: Promise<RecallSensorResult> } | undefined;
  let closing: Promise<void> | undefined;
  return {
    evaluate(input: RecallSensorInput): Promise<RecallSensorResult> {
      if (closed) return Promise.resolve(outcome("unavailable"));
      if (memo?.turnId === input.turnId) return memo.result;
      if (busy) return Promise.resolve(outcome("skipped"));
      busy = true;
      const result = runtime
        .runPromise(LocalEvaluator.use((service) => service.evaluate(input)))
        .finally(() => {
          busy = false;
        });
      memo = { turnId: input.turnId, result };
      return result;
    },
    close(): Promise<void> {
      closed = true;
      // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
      closing ??= runNativeEffect(
        (busy && memo !== undefined
          ? nativePromise(() => memo!.result).pipe(Effect.asVoid)
          : Effect.void
        ).pipe(Effect.ensuring(Effect.promise(() => runtime.dispose()))),
      );
      return closing;
    },
  };
}
