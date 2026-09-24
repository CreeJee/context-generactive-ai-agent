/** Include a property only when its value is present, preserving exact optional types. */
export function optionalProperty<K extends string, V>(
  key: K,
  value: V | undefined,
): Partial<Record<K, V>> {
  const result: Partial<Record<K, V>> = {};
  if (value !== undefined) result[key] = value;
  return result;
}
