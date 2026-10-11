import { Function as EffectFunction, Option, Result, Schema } from "effect";
import { sha256 } from "../runtime/synchronous-crypto.ts";
import type { OwnerRpcJson } from "./owner-rpc.ts";

const Digest = Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/)));
const Compact = Schema.TaggedStruct("OwnerRpcFingerprintV1", {
  algorithm: Schema.Literal("sha256"),
  canonicalization: Schema.Literal("owner-rpc-json-v1"),
  digest: Digest,
  operation: Schema.String,
  input: Schema.Json,
  inputKind: Schema.Literals(["complete", "middleware-hook", "omitted"]),
});
const Descriptor = Schema.Struct({ operation: Schema.String, input: Schema.Json });
type Evidence =
  | { readonly _tag: "complete"; readonly input: OwnerRpcJson }
  | { readonly _tag: "middleware-hook"; readonly input: OwnerRpcJson }
  | { readonly _tag: "omitted"; readonly input: null };
// Covers the bounded 32-report recovery request as well as ordinary read evidence.
const evidenceLimit = 16384;

/** The existing canonical byte contract, including key ordering and finite numbers. */
export function ownerRpcCanonicalJson(value: OwnerRpcJson): string {
  if (value === null) return "null";
  // Primitive discrimination belongs to this JSON serialization boundary.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  switch (typeof value) {
    case "boolean":
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new Error("Non-finite RPC number");
      return JSON.stringify(value);
    case "object":
      if (Array.isArray(value)) return `[${value.map(ownerRpcCanonicalJson).join(",")}]`;
      return `{${Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => `${JSON.stringify(key)}:${ownerRpcCanonicalJson(entry)}`)
        .join(",")}}`;
    default:
      throw new Error("Non-JSON RPC value");
  }
}

function middlewareEvidence(input: OwnerRpcJson): Evidence {
  // Inspect only the top-level tagged wire fields; do not decode the full SDK context.
  if (Array.isArray(input) && input[0] === "object" && Array.isArray(input[1])) {
    const fields = input[1].filter(
      (field) => Array.isArray(field) && (field[0] === "index" || field[0] === "hook"),
    );
    const selected: OwnerRpcJson = ["object", fields];
    if (ownerRpcCanonicalJson(selected).length <= evidenceLimit)
      return { _tag: "middleware-hook", input: selected };
  }
  return { _tag: "omitted", input: null };
}

function encodeFingerprint(operation: string, canonical: string, evidence: Evidence): string {
  return JSON.stringify({
    _tag: "OwnerRpcFingerprintV1",
    algorithm: "sha256",
    canonicalization: "owner-rpc-json-v1",
    digest: sha256(canonical),
    operation,
    input: evidence.input,
    inputKind: evidence._tag,
  });
}

/** Full request bytes are hashed; only bounded diagnostic/recovery evidence is retained. */
function fingerprintBody(operation: string, input: OwnerRpcJson): string {
  const canonical = ownerRpcCanonicalJson({ operation, input });
  const evidence: Evidence =
    canonical.length <= evidenceLimit
      ? { _tag: "complete", input }
      : operation === "middleware"
        ? middlewareEvidence(input)
        : { _tag: "omitted", input: null };
  return encodeFingerprint(operation, canonical, evidence);
}
export const ownerRpcFingerprint: {
  (input: OwnerRpcJson): (operation: string) => string;
} & typeof fingerprintBody = EffectFunction.dual(2, fingerprintBody);

/** Legacy request JSON remains comparable without rewriting an operational database. */
export function ownerRpcFingerprintDigest(fingerprint: string): string {
  if (fingerprint.length > evidenceLimit + 1024) return sha256(fingerprint);
  const compact = Schema.decodeOption(Schema.fromJsonString(Compact))(fingerprint);
  return Option.isSome(compact) ? compact.value.digest : sha256(fingerprint);
}

/** Explicit offline conversion, never an automatic startup backfill. */
export function compactLegacyOwnerRpcFingerprint(fingerprint: string): string {
  if (fingerprint.length <= evidenceLimit + 1024) {
    const compact = Schema.decodeOption(Schema.fromJsonString(Compact))(fingerprint);
    if (Option.isSome(compact)) return fingerprint;
  }
  if (fingerprint.length <= evidenceLimit) {
    const descriptor = Result.getOrThrow(
      Schema.decodeResult(Schema.fromJsonString(Descriptor))(fingerprint),
    );
    return encodeFingerprint(descriptor.operation, fingerprint, {
      _tag: "complete",
      input: descriptor.input,
    });
  }
  // Legacy production bytes sort input before operation. Extract only the suffix,
  // avoiding a second 100+ MiB JSON tree when converting historical context snapshots.
  const suffix = /,"operation":("(?:[^"\\]|\\.)*")\}$/u.exec(fingerprint.slice(-evidenceLimit));
  if (!fingerprint.startsWith('{"input":') || suffix?.[1] === undefined)
    throw new Error("Unsupported legacy owner RPC fingerprint");
  const operation = Result.getOrThrow(
    Schema.decodeResult(Schema.fromJsonString(Schema.String))(suffix[1]),
  );
  return encodeFingerprint(operation, fingerprint, { _tag: "omitted", input: null });
}
