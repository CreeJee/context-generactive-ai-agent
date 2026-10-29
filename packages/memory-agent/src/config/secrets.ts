import {
  HashMap,
  Option,
  Context,
  Crypto,
  Effect,
  FileSystem,
  Layer,
  Path,
  Ref,
  Schema,
} from "effect";
import {
  type ChunkedPasswordFailure,
  createChunkedPasswordEntry,
  type PasswordEntry,
} from "../oauth/chunked-password-entry.ts";
import { type KeyringOpenFailure, openKeyringEntry } from "../runtime/keyring.ts";

/** Keychain service name every secret of this app is stored under. */
export const keychainService = "context-generactive-agent";

/**
 * Names of the secrets the app keeps. Each one is a separate keychain entry. `mcp-oauth:` holds
 * one MCP server's login: `mcp-oauth:<scope>:<project id, empty for global>:<server name>`.
 */
export type SecretName = "kagi-api-key" | `mcp-oauth:${string}`;

/** The secret backend refused or failed. Never answered by storing the secret somewhere else (R14). */
export class SecretStoreFailed extends Schema.TaggedError<
  SecretStoreFailed,
  { readonly brand: unique symbol }
>()("SecretStoreFailed", { operation: Schema.Literals(["read", "write", "delete"]) }) {}

type EntryFailure = KeyringOpenFailure | ChunkedPasswordFailure;

export interface SecretStoreApi {
  readonly get: (name: SecretName) => Effect.Effect<string | null, SecretStoreFailed>;
  readonly set: (name: SecretName, value: string) => Effect.Effect<void, SecretStoreFailed>;
  /** Succeeds when nothing was stored. */
  readonly remove: (name: SecretName) => Effect.Effect<void, SecretStoreFailed>;
}

const keychain = Effect.map(
  Effect.context<FileSystem.FileSystem | Path.Path | Crypto.Crypto>(),
  (platform): SecretStoreApi => {
    const open = (account: string) =>
      openKeyringEntry(keychainService, account).pipe(Effect.provideContext(platform));
    /** A Windows credential holds 2,560 bytes, so a longer secret (an MCP login) goes in fragments. */
    const entryOf = (
      name: SecretName,
    ): Effect.Effect<PasswordEntry<EntryFailure>, KeyringOpenFailure> =>
      process.platform === "win32"
        ? Effect.provideContext(
            createChunkedPasswordEntry<KeyringOpenFailure>({ open, account: name }),
            platform,
          )
        : open(name);
    /** The native keyring addon loads on first use, so a failure to load is a failed operation. */
    const withEntry = <A>(
      name: SecretName,
      operation: SecretStoreFailed["operation"],
      use: (entry: PasswordEntry<EntryFailure>) => Effect.Effect<A, EntryFailure>,
    ) =>
      Effect.flatMap(entryOf(name), use).pipe(
        Effect.mapError(() => SecretStoreFailed.make({ operation })),
      );
    return {
      get: (name) => withEntry(name, "read", (entry) => entry.getPassword),
      set: (name, value) => withEntry(name, "write", (entry) => entry.setPassword(value)),
      remove: (name) =>
        withEntry(name, "delete", (entry) => entry.deleteCredential).pipe(Effect.asVoid),
    };
  },
);

/**
 * Secrets such as the Kagi API key. They live in the OS keychain (macOS Keychain, Windows
 * Credential Manager, Secret Service) and are only read right before the request that needs them;
 * they never reach config files, the conversation, tool output or logs.
 */
export class SecretStore extends Context.Service<SecretStore, SecretStoreApi>()(
  "memory-agent/config/secrets/SecretStore",
) {
  static readonly keychain = Layer.effect(SecretStore, keychain);

  /** Kept in memory only, for tests. */
  static readonly memory = Layer.effect(
    SecretStore,
    Effect.map(Ref.make(HashMap.empty<SecretName, string>()), (values): SecretStoreApi => ({
      get: (name) =>
        Effect.map(Ref.get(values), (stored) => Option.getOrNull(HashMap.get(stored, name))),
      set: (name, value) => Ref.update(values, HashMap.set(name, value)),
      remove: (name) => Ref.update(values, HashMap.remove(name)),
    })),
  );
}
