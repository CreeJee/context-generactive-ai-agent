import { nativePromise } from "../runtime/native-effect.ts";
import { runOAuthNodeEffect } from "./node-runtime.ts";
import { Crypto, Effect, Exit, Function as EffectFunction } from "effect";

import { Schema } from "effect";

export interface PasswordEntry {
  // Native Windows keyring returns null for an absent entry, despite its undefined-only typings.
  getPassword(): Promise<string | null | undefined>;
  setPassword(password: string): Promise<void>;
  deleteCredential(): Promise<boolean>;
}

// Windows CRED_MAX_CREDENTIAL_BLOB_SIZE is 2,560 bytes; keyring encodes passwords as UTF-16.
const passwordLimit = 1_280;
const manifestPrefix = "context-agent:chunked-password:v1:";
const Manifest = Schema.Struct({
  generation: Schema.String.check(Schema.isUUID(4)),
  count: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 256 })),
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
type Manifest = typeof Manifest.Type;
const decodeManifest = Schema.decodeUnknownOption(Schema.fromJsonString(Manifest));
const digest = Effect.fnUntraced(function* (value: string) {
  const crypto = yield* Crypto.Crypto;
  return Buffer.from(yield* crypto.digest("SHA-256", new TextEncoder().encode(value))).toString(
    "hex",
  );
});

/** Why a fragmented credential could not be read or written; the keychain store reports its stage. */
export class CredentialFragmentsFailed extends Schema.TaggedError<CredentialFragmentsFailed>()(
  "CredentialFragmentsFailed",
  {
    reason: Schema.Literals([
      "invalid_manifest",
      "incomplete_fragments",
      "changed_while_reading",
      "fragment_limit",
    ]),
  },
) {
  override get message() {
    switch (this.reason) {
      case "invalid_manifest":
        return "Invalid credential manifest.";
      case "incomplete_fragments":
        return "Incomplete credential fragments.";
      case "changed_while_reading":
        return "Credential changed while reading.";
      case "fragment_limit":
        return "Credential exceeds the fragment limit.";
    }
  }
}

const manifest = (
  value: string | null | undefined,
): Effect.Effect<Manifest | null, CredentialFragmentsFailed> =>
  value == null || !value.startsWith(manifestPrefix)
    ? Effect.succeed(null)
    : Effect.fromOption(decodeManifest(value.slice(manifestPrefix.length)), () =>
        CredentialFragmentsFailed.make({ reason: "invalid_manifest" }),
      );

/** Keep every fragment in the OS vault, and publish a new generation only after all writes succeed. */
export const createChunkedPasswordEntry: {
  (
    account: string,
  ): (
    open: (account: string) => PasswordEntry,
  ) => ReturnType<typeof createChunkedPasswordEntryBody>;
} & typeof createChunkedPasswordEntryBody = EffectFunction.dual(2, createChunkedPasswordEntryBody);
function createChunkedPasswordEntryBody(
  open: (account: string) => PasswordEntry,
  account: string,
): PasswordEntry {
  const root = open(account);
  const chunk = (value: Manifest, index: number) => open(`${account}:${value.generation}:${index}`);
  const removeChunks = Effect.fn("CredentialFragments.remove")(function* (value: Manifest) {
    const results = yield* Effect.forEach(
      Array.from({ length: value.count }, (_, index) => index),
      (index) => Effect.exit(nativePromise(() => chunk(value, index).deleteCredential())),
      { concurrency: 1 },
    );
    for (const result of results)
      if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause);
  });
  /** Cleanup only: the write's own outcome stands, so a failed delete is logged by tag. */
  const removeChunksBestEffort = (value: Manifest) =>
    removeChunks(value).pipe(
      Effect.catchTag("UnknownError", () =>
        Effect.logWarning("Credential fragment cleanup failed", { error: "UnknownError" }),
      ),
    );
  return {
    getPassword: () =>
      runOAuthNodeEffect(
        Effect.gen(function* () {
          let encoded = (yield* nativePromise(() => root.getPassword())) ?? undefined;
          for (let attempt = 0; attempt < 2; attempt++) {
            const current = yield* manifest(encoded);
            if (current === null) return encoded;
            const parts = yield* Effect.forEach(
              Array.from({ length: current.count }, (_, index) => index),
              (index) =>
                nativePromise(() => chunk(current, index).getPassword()).pipe(
                  Effect.map((part) => part ?? undefined),
                ),
              { concurrency: "unbounded" },
            );
            const password = Buffer.from(parts.join(""), "base64").toString("utf8");
            if (
              parts.every((part) => part !== undefined) &&
              (yield* digest(password)) === current.digest
            )
              return password;
            const latest = (yield* nativePromise(() => root.getPassword())) ?? undefined;
            if (latest === encoded)
              return yield* CredentialFragmentsFailed.make({ reason: "incomplete_fragments" });
            encoded = latest;
          }
          return yield* CredentialFragmentsFailed.make({ reason: "changed_while_reading" });
        }),
      ),
    setPassword: (password) =>
      runOAuthNodeEffect(
        Effect.gen(function* () {
          const previous = yield* nativePromise(() => root.getPassword()).pipe(
            Effect.flatMap(manifest),
          );
          if (password.length <= passwordLimit)
            yield* nativePromise(() => root.setPassword(password));
          else {
            const encoded = Buffer.from(password).toString("base64");
            const next: Manifest = {
              generation: yield* (yield* Crypto.Crypto).randomUUIDv4(),
              count: Math.ceil(encoded.length / passwordLimit),
              digest: yield* digest(password),
            };
            if (next.count > 256)
              return yield* CredentialFragmentsFailed.make({ reason: "fragment_limit" });
            yield* Effect.gen(function* () {
              for (let index = 0; index < next.count; index++) {
                const entry = chunk(next, index);
                yield* nativePromise(() =>
                  entry.setPassword(
                    encoded.slice(index * passwordLimit, (index + 1) * passwordLimit),
                  ),
                );
              }
              const encodedManifest = yield* Schema.encodeEffect(Schema.fromJsonString(Manifest))(
                next,
              );
              yield* nativePromise(() => root.setPassword(manifestPrefix + encodedManifest));
            }).pipe(
              // A failed or interrupted write leaves no fragments of the new generation behind.
              Effect.onError(() => removeChunksBestEffort(next)),
            );
          }
          if (previous !== null) yield* removeChunksBestEffort(previous);
        }),
      ),
    deleteCredential: () =>
      runOAuthNodeEffect(
        Effect.gen(function* () {
          const previous = yield* nativePromise(() => root.getPassword()).pipe(
            Effect.flatMap(manifest),
          );
          const deleted = yield* nativePromise(() => root.deleteCredential());
          if (previous !== null) yield* removeChunks(previous);
          return deleted;
        }),
      ),
  };
}
