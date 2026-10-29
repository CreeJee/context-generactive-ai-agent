import { MutableHashMap, Option } from "effect";

/**
 * Makes one value per key and keeps it for the page's life, as the kept-alive views in it are.
 * `Atom.family` keeps only a weak reference to what it makes, which suits one atom the registry
 * holds; a group of atoms is held by nothing. A garbage collection would drop such a group, and the
 * next render would get new atoms: an empty view, and an `open` that reads the session again from
 * the start, so the whole conversation blinks while an answer streams.
 */
export const keptAtomGroups = <K, A>(make: (key: K) => A) => {
  const made = MutableHashMap.empty<K, A>();
  return (key: K): A =>
    Option.getOrElse(MutableHashMap.get(made, key), () => {
      const value = make(key);
      MutableHashMap.set(made, key, value);
      return value;
    });
};
