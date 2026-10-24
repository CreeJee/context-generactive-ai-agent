import { Cause, Data, Effect, Function as EffectFunction, Schedule, Schema } from "effect";
import { tagOf } from "./failure-tag.ts";
import { logDefect, logFailure } from "./logged-failures.ts";

/**
 * How a background loop stands (decided 2026-10-18). An expected failure is retried with backoff;
 * when the retries run out, or a defect happens, the loop stops and stays stopped until a person
 * restarts it. A success resets the count.
 */
export const LoopHealth = Schema.TaggedUnion({
  Healthy: {},
  /** The step failed `attempt` times in a row and waits before trying again. */
  Retrying: { attempt: Schema.Int, of: Schema.Int },
  /** The retries ran out on an expected failure, named by its tag. */
  Exhausted: { error: Schema.String },
  /** A defect stopped the loop; it was never retried. */
  Defected: {},
});
export type LoopHealth = typeof LoopHealth.Type;

export const healthyLoop: LoopHealth = LoopHealth.cases.Healthy.make({});

const loopHealthEquivalence = Schema.toEquivalence(LoopHealth);
export const sameLoopHealth: {
  (that: LoopHealth): (self: LoopHealth) => boolean;
  (self: LoopHealth, that: LoopHealth): boolean;
} = EffectFunction.dual(2, loopHealthEquivalence);

/** Whether the loop stopped and waits for a person to restart it. */
export const loopStopped = LoopHealth.match({
  Healthy: () => false,
  Retrying: () => false,
  Exhausted: () => true,
  Defected: () => true,
});

export const maxLoopRetries = 5;

/** Exponential backoff from 10 seconds, each wait capped at 5 minutes, at most five retries. */
export const loopRetrySchedule = Schedule.max([
  Schedule.min([Schedule.exponential("10 seconds"), Schedule.spaced("5 minutes")]),
  Schedule.recurs(maxLoopRetries),
]);

/** What one supervised step of a loop came to. */
export type LoopStep<A> = Data.TaggedEnum<{
  Continued: { readonly value: A };
  Stopped: { readonly health: LoopHealth };
}>;
interface LoopStepDefinition extends Data.TaggedEnum.WithGenerics<1> {
  readonly taggedEnum: LoopStep<this["A"]>;
}
export const LoopStep = Data.taggedEnum<LoopStepDefinition>();

export interface LoopSupervision {
  /** Logged with each failure, by its tag only. */
  readonly message: string;
  readonly annotations?: Readonly<Record<string, string>>;
  /** Where the loop's owner keeps its health; called on every change of it. */
  readonly setHealth: (health: LoopHealth) => Effect.Effect<void>;
}

/**
 * Runs one step of a background loop under the retry policy. An expected failure is retried on
 * `loopRetrySchedule`; once the retries run out the step answers `Stopped` with `Exhausted`. A
 * defect is never retried: it is logged and answers `Stopped` with `Defected`. Interruption passes
 * through, since stopping a loop is not a failure of it.
 */
export const superviseLoopStep =
  ({ message, annotations = {}, setHealth }: LoopSupervision) =>
  <A, E extends { readonly _tag: string }, R>(
    step: Effect.Effect<A, E, R>,
  ): Effect.Effect<LoopStep<A>, never, R> =>
    step.pipe(
      Effect.retry(
        loopRetrySchedule.pipe(
          Schedule.setInputType<E>(),
          Schedule.tap(({ input, attempt }) =>
            Effect.andThen(
              logFailure(message, { ...annotations, attempt: String(attempt) })(input),
              setHealth(LoopHealth.cases.Retrying.make({ attempt, of: maxLoopRetries })),
            ),
          ),
        ),
      ),
      Effect.tap(() => setHealth(healthyLoop)),
      Effect.map((value): LoopStep<A> => LoopStep.Continued({ value })),
      Effect.catch((error) => {
        const health: LoopHealth = LoopHealth.cases.Exhausted.make({ error: tagOf(error) });
        return logFailure(
          message,
          annotations,
        )(error).pipe(
          Effect.andThen(setHealth(health)),
          Effect.as<LoopStep<A>>(LoopStep.Stopped({ health })),
        );
      }),
      Effect.catchDefect((defect) => {
        const health: LoopHealth = LoopHealth.cases.Defected.make({});
        return logDefect(
          message,
          annotations,
        )(Cause.die(defect)).pipe(
          Effect.andThen(setHealth(health)),
          Effect.as<LoopStep<A>>(LoopStep.Stopped({ health })),
        );
      }),
    );
