/** Reference-only SDK keys are interned locally; Effect collections store their numeric IDs. */
export function referenceIds<Key extends object>() {
  const ids = new WeakMap<Key, number>();
  let sequence = 0;
  return (key: Key): number => {
    const existing = ids.get(key);
    if (existing !== undefined) return existing;
    const id = sequence++;
    ids.set(key, id);
    return id;
  };
}
