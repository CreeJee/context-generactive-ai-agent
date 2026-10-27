import { Crypto, Effect, Option, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";

/** One OS vault entry, failing with `E`. */
export interface PasswordEntry<E> {
  readonly getPassword: Effect.Effect<string | null, E>;
  readonly setPassword: (password: string) => Effect.Effect<void, E>;
  readonly deleteCredential: Effect.Effect<boolean, E>;
}

/** Opens the vault entry of an account; every operation opens its entry again. */
export type OpenPasswordEntry<E> = (account: string) => Effect.Effect<PasswordEntry<E>, E>;

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
const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(Manifest));

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

/** What a fragmented entry adds to its vault's own failures. */
export type ChunkedPasswordFailure = CredentialFragmentsFailed | PlatformError | Schema.SchemaError;

/** The manifest a fragmented credential leaves in the root entry; none for a password stored whole. */
const manifest = (
  value: string | null,
): Effect.Effect<Option.Option<Manifest>, CredentialFragmentsFailed> =>
  value === null || !value.startsWith(manifestPrefix)
    ? Effect.succeedNone
    : Effect.asSome(
        Effect.fromOption(decodeManifest(value.slice(manifestPrefix.length)), () =>
          CredentialFragmentsFailed.make({ reason: "invalid_manifest" }),
        ),
      );

const fragmentIndexes = (value: Manifest) =>
  Array.from({ length: value.count }, (_, index) => index);

/** Keep every fragment in the OS vault, and publish a new generation only after all writes succeed. */
export function createChunkedPasswordEntry<E>(options: {
  readonly open: OpenPasswordEntry<E>;
  readonly account: string;
}): Effect.Effect<PasswordEntry<E | ChunkedPasswordFailure>, never, Crypto.Crypto> {
  const { open, account } = options;
  return Effect.map(Effect.service(Crypto.Crypto), (crypto) => {
    const digest = (value: string) =>
      Effect.map(crypto.digest("SHA-256", new TextEncoder().encode(value)), (bytes) =>
        Buffer.from(bytes).toString("hex"),
      );
    const rootPassword = Effect.flatMap(open(account), (root) => root.getPassword);
    const chunk = (value: Manifest, index: number) =>
      open(`${account}:${value.generation}:${index}`);
    const removeChunks = Effect.fn("CredentialFragments.remove")(function* (value: Manifest) {
      const results = yield* Effect.forEach(
        fragmentIndexes(value),
        (index) =>
          Effect.exit(Effect.flatMap(chunk(value, index), (entry) => entry.deleteCredential)),
        { concurrency: 1 },
      );
      // Every fragment is tried; the first failed delete is the outcome.
      yield* Effect.all(results, { discard: true });
    });
    /** Cleanup only: the write's own outcome stands, so a failed delete is only logged. */
    const removeChunksBestEffort = (value: Manifest) =>
      removeChunks(value).pipe(
        Effect.catch(() => Effect.logWarning("Credential fragment cleanup failed")),
      );
    /** Reads what `encoded` names; a manifest replaced while its fragments were read is read once more. */
    const readFrom = (
      encoded: string | null,
      again: boolean,
    ): Effect.Effect<string | null, E | ChunkedPasswordFailure> =>
      Effect.flatMap(
        manifest(encoded),
        Option.match({
          onNone: () => Effect.succeed(encoded),
          onSome: (current) =>
            Effect.gen(function* () {
              const parts = yield* Effect.forEach(
                fragmentIndexes(current),
                (index) => Effect.flatMap(chunk(current, index), (entry) => entry.getPassword),
                { concurrency: "unbounded" },
              );
              const password = Buffer.from(parts.join(""), "base64").toString("utf8");
              if (
                parts.every((part) => part !== null) &&
                (yield* digest(password)) === current.digest
              )
                return password;
              const latest = yield* rootPassword;
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
        generation: yield* crypto.randomUUIDv4(),
        count: Math.ceil(encoded.length / passwordLimit),
        digest: yield* digest(password),
      };
      yield* Effect.when(
        Effect.fail(CredentialFragmentsFailed.make({ reason: "fragment_limit" })),
        Effect.succeed(next.count > 256),
      );
      yield* Effect.gen(function* () {
        yield* Effect.forEach(
          fragmentIndexes(next),
          (index) =>
            Effect.flatMap(chunk(next, index), (entry) =>
              entry.setPassword(encoded.slice(index * passwordLimit, (index + 1) * passwordLimit)),
            ),
          { discard: true },
        );
        const encodedManifest = yield* encodeManifest(next);
        yield* Effect.flatMap(open(account), (root) =>
          root.setPassword(manifestPrefix + encodedManifest),
        );
      }).pipe(
        // A failed or interrupted write leaves no fragments of the new generation behind.
        Effect.onError(() => removeChunksBestEffort(next)),
      );
    });
    const previousManifest = Effect.flatMap(rootPassword, manifest);
    const entry: PasswordEntry<E | ChunkedPasswordFailure> = {
      getPassword: Effect.flatMap(rootPassword, (encoded) => readFrom(encoded, true)),
      setPassword: (password) =>
        Effect.gen(function* () {
          const previous = yield* previousManifest;
          yield* password.length <= passwordLimit
            ? Effect.flatMap(open(account), (root) => root.setPassword(password))
            : writeFragments(password);
          yield* Effect.transposeOption(Option.map(previous, removeChunksBestEffort));
        }),
      deleteCredential: Effect.gen(function* () {
        const previous = yield* previousManifest;
        const deleted = yield* Effect.flatMap(open(account), (root) => root.deleteCredential);
        yield* Effect.transposeOption(Option.map(previous, removeChunks));
        return deleted;
      }),
    };
    return entry;
  });
}
