import { Result, Function as EffectFunction } from "effect";
import { isTruthy } from "../truthy.ts";
import { Schema } from "effect";

const TransportObject = Schema.declare<object>(
  // Representation parser at the descriptor boundary; excludes callable objects.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  (value): value is object => value !== null && typeof value === "object",
);

export class FullLoopAdmissionRejected extends Schema.TaggedError<FullLoopAdmissionRejected>()(
  "FullLoopAdmissionRejected",
  {
    member: Schema.String,
    reason: Schema.Union([
      Schema.TaggedStruct("NonFinite", {}),
      Schema.TaggedStruct("NonPortable", {}),
      Schema.TaggedStruct("Cyclic", {}),
      Schema.TaggedStruct("UnsupportedPrototype", {}),
      Schema.TaggedStruct("SymbolMember", {}),
      Schema.TaggedStruct("Accessor", {}),
      Schema.TaggedStruct("NonEnumerable", {}),
      Schema.TaggedStruct("MissingMember", {}),
      Schema.TaggedStruct("NotCallable", {}),
      Schema.TaggedStruct("UnsupportedTool", {}),
    ]),
  },
) {
  override get message() {
    switch (this.reason._tag) {
      case "Accessor":
        return `Unsupported owner snapshot accessor: ${this.member}`;
      case "MissingMember":
        return `Missing owner member: ${this.member}`;
      case "NotCallable":
        return `Unsupported owner callable: ${this.member}`;
      case "UnsupportedTool":
        return `Unsupported owner tool grant capability: ${this.member}`;
      default:
        return `Unsupported worker member: ${this.member} (${this.reason._tag})`;
    }
  }
}

function reject(member: string, reason: FullLoopAdmissionRejected["reason"]["_tag"]): never {
  throw FullLoopAdmissionRejected.make({ member, reason: { _tag: reason } });
}

/** Stricter than structuredClone: the RPC codec must not silently erase
 * functions, accessors, symbols, prototypes or cyclic values. Does not invoke getters. */
// Decoding a struct first would erase evidence at this descriptor boundary.
export function assertFullLoopPortable(options: {
  readonly value: unknown;
  readonly member?: string;
}): void {
  validatePortable(options.value, options.member ?? "turn", []);
}

// Descriptor validation is a synchronous SDK transport boundary; no getters are evaluated.
function validatePortable(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters
  value: unknown,
  member: string,
  stack: readonly object[],
): void {
  // Runtime representation inspection is the transport validation boundary.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  switch (typeof value) {
    case "undefined":
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) reject(member, "NonFinite");
      return;
    case "object":
      break;
    default:
      reject(member, "NonPortable");
  }
  if (value === null) return;
  // Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
  const object = EffectFunction.flow(
    Schema.decodeResult(TransportObject),
    Result.getOrThrow,
  )(value);
  if (stack.includes(object)) reject(member, "Cyclic");
  if (
    !Array.isArray(object) &&
    Object.getPrototypeOf(object) !== Object.prototype &&
    Object.getPrototypeOf(object) !== null
  )
    reject(member, "UnsupportedPrototype");
  const nextStack = [...stack, object];
  {
    for (const key of Reflect.ownKeys(object)) {
      if (Array.isArray(object) && key === "length") continue;
      if (!Schema.is(Schema.String)(key)) reject(`${member}.${String(key)}`, "SymbolMember");
      const child = `${member}.${key}`;
      const descriptor = Object.getOwnPropertyDescriptor(object, key)!;
      if (!Object.hasOwn(descriptor, "value")) reject(child, "Accessor");
      if (!isTruthy(descriptor.enumerable)) reject(child, "NonEnumerable");
      validatePortable(descriptor.value, child, nextStack);
    }
  }
}
