import { AsyncEntry } from "@napi-rs/keyring";
import { Context, Data, Effect, Layer } from "effect";

/** Keychain service name every secret of this app is stored under. */
export const keychainService = "context-generactive-agent";

/** Names of the secrets the app keeps. Each one is a separate keychain entry. */
export type SecretName = "kagi-api-key";

/** The OS keychain refused or failed. Never answered by storing the secret somewhere else (R14). */
export class SecretStoreFailed extends Data.TaggedError("SecretStoreFailed")<{
  readonly operation: "read" | "write" | "delete";
}> {}

export interface SecretStoreApi {
  readonly get: (name: SecretName) => Effect.Effect<string | null, SecretStoreFailed>;
  readonly set: (name: SecretName, value: string) => Effect.Effect<void, SecretStoreFailed>;
  /** Succeeds when nothing was stored. */
  readonly remove: (name: SecretName) => Effect.Effect<void, SecretStoreFailed>;
}

const keychain: SecretStoreApi = {
  get: (name) =>
    Effect.tryPromise({
      try: () => new AsyncEntry(keychainService, name).getPassword(),
      catch: () => new SecretStoreFailed({ operation: "read" }),
    }).pipe(Effect.map((value) => value ?? null)),
  set: (name, value) =>
    Effect.tryPromise({
      try: () => new AsyncEntry(keychainService, name).setPassword(value),
      catch: () => new SecretStoreFailed({ operation: "write" }),
    }),
  remove: (name) =>
    Effect.tryPromise({
      try: () => new AsyncEntry(keychainService, name).deletePassword(),
      catch: () => new SecretStoreFailed({ operation: "delete" }),
    }).pipe(Effect.asVoid),
};

/**
 * Secrets such as the Kagi API key. They live in the OS keychain (macOS Keychain, Windows
 * Credential Manager, Secret Service) and are only read right before the request that needs them;
 * they never reach config files, the conversation, tool output or logs.
 */
export class SecretStore extends Context.Tag("memory-agent/SecretStore")<
  SecretStore,
  SecretStoreApi
>() {
  static readonly keychain = Layer.succeed(SecretStore, keychain);

  /** Kept in memory only, for tests. */
  static readonly memory = Layer.sync(SecretStore, () => {
    const values = new Map<SecretName, string>();
    return {
      get: (name) => Effect.sync(() => values.get(name) ?? null),
      set: (name, value) => Effect.sync(() => void values.set(name, value)),
      remove: (name) => Effect.sync(() => void values.delete(name)),
    };
  });
}
