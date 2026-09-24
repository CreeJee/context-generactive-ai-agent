import { Semaphore } from "effect";
import { Effect } from "effect";

/**
 * A small Effect-native equivalent of `p-limit(1)` keyed by resource id. Calls for the same key
 * are FIFO and mutually exclusive; different keys remain independent. Semaphore permits are
 * released by Effect on success, failure and interruption.
 *
 * A key is kept only while work is running or waiting for its permit. Interruption releases the
 * reference too, so historical session ids do not accumulate for the lifetime of the process.
 */
export function keyedSerialLimit() {
  const slots = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();

  return <A, E, R>(key: string, work: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        let slot = slots.get(key);
        if (!slot) {
          slot = { semaphore: Semaphore.makeUnsafe(1), users: 0 };
          slots.set(key, slot);
        }
        slot.users += 1;
        return slot;
      }),
      (slot) => slot.semaphore.withPermits(1)(work),
      (slot) =>
        Effect.sync(() => {
          slot.users -= 1;
          if (slot.users === 0 && slots.get(key) === slot) slots.delete(key);
        }),
    );
}
