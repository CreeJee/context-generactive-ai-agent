import { sign, verify } from "node:crypto";
import { Schema } from "effect";

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

export const decodeReleaseManifest = Schema.decodeSync(ReleaseManifest);
export const decodeManifestSignature = Schema.decodeSync(ManifestSignature);

const unsigned = (manifest: ReleaseManifest) => Buffer.from(canonicalJson(manifest), "utf8");

export function signReleaseManifest(
  manifest: ReleaseManifest,
  keyId: string,
  privateKey: string,
): ManifestSignature {
  return { keyId, signature: sign(null, unsigned(manifest), privateKey).toString("base64") };
}

export function verifyManifestSignature(
  manifest: ReleaseManifest,
  signature: ManifestSignature,
  trustedKeys: Readonly<Record<string, string>>,
) {
  const publicKey = trustedKeys[signature.keyId];
  if (!publicKey) throw new Error(`untrusted release key: ${signature.keyId}`);
  const bytes = Buffer.from(signature.signature, "base64");
  if (!verify(null, unsigned(manifest), publicKey, bytes))
    throw new Error("release manifest signature is invalid");
}

interface ParsedVersion {
  readonly core: readonly [number, number, number];
  readonly prerelease: readonly string[];
}

function parseVersion(version: string): ParsedVersion {
  const valid = Schema.decodeSync(SemVer)(version);
  const withoutBuild = valid.split("+", 1)[0]!;
  const [core, suffix] = withoutBuild.split("-", 2);
  const [major, minor, patch] = core!.split(".").map(Number);
  return {
    core: [major!, minor!, patch!],
    prerelease: suffix === undefined ? [] : suffix.split("."),
  };
}

/** SemVer precedence, ignoring build metadata. */
export function compareVersions(left: string, right: string) {
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

export function releaseAssetName(version: string, target: string) {
  const normalized = Schema.decodeSync(SemVer)(version.replace(/^v/, ""));
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
export function acceptRelease(
  envelope: ReleaseEnvelope,
  trustedKeys: Readonly<Record<string, string>>,
  options: UpdateDecisionOptions,
): ReleaseAsset {
  const manifest = decodeReleaseManifest(envelope.manifest);
  const signature = decodeManifestSignature(envelope.signature);
  verifyManifestSignature(manifest, signature, trustedKeys);
  if (manifest.channel === "prerelease" && !options.allowPrerelease)
    throw new Error("prerelease channel is not enabled");
  if (!options.allowDowngrade && compareVersions(manifest.version, options.currentVersion) <= 0)
    throw new Error("release is not newer than the installed version");
  if (compareVersions(options.updaterVersion, manifest.minUpdaterVersion) < 0)
    throw new Error(`updater ${manifest.minUpdaterVersion} or newer is required`);
  const asset = manifest.assets[options.target];
  if (!asset) throw new Error(`release has no asset for ${options.target}`);
  if (asset.name !== releaseAssetName(manifest.version, options.target))
    throw new Error(`release asset name does not match ${options.target}`);
  return asset;
}
