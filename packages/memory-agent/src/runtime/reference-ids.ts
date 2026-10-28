import { MutableRef, Option } from "effect";

/** Reference-only SDK keys are interned locally; Effect collections store their numeric IDs. */
export function referenceIds<Key extends object>() {
  const ids = new WeakMap<Key, number>();
  const sequence = MutableRef.make(0);
  return (key: Key): number =>
    Option.getOrElse(Option.fromUndefinedOr(ids.get(key)), () => {
      const id = MutableRef.getAndIncrement(sequence);
      ids.set(key, id);
      return id;
    });
}
