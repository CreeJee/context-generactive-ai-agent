import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "vite-plus/test";
import {
  acceptRelease,
  canonicalJson,
  compareVersions,
  releaseAssetName,
  signReleaseManifest,
  type ReleaseManifest,
} from "./release-contract";

const keys = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const manifest = (version = "1.2.0"): ReleaseManifest => ({
  schemaVersion: 1,
  version,
  channel: "stable",
  publishedAt: "2026-09-21T00:00:00.000Z",
  minUpdaterVersion: "1.0.0",
  database: { target: 7, minimumReadable: 6, rollbackReadableThrough: 7 },
  assets: {
    "darwin-arm64": {
      name: releaseAssetName(version, "darwin-arm64"),
      url: `https://github.com/CreeJee/context-agent/releases/download/v${version}/context-agent-v${version}-darwin-arm64.tar.gz`,
      size: 123,
      sha256: "a".repeat(64),
    },
  },
});

const signed = (value: ReleaseManifest) => ({
  manifest: value,
  signature: signReleaseManifest(value, "release-2026", keys.privateKey),
});

const options = {
  currentVersion: "1.1.0",
  updaterVersion: "1.0.0",
  target: "darwin-arm64",
};

const trusted = { "release-2026": keys.publicKey };

describe("release contract", () => {
  test("canonicalizes object keys and defines deterministic asset names", () => {
    expect(canonicalJson({ z: 1, a: { y: true, x: "value" } })).toBe(
      '{"a":{"x":"value","y":true},"z":1}',
    );
    expect(releaseAssetName("v1.2.3", "darwin-arm64")).toBe(
      "context-agent-v1.2.3-darwin-arm64.tar.gz",
    );
    expect(releaseAssetName("1.2.3", "win32-x64")).toBe("context-agent-v1.2.3-win32-x64.zip");
  });

  test("accepts a signed newer release for the selected target", () => {
    expect(acceptRelease(signed(manifest()), trusted, options).size).toBe(123);
  });

  test("rejects manifest tampering and unknown signing keys", () => {
    const envelope = signed(manifest());
    expect(() =>
      acceptRelease(
        { ...envelope, manifest: { ...envelope.manifest, version: "1.3.0" } },
        trusted,
        options,
      ),
    ).toThrow("signature is invalid");
    expect(() => acceptRelease(envelope, {}, options)).toThrow("untrusted release key");
  });

  test("rejects downgrade, insufficient updater, prerelease and mismatched asset names", () => {
    expect(() => acceptRelease(signed(manifest("1.0.0")), trusted, options)).toThrow("not newer");
    expect(() =>
      acceptRelease(signed({ ...manifest(), minUpdaterVersion: "2.0.0" }), trusted, options),
    ).toThrow("or newer is required");
    expect(() =>
      acceptRelease(signed({ ...manifest(), channel: "prerelease" }), trusted, options),
    ).toThrow("not enabled");
    const base = manifest();
    expect(() =>
      acceptRelease(
        signed({
          ...base,
          assets: { "darwin-arm64": { ...base.assets["darwin-arm64"]!, name: "other.zip" } },
        }),
        trusted,
        options,
      ),
    ).toThrow("does not match");
  });

  test("implements SemVer precedence", () => {
    expect(compareVersions("1.2.0", "1.1.9")).toBe(1);
    expect(compareVersions("1.2.0-beta.2", "1.2.0-beta.11")).toBe(-1);
    expect(compareVersions("1.2.0", "1.2.0-rc.1")).toBe(1);
    expect(compareVersions("1.2.0+build.2", "1.2.0+build.1")).toBe(0);
  });
});
