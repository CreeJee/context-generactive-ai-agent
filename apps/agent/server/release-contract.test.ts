import { it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";
import { Base64, Hex } from "effect/encoding";
import { describe, expect, test } from "vite-plus/test";
import {
  acceptRelease,
  canonicalJson,
  compareVersions,
  releaseAssetName,
  signReleaseManifest,
  verifyManifestSignature,
  type ReleaseManifest,
  type ReleaseRejected,
  type ReleaseSigningFailed,
} from "./release-contract";

const pem = (label: "PUBLIC KEY" | "PRIVATE KEY", der: Uint8Array) =>
  `-----BEGIN ${label}-----\n${Base64.encode(der).replace(/.{64}/g, "$&\n")}\n-----END ${label}-----\n`;

// The same PEM spellings `generateKeyPairSync("ed25519")` exports.
const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const keys = {
  publicKey: pem(
    "PUBLIC KEY",
    new Uint8Array(await crypto.subtle.exportKey("spki", keyPair.publicKey)),
  ),
  privateKey: pem(
    "PRIVATE KEY",
    new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)),
  ),
};

// RFC 8032 section 7.1 TEST 1 key, wrapped in the PKCS#8/SPKI prefixes for Ed25519.
const rfcKeys = {
  publicKey: pem(
    "PUBLIC KEY",
    Hex.decode(
      "302a300506032b6570032100d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    ).pipe(Result.getOrThrow),
  ),
  privateKey: pem(
    "PRIVATE KEY",
    Hex.decode(
      "302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
    ).pipe(Result.getOrThrow),
  ),
};
// `sign(null, canonicalJson(manifest()), rfcKeys.privateKey)` from node:crypto before the WebCrypto move.
const nodeSignature =
  "/+wPsxsxuXLm6hbtvmZNRnIujkYgMFmYNLtsjMe6Aci2pkvAm3eTdJO+87/xl5Qp4BScW1tXt/dTi9af2OewCw==";

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

const signed = Effect.fnUntraced(function* (value: ReleaseManifest) {
  return {
    manifest: value,
    signature: yield* signReleaseManifest(value, "release-2026", keys.privateKey),
  };
});

const options = {
  currentVersion: "1.1.0",
  updaterVersion: "1.0.0",
  target: "darwin-arm64",
};

const trusted = { "release-2026": keys.publicKey };

const rejection = <A>(
  effect: Effect.Effect<A, ReleaseRejected | ReleaseSigningFailed | Schema.SchemaError>,
) =>
  Effect.flip(effect).pipe(
    Effect.map((error) => {
      switch (error._tag) {
        case "SchemaError":
          return error._tag;
        case "ReleaseRejected":
        case "ReleaseSigningFailed":
          return error.reason._tag;
      }
    }),
  );

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

  it.effect("accepts a signed newer release for the selected target", () =>
    Effect.gen(function* () {
      expect((yield* acceptRelease(yield* signed(manifest()), trusted, options)).size).toBe(123);
    }),
  );

  it.effect("keeps node:crypto Ed25519 PEM signatures byte-identical and verifiable", () =>
    Effect.gen(function* () {
      const signature = yield* signReleaseManifest(manifest(), "rfc", rfcKeys.privateKey);
      expect(signature.signature).toBe(nodeSignature);
      yield* verifyManifestSignature(
        manifest(),
        { keyId: "rfc", signature: nodeSignature },
        { rfc: rfcKeys.publicKey },
      );
      const value = { ...manifest(), publishedAt: "한글 😀" };
      const unicode = yield* signReleaseManifest(value, "release-2026", keys.privateKey);
      yield* verifyManifestSignature(value, unicode, trusted);
    }),
  );

  it.effect("preserves accepted signature encodings and rejects corrupt signatures", () =>
    Effect.gen(function* () {
      const value = manifest();
      const signature = yield* signReleaseManifest(value, "release-2026", keys.privateKey);
      for (const encoded of [
        signature.signature.replace(/=+$/, ""),
        Buffer.from(signature.signature, "base64").toString("base64url"),
        ` \n${signature.signature}\n `,
      ])
        yield* verifyManifestSignature(value, { ...signature, signature: encoded }, trusted);
      for (const encoded of ["", "%%%", Buffer.alloc(64).toString("base64")])
        expect(
          yield* rejection(
            verifyManifestSignature(value, { ...signature, signature: encoded }, trusted),
          ),
        ).toBe("InvalidSignature");
    }),
  );

  it.effect("rejects malformed PEM keys without accepting a release", () =>
    Effect.gen(function* () {
      expect(yield* rejection(signReleaseManifest(manifest(), "release-2026", "invalid PEM"))).toBe(
        "InvalidKey",
      );
      expect(
        yield* rejection(
          acceptRelease(yield* signed(manifest()), { "release-2026": "invalid PEM" }, options),
        ),
      ).toBe("InvalidKey");
    }),
  );

  it.effect("rejects manifest tampering and unknown signing keys", () =>
    Effect.gen(function* () {
      const envelope = yield* signed(manifest());
      expect(
        yield* rejection(
          acceptRelease(
            { ...envelope, manifest: { ...envelope.manifest, version: "1.3.0" } },
            trusted,
            options,
          ),
        ),
      ).toBe("InvalidSignature");
      expect(yield* rejection(acceptRelease(envelope, {}, options))).toBe("UntrustedKey");
    }),
  );

  it.effect("rejects downgrade, insufficient updater, prerelease and mismatched asset names", () =>
    Effect.gen(function* () {
      expect(
        yield* rejection(acceptRelease(yield* signed(manifest("1.0.0")), trusted, options)),
      ).toBe("NotNewer");
      expect(
        yield* rejection(
          acceptRelease(
            yield* signed({ ...manifest(), minUpdaterVersion: "2.0.0" }),
            trusted,
            options,
          ),
        ),
      ).toBe("UpdaterTooOld");
      expect(
        yield* rejection(
          acceptRelease(yield* signed({ ...manifest(), channel: "prerelease" }), trusted, options),
        ),
      ).toBe("PrereleaseDisabled");
      const base = manifest();
      expect(
        yield* rejection(
          acceptRelease(
            yield* signed({
              ...base,
              assets: { "darwin-arm64": { ...base.assets["darwin-arm64"]!, name: "other.zip" } },
            }),
            trusted,
            options,
          ),
        ),
      ).toBe("AssetNameMismatch");
    }),
  );

  test("implements SemVer precedence", () => {
    expect(compareVersions("1.2.0", "1.1.9")).toBe(1);
    expect(compareVersions("1.2.0-beta.2", "1.2.0-beta.11")).toBe(-1);
    expect(compareVersions("1.2.0", "1.2.0-rc.1")).toBe(1);
    expect(compareVersions("1.2.0+build.2", "1.2.0+build.1")).toBe(0);
  });
});
