import { Effect } from "effect";

/**
 * A small Effect-native equivalent of `p-limit(1)` keyed by resource id. Calls for the same key
 * are FIFO and mutually exclusive; different keys remain independent. Semaphore permits are
 * released by Effect on success, failure and interruption.
 *
 * The map is intentionally service-scoped. Keys are session/project ids, whose cardinality is
 * already bounded by the lifetime of the app process.
 */
export function keyedSerialLimit() {
  const semaphores = new Map<string, Effect.Semaphore>();

  return <A, E, R>(key: string, work: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      let semaphore = semaphores.get(key);
      if (!semaphore) {
        semaphore = Effect.unsafeMakeSemaphore(1);
        semaphores.set(key, semaphore);
      }
      return semaphore.withPermits(1)(work);
    });
}
