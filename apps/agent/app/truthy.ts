/** Preserves JavaScript truthiness while narrowing optional values in conditions. */
export function isTruthy<T>(value: T): value is Exclude<NonNullable<T>, false | 0 | 0n | ""> {
  return Boolean(value);
}
