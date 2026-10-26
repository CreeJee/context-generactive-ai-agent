import { nativePromise } from "../runtime/native-effect.ts";
import { runOAuthNodeEffect } from "./node-runtime.ts";
import { Cause, Crypto, Effect, Function as EffectFunction, Option } from "effect";
import type { PlatformError } from "effect/PlatformError";

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

const fragmentMessages = {
  invalid_manifest: "Invalid credential manifest.",
  incomplete_fragments: "Incomplete credential fragments.",
  changed_while_reading: "Credential changed while reading.",
  fragment_limit: "Credential exceeds the fragment limit.",
} as const satisfies Record<CredentialFragmentsFailed["reason"], string>;

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
    return fragmentMessages[this.reason];
  }
}

/** The manifest a fragmented credential leaves in the root entry; none for a password stored whole. */
const manifest = (
  value: string | null | undefined,
): Effect.Effect<Option.Option<Manifest>, CredentialFragmentsFailed> =>
  value == null || !value.startsWith(manifestPrefix)
    ? Effect.succeedNone
    : Effect.asSome(
        Effect.fromOption(decodeManifest(value.slice(manifestPrefix.length)), () =>
          CredentialFragmentsFailed.make({ reason: "invalid_manifest" }),
        ),
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
    // Every fragment is tried; the first failed delete is the outcome.
    yield* Effect.all(results, { discard: true });
  });
  /** Cleanup only: the write's own outcome stands, so a failed delete is logged by tag. */
  const removeChunksBestEffort = (value: Manifest) =>
    removeChunks(value).pipe(
      Effect.catchTag("UnknownError", () =>
        Effect.logWarning("Credential fragment cleanup failed", { error: "UnknownError" }),
      ),
    );
  /** Reads what `encoded` names; a manifest replaced while its fragments were read is read once more. */
  const readFrom = (
    encoded: string | undefined,
    again: boolean,
  ): Effect.Effect<
    string | undefined,
    CredentialFragmentsFailed | Cause.UnknownError | PlatformError,
    Crypto.Crypto
  > =>
    Effect.flatMap(
      manifest(encoded),
      Option.match({
        onNone: () => Effect.succeed(encoded),
        onSome: (current) =>
          Effect.gen(function* () {
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
            yield* Effect.when(
              Effect.fail(CredentialFragmentsFailed.make({ reason: "incomplete_fragments" })),
              Effect.succeed(latest === encoded),
            );
            return yield* again
              ? readFrom(latest, false)
              : Effect.fail(CredentialFragmentsFailed.make({ reason: "changed_while_reading" }));
          }),
      }),
    );
  /** A password too long for one vault entry goes into fragments, published by a manifest last. */
  const writeFragments = Effect.fn("CredentialFragments.write")(function* (password: string) {
    const encoded = Buffer.from(password).toString("base64");
    const next: Manifest = {
      generation: yield* (yield* Crypto.Crypto).randomUUIDv4(),
      count: Math.ceil(encoded.length / passwordLimit),
      digest: yield* digest(password),
    };
    yield* Effect.when(
      Effect.fail(CredentialFragmentsFailed.make({ reason: "fragment_limit" })),
      Effect.succeed(next.count > 256),
    );
    yield* Effect.gen(function* () {
      yield* Effect.forEach(
        Array.from({ length: next.count }, (_, index) => index),
        (index) =>
          nativePromise(() =>
            chunk(next, index).setPassword(
              encoded.slice(index * passwordLimit, (index + 1) * passwordLimit),
            ),
          ),
        { discard: true },
      );
      const encodedManifest = yield* Schema.encodeEffect(Schema.fromJsonString(Manifest))(next);
      yield* nativePromise(() => root.setPassword(manifestPrefix + encodedManifest));
    }).pipe(
      // A failed or interrupted write leaves no fragments of the new generation behind.
      Effect.onError(() => removeChunksBestEffort(next)),
    );
  });
  return {
    getPassword: () =>
      runOAuthNodeEffect(
        nativePromise(() => root.getPassword()).pipe(
          Effect.flatMap((encoded) => readFrom(encoded ?? undefined, true)),
        ),
      ),
    setPassword: (password) =>
      runOAuthNodeEffect(
        Effect.gen(function* () {
          const previous = yield* nativePromise(() => root.getPassword()).pipe(
            Effect.flatMap(manifest),
          );
          yield* password.length <= passwordLimit
            ? nativePromise(() => root.setPassword(password))
            : writeFragments(password);
          yield* Effect.transposeOption(Option.map(previous, removeChunksBestEffort));
        }),
      ),
    deleteCredential: () =>
      runOAuthNodeEffect(
        Effect.gen(function* () {
          const previous = yield* nativePromise(() => root.getPassword()).pipe(
            Effect.flatMap(manifest),
          );
          const deleted = yield* nativePromise(() => root.deleteCredential());
          yield* Effect.transposeOption(Option.map(previous, removeChunks));
          return deleted;
        }),
      ),
  };
}
