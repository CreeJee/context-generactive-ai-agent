/** Include a property only when its value is present, preserving exact optional types. */
// Fixed-arity application/SDK contract; these arguments are not a data-last collection API.
// @effect-diagnostics-next-line missingPipeableSignature:off
export function optionalProperty<K extends string, V>(
  key: K,
  value: V | undefined,
): Partial<Record<K, V>> {
  const result: Partial<Record<K, V>> = {};
  if (value !== undefined) result[key] = value;
  return result;
}
