import { Result, Function as EffectFunction } from "effect";
import { isTruthy } from "../truthy.ts";
import { Schema } from "effect";

const TransportObject = Schema.declare<object>(
  // Representation parser at the descriptor boundary; excludes callable objects.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  (value): value is object => value !== null && typeof value === "object",
);

export const FullLoopAdmissionReason = Schema.TaggedUnion({
  NonFinite: {},
  NonPortable: {},
  Cyclic: {},
  UnsupportedPrototype: {},
  SymbolMember: {},
  Accessor: {},
  NonEnumerable: {},
  MissingMember: {},
  NotCallable: {},
  UnsupportedTool: {},
  /** A resumed turn without owner persistence to validate the resumed responses. */
  ContinuationWithoutPersistence: {},
  /** A middleware requires a capability no other middleware provides. */
  UnprovidedCapability: {},
  /** A middleware member is not a hook the worker can relay. */
  UnsupportedMiddlewareMember: {},
  /** The turn, an interrupt definition or a tool description did not clone for the worker. */
  NotCloneable: {},
});
export type FullLoopAdmissionReasonName = keyof typeof FullLoopAdmissionReason.cases;

/** The reason's name, as a response `detail` or a message shows it. */
export const fullLoopAdmissionReasonName: (
  reason: typeof FullLoopAdmissionReason.Type,
) => FullLoopAdmissionReasonName = FullLoopAdmissionReason.match({
  NonFinite: () => "NonFinite",
  NonPortable: () => "NonPortable",
  Cyclic: () => "Cyclic",
  UnsupportedPrototype: () => "UnsupportedPrototype",
  SymbolMember: () => "SymbolMember",
  Accessor: () => "Accessor",
  NonEnumerable: () => "NonEnumerable",
  MissingMember: () => "MissingMember",
  NotCallable: () => "NotCallable",
  UnsupportedTool: () => "UnsupportedTool",
  ContinuationWithoutPersistence: () => "ContinuationWithoutPersistence",
  UnprovidedCapability: () => "UnprovidedCapability",
  UnsupportedMiddlewareMember: () => "UnsupportedMiddlewareMember",
  NotCloneable: () => "NotCloneable",
});

export class FullLoopAdmissionRejected extends Schema.TaggedError<FullLoopAdmissionRejected>()(
  "FullLoopAdmissionRejected",
  {
    member: Schema.String,
    reason: FullLoopAdmissionReason,
  },
) {
  override get message() {
    return FullLoopAdmissionReason.matchOrElse(
      this.reason,
      {
        Accessor: () => `Unsupported owner snapshot accessor: ${this.member}`,
        MissingMember: () => `Missing owner member: ${this.member}`,
        NotCallable: () => `Unsupported owner callable: ${this.member}`,
        UnsupportedTool: () => `Unsupported owner tool grant capability: ${this.member}`,
        ContinuationWithoutPersistence: () => "Worker continuation requires owner persistence",
        UnprovidedCapability: () => `Unprovided owner middleware capability: ${this.member}`,
        UnsupportedMiddlewareMember: () => `Unsupported worker middleware member: ${this.member}`,
      },
      (other) =>
        `Unsupported worker member: ${this.member} (${fullLoopAdmissionReasonName(other)})`,
    );
  }
}

export const reject: {
  (reason: FullLoopAdmissionReasonName): (member: string) => never;
} & typeof rejectBody = EffectFunction.dual(2, rejectBody);
function rejectBody(member: string, reason: FullLoopAdmissionReasonName): never {
  throw FullLoopAdmissionRejected.make({
    member,
    reason: FullLoopAdmissionReason.cases[reason].make({}),
  });
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
