import { Data, Function as EffectFunction, Match, Option, Result, Schema } from "effect";
import { sha256 } from "../runtime/synchronous-crypto.ts";
import type { JsonValue } from "../json.ts";

/** The owner ledger's JSON: what its fingerprints were computed over. */
type OwnerRpcJson = JsonValue;

const Digest = Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/)));
const Compact = Schema.TaggedStruct("OwnerRpcFingerprintV1", {
  algorithm: Schema.Literal("sha256"),
  canonicalization: Schema.Literal("owner-rpc-json-v1"),
  digest: Digest,
  operation: Schema.String,
  input: Schema.Json,
  // The Goal worker kept the hook of a middleware call too large to keep whole.
  inputKind: Schema.Literals(["complete", "middleware-hook", "omitted"]),
});
const Descriptor = Schema.Struct({ operation: Schema.String, input: Schema.Json });
type Evidence = Data.TaggedEnum<{
  complete: { readonly input: OwnerRpcJson };
  omitted: { readonly input: null };
}>;
const Evidence = Data.taggedEnum<Evidence>();
const evidenceKind = Evidence.$match({
  complete: () => "complete" as const,
  omitted: () => "omitted" as const,
});
// Covers a bounded 32-report read request as well as ordinary call arguments.
const evidenceLimit = 16384;

/** A request value that has no canonical JSON form, or a legacy fingerprint no longer readable. */
export class OwnerRpcFingerprintFailed extends Schema.TaggedError<OwnerRpcFingerprintFailed>()(
  "OwnerRpcFingerprintFailed",
  { reason: Schema.Literals(["non_finite", "non_json", "unsupported_legacy"]) },
) {}
// Fingerprints are computed synchronously inside the ledger's SQLite boundary.
const fail = (reason: OwnerRpcFingerprintFailed["reason"]): never => {
  throw OwnerRpcFingerprintFailed.make({ reason });
};

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
      if (!Number.isFinite(value)) return fail("non_finite");
      return JSON.stringify(value);
    case "object":
      if (Array.isArray(value)) return `[${value.map(ownerRpcCanonicalJson).join(",")}]`;
      return `{${Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => `${JSON.stringify(key)}:${ownerRpcCanonicalJson(entry)}`)
        .join(",")}}`;
    default:
      return fail("non_json");
  }
}

const isList = (value: JsonValue): value is ReadonlyArray<JsonValue> => Array.isArray(value);

/**
 * A value in the frame the Goal worker's codec sent it in, which ledger rows keep their input in
 * (`invocationFieldSql` reads it).
 */
export const ownerRpcFrame = (value: JsonValue): JsonValue =>
  Match.value(value).pipe(
    Match.when(Match.null, (): JsonValue => ["null"]),
    Match.when(Match.boolean, (flag): JsonValue => ["boolean", flag]),
    Match.when(Match.number, (number): JsonValue => ["number", number]),
    Match.when(Match.string, (text): JsonValue => ["string", text]),
    Match.when(isList, (items): JsonValue => ["array", items.map(ownerRpcFrame)]),
    Match.orElse((fields): JsonValue => [
      "object",
      Object.entries(fields).map(([key, field]): JsonValue => [key, ownerRpcFrame(field)]),
    ]),
  );

function encodeFingerprint(operation: string, canonical: string, evidence: Evidence): string {
  return JSON.stringify(
    Compact.make({
      algorithm: "sha256",
      canonicalization: "owner-rpc-json-v1",
      digest: sha256(canonical),
      operation,
      input: evidence.input,
      inputKind: evidenceKind(evidence),
    }),
  );
}

/** Full request bytes are hashed; only bounded diagnostic evidence is retained. */
function fingerprintBody(operation: string, input: OwnerRpcJson): string {
  const canonical = ownerRpcCanonicalJson({ operation, input });
  const evidence: Evidence =
    canonical.length <= evidenceLimit
      ? Evidence.complete({ input })
      : Evidence.omitted({ input: null });
  return encodeFingerprint(operation, canonical, evidence);
}
export const ownerRpcFingerprint: {
  (input: OwnerRpcJson): (operation: string) => string;
} & typeof fingerprintBody = EffectFunction.dual(2, fingerprintBody);

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
    return encodeFingerprint(
      descriptor.operation,
      fingerprint,
      Evidence.complete({ input: descriptor.input }),
    );
  }
  // Legacy production bytes sort input before operation. Extract only the suffix,
  // avoiding a second 100+ MiB JSON tree when converting historical context snapshots.
  const suffix = /,"operation":("(?:[^"\\]|\\.)*")\}$/u.exec(fingerprint.slice(-evidenceLimit));
  if (!fingerprint.startsWith('{"input":') || suffix?.[1] === undefined)
    return fail("unsupported_legacy");
  const operation = Result.getOrThrow(
    Schema.decodeResult(Schema.fromJsonString(Schema.String))(suffix[1]),
  );
  return encodeFingerprint(operation, fingerprint, Evidence.omitted({ input: null }));
}
