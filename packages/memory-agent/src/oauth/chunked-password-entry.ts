import { nativePromise, runNativeEffect } from "../runtime/native-effect.ts";
import { Cause, Effect, Exit, Function as EffectFunction } from "effect";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { createHash, randomUUID } from "node:crypto";
import { Option, Schema } from "effect";

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
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function manifest(value: string | null | undefined): Manifest | null {
  if (value == null || !value.startsWith(manifestPrefix)) return null;
  return Option.getOrThrowWith(
    decodeManifest(value.slice(manifestPrefix.length)),
    () => new Error("Invalid credential manifest."),
  );
}

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
  return {
    getPassword: () =>
      runNativeEffect(
        Effect.gen(function* () {
          let encoded = (yield* nativePromise(() => root.getPassword())) ?? undefined;
          for (let attempt = 0; attempt < 2; attempt++) {
            const current = yield* Effect.try(() => manifest(encoded));
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
            if (parts.every((part) => part !== undefined) && digest(password) === current.digest)
              return password;
            const latest = (yield* nativePromise(() => root.getPassword())) ?? undefined;
            if (latest === encoded)
              return yield* new Cause.UnknownError(new Error("Incomplete credential fragments."));
            encoded = latest;
          }
          return yield* new Cause.UnknownError(new Error("Credential changed while reading."));
        }),
      ),
    setPassword: (password) =>
      runNativeEffect(
        Effect.gen(function* () {
          const previous = yield* nativePromise(() => root.getPassword()).pipe(
            Effect.flatMap((encoded) => Effect.try(() => manifest(encoded))),
          );
          if (password.length <= passwordLimit)
            yield* nativePromise(() => root.setPassword(password));
          else {
            const encoded = Buffer.from(password).toString("base64");
            const next: Manifest = {
              generation: randomUUID(),
              count: Math.ceil(encoded.length / passwordLimit),
              digest: digest(password),
            };
            if (next.count > 256)
              return yield* new Cause.UnknownError(
                new Error("Credential exceeds the fragment limit."),
              );
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
              Effect.catchCause((cause) =>
                removeChunks(next).pipe(Effect.ignore, Effect.andThen(Effect.failCause(cause))),
              ),
            );
          }
          if (previous !== null) yield* removeChunks(previous).pipe(Effect.ignore);
        }),
      ),
    deleteCredential: () =>
      runNativeEffect(
        Effect.gen(function* () {
          const previous = yield* nativePromise(() => root.getPassword()).pipe(
            Effect.flatMap((encoded) => Effect.try(() => manifest(encoded))),
          );
          const deleted = yield* nativePromise(() => root.deleteCredential());
          if (previous !== null) yield* removeChunks(previous);
          return deleted;
        }),
      ),
  };
}
