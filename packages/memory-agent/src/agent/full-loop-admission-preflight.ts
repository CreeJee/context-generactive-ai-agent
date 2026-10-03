import { Schema } from "effect";

const TransportObject = Schema.declare<object>(
  // Representation parser at the descriptor boundary; excludes callable objects.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  (value): value is object => value !== null && typeof value === "object",
);

function reject(member: string, reason: string): never {
  throw new Error(`Unsupported worker member: ${member} (${reason})`);
}

/** Stricter than structuredClone: the RPC codec must not silently erase
 * functions, accessors, symbols, prototypes or cyclic values. Does not invoke getters. */
// Decoding a struct first would erase evidence at this descriptor boundary.
export function assertFullLoopPortable(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters
  value: unknown,
  member = "turn",
  stack = new Set<object>(),
): void {
  // Runtime representation inspection is the transport validation boundary.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  switch (typeof value) {
    case "undefined":
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) reject(member, "non-finite number");
      return;
    case "object":
      break;
    default:
      reject(member, "non-portable value");
  }
  if (value === null) return;
  const object = Schema.decodeUnknownSync(TransportObject)(value);
  if (stack.has(object)) reject(member, "cyclic value");
  if (
    !Array.isArray(object) &&
    Object.getPrototypeOf(object) !== Object.prototype &&
    Object.getPrototypeOf(object) !== null
  )
    reject(member, "unsupported prototype");
  stack.add(object);
  try {
    for (const key of Reflect.ownKeys(object)) {
      if (Array.isArray(object) && key === "length") continue;
      if (!Schema.is(Schema.String)(key)) reject(`${member}.${String(key)}`, "symbol member");
      const child = `${member}.${key}`;
      const descriptor = Object.getOwnPropertyDescriptor(object, key)!;
      if (!Object.hasOwn(descriptor, "value")) reject(child, "accessor");
      if (!descriptor.enumerable) reject(child, "non-enumerable member");
      assertFullLoopPortable(descriptor.value, child, stack);
    }
  } finally {
    stack.delete(object);
  }
}
