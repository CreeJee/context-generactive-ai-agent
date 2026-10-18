import { Effect, Option, Schedule } from "effect";
import { expect } from "vite-plus/test";

/** A condition read synchronously from SDK state, or one read from storage. */
export type WaitCondition<E, R> = (() => boolean) | Effect.Effect<boolean, E, R>;

/** Observe SDK state with a wait that belongs to the calling test's Fiber. */
export const waitUntil = <E = never, R = never>(
  condition: WaitCondition<E, R>,
  what: string,
  timeout = 4_000,
) =>
  (Effect.isEffect(condition) ? condition : Effect.sync(condition)).pipe(
    Effect.repeat({ until: (ready) => ready, schedule: Schedule.spaced(20) }),
    Effect.timeoutOption(timeout),
    Effect.tap((ready) => Effect.sync(() => expect(Option.isSome(ready), what).toBe(true))),
    Effect.withSpan("waitUntil"),
  );
