import { Effect, Result, Function as EffectFunction } from "effect";
import { Base64 } from "effect/encoding";
import { isTruthy } from "../app/truthy.ts";
import { Predicate, Schema } from "effect";

export const releaseManifestSchemaVersion = 1;
export const ReleaseChannel = Schema.Literals(["stable", "prerelease"]);
export type ReleaseChannel = typeof ReleaseChannel.Type;

const Sha256 = Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/)));
const SemVer = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    ),
  ),
);

export const ReleaseAsset = Schema.Struct({
  name: Schema.String,
  url: Schema.String,
  size: Schema.Finite.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThan(0))),
  sha256: Sha256,
});
export type ReleaseAsset = typeof ReleaseAsset.Type;

export const ReleaseManifest = Schema.Struct({
  schemaVersion: Schema.Literal(releaseManifestSchemaVersion),
  version: SemVer,
  channel: ReleaseChannel,
  publishedAt: Schema.String,
  minUpdaterVersion: SemVer,
  database: Schema.Struct({
    target: Schema.Finite.pipe(
      Schema.check(Schema.isInt()),
      Schema.check(Schema.isGreaterThanOrEqualTo(0)),
    ),
    minimumReadable: Schema.Finite.pipe(
      Schema.check(Schema.isInt()),
      Schema.check(Schema.isGreaterThanOrEqualTo(0)),
    ),
    rollbackReadableThrough: Schema.Finite.pipe(
      Schema.check(Schema.isInt()),
      Schema.check(Schema.isGreaterThanOrEqualTo(0)),
    ),
  }),
  assets: Schema.Record(Schema.String, ReleaseAsset),
});
export type ReleaseManifest = typeof ReleaseManifest.Type;

export const ManifestSignature = Schema.Struct({
  keyId: Schema.String,
  signature: Schema.String,
});
export type ManifestSignature = typeof ManifestSignature.Type;

export interface ReleaseEnvelope {
  readonly manifest: ReleaseManifest;
  readonly signature: ManifestSignature;
}

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

/** Deterministic JSON for the manifest contract: sorted keys and JSON primitive encoding. */
export function canonicalJson(value: Json): string {
  if (value === null || Schema.is(Schema.Boolean)(value) || Schema.is(Schema.String)(value))
    return JSON.stringify(value);
  if (Schema.is(Schema.Finite)(value)) {
    if (!Number.isFinite(value))
      throw new Error("canonical JSON cannot contain a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

const encoder = new TextEncoder();
const unsigned = (manifest: ReleaseManifest) => encoder.encode(canonicalJson(manifest));

/** Why a release was not accepted: its signature, its trust anchor, or the update policy. */
export const ReleaseRejectedReason = Schema.TaggedUnion({
  UntrustedKey: { keyId: Schema.String },
  InvalidKey: { keyId: Schema.String, cause: Schema.Defect() },
  InvalidSignature: {},
  PrereleaseDisabled: {},
  NotNewer: {},
  UpdaterTooOld: { minimum: Schema.String },
  MissingAsset: { target: Schema.String },
  AssetNameMismatch: { target: Schema.String },
});
export type ReleaseRejectedReason = typeof ReleaseRejectedReason.Type;
const rejected = ReleaseRejectedReason.cases;

export class ReleaseRejected extends Schema.TaggedError<
  ReleaseRejected,
  { readonly brand: unique symbol }
>()("ReleaseRejected", {
  reason: ReleaseRejectedReason,
}) {}

export const ReleaseSigningFailedReason = Schema.TaggedUnion({
  InvalidKey: { cause: Schema.Defect() },
  SignFailed: { cause: Schema.Defect() },
});
export type ReleaseSigningFailedReason = typeof ReleaseSigningFailedReason.Type;
const signing = ReleaseSigningFailedReason.cases;

export class ReleaseSigningFailed extends Schema.TaggedError<
  ReleaseSigningFailed,
  { readonly brand: unique symbol }
>()("ReleaseSigningFailed", { reason: ReleaseSigningFailedReason }) {}

const ed25519 = { name: "Ed25519" } as const;

class ReleaseKeyInvalid extends Schema.TaggedError<
  ReleaseKeyInvalid,
  { readonly brand: unique symbol }
>()("ReleaseKeyInvalid", {
  cause: Schema.Defect(),
}) {}

// Keys keep the PEM spellings `generateKeyPairSync("ed25519")` exports: SPKI for trust anchors and
// PKCS#8 for the signing key. WebCrypto imports their DER bodies.
const publicPem = { label: "PUBLIC KEY", format: "spki", usage: "verify" } as const;
const privatePem = { label: "PRIVATE KEY", format: "pkcs8", usage: "sign" } as const;
const importPemKey = Effect.fnUntraced(function* (
  pem: string,
  key: typeof publicPem | typeof privatePem,
) {
  const block = new RegExp(
    `^-----BEGIN ${key.label}-----([A-Za-z0-9+/=\\s]*)-----END ${key.label}-----$`,
  ).exec(pem.trim());
  if (block === null)
    return yield* ReleaseKeyInvalid.make({ cause: `not a ${key.label} PEM block` });
  const der = yield* Effect.fromResult(Base64.decode((block[1] ?? "").replace(/\s+/g, ""))).pipe(
    Effect.mapError((cause) => ReleaseKeyInvalid.make({ cause })),
  );
  return yield* Effect.tryPromise({
    try: () =>
      crypto.subtle.importKey(key.format, new Uint8Array(der), ed25519, false, [key.usage]),
    catch: (cause) => ReleaseKeyInvalid.make({ cause }),
  });
});

export const signReleaseManifest: {
  (
    keyId: string,
    privateKey: string,
  ): (manifest: ReleaseManifest) => ReturnType<typeof signReleaseManifestBody>;
} & typeof signReleaseManifestBody = EffectFunction.dual(3, signReleaseManifestBody);
function signReleaseManifestBody(
  manifest: ReleaseManifest,
  keyId: string,
  privateKey: string,
): Effect.Effect<ManifestSignature, ReleaseSigningFailed> {
  return Effect.gen(function* () {
    const key = yield* importPemKey(privateKey, privatePem).pipe(
      Effect.mapError(({ cause }) =>
        ReleaseSigningFailed.make({ reason: signing.InvalidKey.make({ cause }) }),
      ),
    );
    const signature = yield* Effect.tryPromise({
      try: () => crypto.subtle.sign(ed25519, key, unsigned(manifest)),
      catch: (cause) => ReleaseSigningFailed.make({ reason: signing.SignFailed.make({ cause }) }),
    });
    return { keyId, signature: Base64.encode(new Uint8Array(signature)) };
  });
}

export const verifyManifestSignature: {
  (
    signature: ManifestSignature,
    trustedKeys: Readonly<Record<string, string>>,
  ): (manifest: ReleaseManifest) => ReturnType<typeof verifyManifestSignatureBody>;
} & typeof verifyManifestSignatureBody = EffectFunction.dual(3, verifyManifestSignatureBody);
function verifyManifestSignatureBody(
  manifest: ReleaseManifest,
  signature: ManifestSignature,
  trustedKeys: Readonly<Record<string, string>>,
): Effect.Effect<void, ReleaseRejected> {
  return Effect.gen(function* () {
    const { keyId } = signature;
    const publicKey = trustedKeys[keyId];
    if (!isTruthy(publicKey))
      return yield* ReleaseRejected.make({ reason: rejected.UntrustedKey.make({ keyId }) });
    const key = yield* importPemKey(publicKey, publicPem).pipe(
      Effect.mapError(({ cause }) =>
        ReleaseRejected.make({ reason: rejected.InvalidKey.make({ keyId, cause }) }),
      ),
    );
    // Preserve Node's accepted unpadded/base64url/whitespace input; Base64.decode is stricter.
    const bytes = Buffer.from(signature.signature, "base64");
    const valid = yield* Effect.tryPromise({
      try: () => crypto.subtle.verify(ed25519, key, bytes, unsigned(manifest)),
      catch: () => ReleaseRejected.make({ reason: rejected.InvalidSignature.make({}) }),
    });
    if (!valid) return yield* ReleaseRejected.make({ reason: rejected.InvalidSignature.make({}) });
  });
}

interface ParsedVersion {
  readonly core: readonly [number, number, number];
  readonly prerelease: readonly string[];
}

function parseVersion(version: string): ParsedVersion {
  // Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
  const valid = EffectFunction.flow(Schema.decodeResult(SemVer), Result.getOrThrow)(version);
  const withoutBuild = valid.split("+", 1)[0]!;
  const [core, suffix] = withoutBuild.split("-", 2);
  const [major, minor, patch] = core!.split(".").map(Number);
  return {
    core: [major!, minor!, patch!],
    prerelease: suffix === undefined ? [] : suffix.split("."),
  };
}

/** SemVer precedence, ignoring build metadata. */
export const compareVersions: {
  (right: string): (left: string) => ReturnType<typeof compareVersionsBody>;
} & typeof compareVersionsBody = EffectFunction.dual(2, compareVersionsBody);
function compareVersionsBody(left: string, right: string) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < a.core.length; index++) {
    const compared = a.core[index]! - b.core[index]!;
    if (compared !== 0) return Math.sign(compared);
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0)
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index++) {
    const aa = a.prerelease[index];
    const bb = b.prerelease[index];
    if (aa === undefined || bb === undefined) return aa === bb ? 0 : aa === undefined ? -1 : 1;
    if (aa === bb) continue;
    const an = /^(0|[1-9]\d*)$/.test(aa) ? Number(aa) : null;
    const bn = /^(0|[1-9]\d*)$/.test(bb) ? Number(bb) : null;
    if (an !== null && bn !== null) return an < bn ? -1 : 1;
    if (an !== null || bn !== null) return an !== null ? -1 : 1;
    return aa < bb ? -1 : 1;
  }
  return 0;
}

export const releaseAssetName: {
  (target: string): (version: string) => ReturnType<typeof releaseAssetNameBody>;
} & typeof releaseAssetNameBody = EffectFunction.dual(2, releaseAssetNameBody);
function releaseAssetNameBody(version: string, target: string) {
  // Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
  const normalized = EffectFunction.flow(
    Schema.decodeResult(SemVer),
    Result.getOrThrow,
  )(version.replace(/^v/, ""));
  const extension = target.startsWith("win32-") ? "zip" : "tar.gz";
  return `context-agent-v${normalized}-${target}.${extension}`;
}

export interface UpdateDecisionOptions {
  readonly currentVersion: string;
  readonly updaterVersion: string;
  readonly target: string;
  readonly allowPrerelease?: boolean;
  readonly allowDowngrade?: boolean;
}

/** Verifies trust and policy before returning the exact platform asset that may be downloaded. */
export const acceptRelease: {
  (
    trustedKeys: Readonly<Record<string, string>>,
    options: UpdateDecisionOptions,
  ): (envelope: ReleaseEnvelope) => ReturnType<typeof acceptReleaseBody>;
} & typeof acceptReleaseBody = EffectFunction.dual(3, acceptReleaseBody);
function acceptReleaseBody(
  envelope: ReleaseEnvelope,
  trustedKeys: Readonly<Record<string, string>>,
  options: UpdateDecisionOptions,
): Effect.Effect<ReleaseAsset, ReleaseRejected | Schema.SchemaError> {
  return Effect.gen(function* () {
    const manifest = yield* Schema.decodeEffect(ReleaseManifest)(envelope.manifest);
    const signature = yield* Schema.decodeEffect(ManifestSignature)(envelope.signature);
    yield* verifyManifestSignature(manifest, signature, trustedKeys);
    if (manifest.channel === "prerelease" && !(options.allowPrerelease === true))
      return yield* ReleaseRejected.make({ reason: rejected.PrereleaseDisabled.make({}) });
    const decodeVersion = Schema.decodeEffect(SemVer);
    if (
      !(options.allowDowngrade === true) &&
      compareVersions(manifest.version, yield* decodeVersion(options.currentVersion)) <= 0
    )
      return yield* ReleaseRejected.make({ reason: rejected.NotNewer.make({}) });
    if (
      compareVersions(yield* decodeVersion(options.updaterVersion), manifest.minUpdaterVersion) < 0
    )
      return yield* ReleaseRejected.make({
        reason: rejected.UpdaterTooOld.make({ minimum: manifest.minUpdaterVersion }),
      });
    const { target } = options;
    const asset = manifest.assets[target];
    if (!Predicate.isNotNullish(asset))
      return yield* ReleaseRejected.make({ reason: rejected.MissingAsset.make({ target }) });
    if (asset.name !== releaseAssetName(manifest.version, target))
      return yield* ReleaseRejected.make({ reason: rejected.AssetNameMismatch.make({ target }) });
    return asset;
  });
}
