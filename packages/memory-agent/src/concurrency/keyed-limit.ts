import { Effect, RcMap, Semaphore } from "effect";

/**
 * A small Effect-native equivalent of `p-limit(1)` keyed by resource id. Calls for the same key
 * are FIFO and mutually exclusive; different keys remain independent. Semaphore permits are
 * released by Effect on success, failure and interruption.
 *
 * A key is kept only while work is running or waiting for its permit. Interruption releases the
 * reference too, so historical session ids do not accumulate for the lifetime of the process.
 */
export const keyedSerialLimit = Effect.fnUntraced(function* () {
  const slots = yield* RcMap.make({ lookup: (_key: string) => Semaphore.make(1) });
  return <A, E, R>(key: string, work: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.scoped(Effect.flatMap(RcMap.get(slots, key), (slot) => slot.withPermit(work)));
});
