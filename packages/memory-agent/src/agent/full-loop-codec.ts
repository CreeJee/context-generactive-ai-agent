// Primitive representation checks below are the JSON codec boundary parser,
// not domain decisions. The owner endpoint separately validates authority.
/* oxlint-disable anti-slop/no-runtime-typeof */
// Every node is tagged, so application objects cannot spoof a Map/Error marker.
// Functions are never transported. Live hooks/tools/definition factories remain
// owner capabilities and are rebuilt explicitly by the worker protocol.
type FullLoopFrame =
  | ["undefined"]
  | ["null"]
  | ["boolean", boolean]
  | ["number", number]
  | ["string", string]
  | ["error", string, string]
  | ["map", [FullLoopFrame, FullLoopFrame][]]
  | ["set" | "array", FullLoopFrame[]]
  | ["object", [string, FullLoopFrame][]];
type DecodedFullLoopValue =
  | undefined
  | null
  | boolean
  | number
  | string
  | Error
  | Map<DecodedFullLoopValue, DecodedFullLoopValue>
  | Set<DecodedFullLoopValue>
  | DecodedFullLoopValue[]
  | { [key: string]: DecodedFullLoopValue };
// SDK values are parsed into the tagged wire tree here.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
export function encodeFullLoopValue(value: unknown): FullLoopFrame {
  if (value === undefined) return ["undefined"];
  if (value === null) return ["null"];
  if (value instanceof Error) return ["error", value.name, value.message];
  if (value instanceof Map)
    return [
      "map",
      [...value].map(([key, entry]) => [encodeFullLoopValue(key), encodeFullLoopValue(entry)]),
    ];
  if (value instanceof Set) return ["set", [...value].map(encodeFullLoopValue)];
  if (Array.isArray(value)) return ["array", value.map(encodeFullLoopValue)];
  switch (typeof value) {
    case "boolean":
      return ["boolean", value];
    case "number":
      if (!Number.isFinite(value)) throw new Error("Non-finite worker value");
      return ["number", value];
    case "string":
      return ["string", value];
    case "object":
      return [
        "object",
        Object.entries(value)
          .filter(([, entry]) => !(entry instanceof Function))
          .map(([key, entry]) => [key, encodeFullLoopValue(entry)]),
      ];
    default:
      throw new Error("Non-portable worker value");
  }
}
// The decoded SDK value's domain contract is established by each owner handler.
export function decodeFullLoopValue(
  frame: import("./owner-rpc.ts").OwnerRpcJson,
): DecodedFullLoopValue {
  if (!Array.isArray(frame)) throw new Error("Invalid worker value frame");
  // SAFETY: this is the tagged JSON parser; the switch checks primitives and
  // recursively parses collection entries. Malformed collections throw at this boundary.
  const parsed = frame as FullLoopFrame;
  const [tag, value] = parsed;
  switch (tag) {
    case "undefined":
      return undefined;
    case "null":
      return null;
    case "boolean":
      if (typeof value !== "boolean") throw new Error("Invalid boolean frame");
      return value;
    case "number":
      if (!Number.isFinite(value)) throw new Error("Invalid number frame");
      return value;
    case "string":
      if (typeof value !== "string") throw new Error("Invalid string frame");
      return value;
    case "error": {
      const error = new Error(parsed[2]);
      error.name = value;
      return error;
    }
    case "map":
      return new Map(
        value.map(([key, entry]) => [decodeFullLoopValue(key), decodeFullLoopValue(entry)]),
      );
    case "set":
      return new Set(value.map(decodeFullLoopValue));
    case "array":
      return value.map(decodeFullLoopValue);
    case "object":
      return Object.fromEntries(value.map(([key, entry]) => [key, decodeFullLoopValue(entry)]));
    default:
      throw new Error("Invalid worker value tag");
  }
}
