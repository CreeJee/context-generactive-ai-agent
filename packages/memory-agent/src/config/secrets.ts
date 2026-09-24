import { Context, Data, Effect, Layer } from "effect";
import { requireRuntime } from "../runtime/resources.ts";

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

/** The native keyring addon loads on first use, so a failure to load is a failed operation. */
const entry = (name: SecretName) =>
  new (requireRuntime("@napi-rs/keyring").AsyncEntry)(keychainService, name);

const keychain: SecretStoreApi = {
  get: (name) =>
    Effect.tryPromise({
      try: () => entry(name).getPassword(),
      catch: () => new SecretStoreFailed({ operation: "read" }),
    }).pipe(Effect.map((value) => value ?? null)),
  set: (name, value) =>
    Effect.tryPromise({
      try: () => entry(name).setPassword(value),
      catch: () => new SecretStoreFailed({ operation: "write" }),
    }),
  remove: (name) =>
    Effect.tryPromise({
      try: () => entry(name).deletePassword(),
      catch: () => new SecretStoreFailed({ operation: "delete" }),
    }).pipe(Effect.asVoid),
};

/**
 * Secrets such as the Kagi API key. They live in the OS keychain (macOS Keychain, Windows
 * Credential Manager, Secret Service) and are only read right before the request that needs them;
 * they never reach config files, the conversation, tool output or logs.
 */
export class SecretStore extends Context.Service<SecretStore, SecretStoreApi>()(
  "memory-agent/SecretStore",
) {
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
