import { Effect, Option, Schedule } from "effect";
import { expect } from "vite-plus/test";

/** Observe SDK state with a wait that belongs to the calling test's Fiber. */
export const waitUntil = Effect.fn("waitUntil")(
  (condition: () => boolean, what: string, timeout = 4_000) =>
    Effect.sync(condition).pipe(
      Effect.repeat({ until: (ready) => ready, schedule: Schedule.spaced(20) }),
      Effect.timeoutOption(timeout),
      Effect.tap((ready) => Effect.sync(() => expect(Option.isSome(ready), what).toBe(true))),
    ),
);
