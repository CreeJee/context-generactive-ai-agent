import { Effect } from "effect";

/** Builds run tools inside a span, as a chat run does, so they have a run trace to join. */
export const inRun = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.withSpan(effect, "test.run");
