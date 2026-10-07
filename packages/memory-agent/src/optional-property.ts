import { Function as EffectFunction } from "effect";
/** Include a property only when its value is present, preserving exact optional types. */
export const optionalProperty: {
  <K extends string, V>(
    value: V | undefined,
  ): (key: K) => ReturnType<typeof optionalPropertyBody<K, V>>;
} & typeof optionalPropertyBody = EffectFunction.dual(2, optionalPropertyBody);
function optionalPropertyBody<K extends string, V>(
  key: K,
  value: V | undefined,
): Partial<Record<K, V>> {
  const result: Partial<Record<K, V>> = {};
  if (value !== undefined) result[key] = value;
  return result;
}
