import { Cause, Effect, Schedule, Schema } from "effect";
import { logDefect, logFailure } from "./logged-failures.ts";

/**
 * How a background loop stands (decided 2026-10-18). An expected failure is retried with backoff;
 * when the retries run out, or a defect happens, the loop stops and stays stopped until a person
 * restarts it. A success resets the count.
 */
export const LoopHealth = Schema.Union([
  Schema.TaggedStruct("Healthy", {}),
  /** The step failed `attempt` times in a row and waits before trying again. */
  Schema.TaggedStruct("Retrying", { attempt: Schema.Int, of: Schema.Int }),
  /** The retries ran out on an expected failure, named by its tag. */
  Schema.TaggedStruct("Exhausted", { error: Schema.String }),
  /** A defect stopped the loop; it was never retried. */
  Schema.TaggedStruct("Defected", {}),
]).pipe(Schema.toTaggedUnion("_tag"));
export type LoopHealth = typeof LoopHealth.Type;

export const healthyLoop: LoopHealth = { _tag: "Healthy" };

export const sameLoopHealth = Schema.toEquivalence(LoopHealth);

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
export type LoopStep<A> =
  | { readonly _tag: "Continued"; readonly value: A }
  | { readonly _tag: "Stopped"; readonly health: LoopHealth };

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
              setHealth({ _tag: "Retrying", attempt, of: maxLoopRetries }),
            ),
          ),
        ),
      ),
      Effect.tap(() => setHealth(healthyLoop)),
      Effect.map((value): LoopStep<A> => ({ _tag: "Continued", value })),
      Effect.catch((error) => {
        const health: LoopHealth = { _tag: "Exhausted", error: error._tag };
        return logFailure(
          message,
          annotations,
        )(error).pipe(
          Effect.andThen(setHealth(health)),
          Effect.as<LoopStep<A>>({ _tag: "Stopped", health }),
        );
      }),
      Effect.catchDefect((defect) => {
        const health: LoopHealth = { _tag: "Defected" };
        return logDefect(
          message,
          annotations,
        )(Cause.die(defect)).pipe(
          Effect.andThen(setHealth(health)),
          Effect.as<LoopStep<A>>({ _tag: "Stopped", health }),
        );
      }),
    );
