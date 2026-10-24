import { Effect, Function as EffectFunction, Option, Schedule, Schema } from "effect";
import { expect } from "vite-plus/test";

/** A condition read synchronously from SDK state, or one read from storage. */
export type WaitCondition<E, R> = (() => boolean) | Effect.Effect<boolean, E, R>;

/** Observe SDK state with a wait that belongs to the calling test's Fiber. */
export const waitUntil: {
  (
    what: string,
  ): <E = never, R = never>(
    condition: WaitCondition<E, R>,
  ) => ReturnType<typeof waitUntilBody<E, R>>;
  (
    what: string,
    timeout: number,
  ): <E = never, R = never>(
    condition: WaitCondition<E, R>,
  ) => ReturnType<typeof waitUntilBody<E, R>>;
  <E = never, R = never>(
    condition: WaitCondition<E, R>,
    what: string,
  ): ReturnType<typeof waitUntilBody<E, R>>;
  <E = never, R = never>(
    condition: WaitCondition<E, R>,
    what: string,
    timeout: number,
  ): ReturnType<typeof waitUntilBody<E, R>>;
} = EffectFunction.dual(
  // The pipeable call starts with the description; a condition is never a string.
  (args) => !Schema.is(Schema.String)(args[0]),
  waitUntilBody,
);
function waitUntilBody<E = never, R = never>(
  condition: WaitCondition<E, R>,
  what: string,
  timeout = 4_000,
) {
  return (Effect.isEffect(condition) ? condition : Effect.sync(condition)).pipe(
    Effect.repeat({ until: (ready) => ready, schedule: Schedule.spaced(20) }),
    Effect.timeoutOption(timeout),
    Effect.tap((ready) => Effect.sync(() => expect(Option.isSome(ready), what).toBe(true))),
    Effect.withSpan("waitUntil"),
  );
}
