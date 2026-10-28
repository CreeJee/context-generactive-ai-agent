import {
  Cause,
  Config,
  Data,
  Effect,
  FileSystem,
  Function as EffectFunction,
  Option,
  Path,
  Result,
  Schema,
} from "effect";
import { Base64 } from "effect/encoding";
import { nativePromise } from "./native-effect.ts";
import { requireRuntime } from "./resources.ts";
import { sha256 } from "./synchronous-crypto.ts";

/** The encrypted secret directory could not be used. Never answered by falling back to the OS keychain. */
export class SecretFileStoreFailed extends Schema.TaggedError<
  SecretFileStoreFailed,
  { readonly brand: unique symbol }
>()("SecretFileStoreFailed", {
  reason: Schema.Literals(["key_missing", "key_invalid", "read", "write", "delete", "decrypt"]),
}) {}
type FailureReason = SecretFileStoreFailed["reason"];

/** A keychain call failed, or the encrypted secret directory could not be used. */
export type KeyringFailure = SecretFileStoreFailed | Cause.UnknownError;

/** The entry operations the app uses, over `@napi-rs/keyring`'s `AsyncEntry` or an encrypted file. */
export interface KeyringEntry {
  /** Null when nothing is stored. */
  readonly getPassword: Effect.Effect<string | null, KeyringFailure>;
  readonly setPassword: (password: string) => Effect.Effect<void, KeyringFailure>;
  readonly deletePassword: Effect.Effect<boolean, KeyringFailure>;
  readonly deleteCredential: Effect.Effect<boolean, KeyringFailure>;
}

/**
 * Where secrets live. `keychain` is the OS keychain (macOS Keychain, Windows Credential Manager,
 * Secret Service). `file` is one AES-GCM encrypted file per entry, for hosts without a keychain such as
 * containers. Only `CONTEXT_AGENT_SECRET_DIRECTORY` selects it, and its key comes from outside that
 * directory: `CONTEXT_AGENT_SECRET_KEY`, or the file named by `CONTEXT_AGENT_SECRET_KEY_FILE`.
 */
export type SecretBackend = Data.TaggedEnum<{
  keychain: {};
  file: {
    readonly directory: string;
    readonly key: Option.Option<string>;
    readonly keyFile: Option.Option<string>;
  };
}>;
export const SecretBackend = Data.taggedEnum<SecretBackend>();

const failure = (reason: FailureReason) => SecretFileStoreFailed.make({ reason });
const failWith = (reason: FailureReason) => () => failure(reason);
const fail = (reason: FailureReason) => Effect.fail(failure(reason));

const setting = (name: string) => Config.option(Config.String(name));
// Native host/SDK configuration boundary reads or forwards the host environment.
const configuredBackend: Config.Config<SecretBackend> = Config.all({
  directory: setting("CONTEXT_AGENT_SECRET_DIRECTORY"),
  key: setting("CONTEXT_AGENT_SECRET_KEY"),
  keyFile: setting("CONTEXT_AGENT_SECRET_KEY_FILE"),
}).pipe(
  Config.map(({ directory, key, keyFile }) =>
    Option.match(directory, {
      onNone: (): SecretBackend => SecretBackend.keychain(),
      onSome: (directory): SecretBackend => SecretBackend.file({ directory, key, keyFile }),
    }),
  ),
);

const base64 = (
  text: string,
  reason: FailureReason,
): Effect.Effect<Uint8Array<ArrayBuffer>, SecretFileStoreFailed> =>
  Result.match(Base64.decode(text), {
    // Web Crypto takes ArrayBuffer-backed views only.
    onSuccess: (bytes) => Effect.succeed(new Uint8Array(bytes)),
    onFailure: () => fail(reason),
  });

type FileBackend = Data.TaggedEnum.Value<SecretBackend, "file">;

const fileEntry = Effect.fnUntraced(function* (
  backend: FileBackend,
  service: string,
  account: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { directory } = backend;
  const file = path.join(directory, `${sha256(`${service}\n${account}`)}.secret`);
  // Binds each ciphertext to its entry, so a file copied over another entry does not decrypt.
  const additionalData = new TextEncoder().encode(`${service}\n${account}`);

  /** 32 random bytes in Base64, e.g. `openssl rand -base64 32`. Read on use, so a rotated key file applies. */
  const fileKey = Effect.fn("keyring.fileKey")(function* () {
    const encoded = yield* Option.match(backend.key, {
      onSome: Effect.succeed,
      onNone: () =>
        Option.match(backend.keyFile, {
          onSome: (keyFile) =>
            fs.readFileString(keyFile).pipe(Effect.mapError(failWith("key_missing"))),
          onNone: () => fail("key_missing"),
        }),
    });
    const bytes = yield* base64(encoded.trim(), "key_invalid").pipe(
      Effect.filterOrFail((key) => key.length === 32, failWith("key_invalid")),
    );
    return yield* Effect.tryPromise({
      try: () => crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]),
      catch: failWith("key_invalid"),
    });
  });

  const read = Effect.gen(function* () {
    const stored = yield* fs.readFileString(file).pipe(Effect.mapError(failWith("read")));
    const [iv, ciphertext] = yield* Effect.succeed(stored.trim().split(":")).pipe(
      Effect.filterOrFail((parts) => parts.length === 3 && parts[0] === "v1", failWith("decrypt")),
      Effect.flatMap(([, iv = "", ciphertext = ""]) =>
        Effect.all([base64(iv, "decrypt"), base64(ciphertext, "decrypt")]),
      ),
    );
    const key = yield* fileKey();
    const plain = yield* Effect.tryPromise({
      try: () => crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData }, key, ciphertext),
      catch: failWith("decrypt"),
    });
    return new TextDecoder().decode(plain);
  });

  const write = (password: string) =>
    Effect.gen(function* () {
      const key = yield* fileKey();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = yield* Effect.tryPromise({
        try: () =>
          crypto.subtle.encrypt(
            { name: "AES-GCM", iv, additionalData },
            key,
            new TextEncoder().encode(password),
          ),
        catch: failWith("write"),
      });
      const temporary = `${file}.tmp-${process.pid}`;
      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 }).pipe(
        Effect.andThen(
          fs.writeFileString(
            temporary,
            `v1:${Base64.encode(iv)}:${Base64.encode(new Uint8Array(ciphertext))}\n`,
            { mode: 0o600 },
          ),
        ),
        Effect.andThen(fs.rename(temporary, file)),
        Effect.onError(() => fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
        Effect.mapError(failWith("write")),
      );
    });

  const remove = fs.exists(file).pipe(
    Effect.tap(() => fs.remove(file, { force: true })),
    Effect.mapError(failWith("delete")),
  );

  return {
    getPassword: read.pipe(
      Effect.when(fs.exists(file).pipe(Effect.mapError(failWith("read")))),
      Effect.map(Option.getOrNull),
    ),
    setPassword: write,
    deletePassword: remove,
    deleteCredential: remove,
  } satisfies KeyringEntry;
});

/** The OS keychain entry. Opening it loads the native addon, so a failure to load fails the open. */
const keychainEntry = (service: string, account: string) =>
  requireRuntime("@napi-rs/keyring").pipe(
    Effect.flatMap(({ AsyncEntry }) => Effect.try(() => new AsyncEntry(service, account))),
    Effect.map((entry): KeyringEntry => ({
      // Native Windows keyring returns null for an absent entry, despite its undefined-only typings.
      getPassword: nativePromise(() => entry.getPassword()).pipe(
        Effect.map((password) => password ?? null),
      ),
      setPassword: (password) => nativePromise(() => entry.setPassword(password)),
      deletePassword: nativePromise(() => entry.deletePassword()),
      deleteCredential: nativePromise(() => entry.deleteCredential()),
    })),
  );

/** Opens one secret entry in the given backend. */
export const keyringEntry: {
  (account: string, backend: SecretBackend): (service: string) => OpenedEntry;
} & typeof keyringEntryBody = EffectFunction.dual(3, keyringEntryBody);
type OpenedEntry = Effect.Effect<
  KeyringEntry,
  Cause.UnknownError,
  FileSystem.FileSystem | Path.Path
>;
function keyringEntryBody(service: string, account: string, backend: SecretBackend): OpenedEntry {
  return SecretBackend.$match(backend, {
    keychain: (): OpenedEntry => keychainEntry(service, account),
    file: (file): OpenedEntry => fileEntry(file, service, account),
  });
}

/** Why an entry in the backend this process was started with could not be opened or used. */
export type KeyringOpenFailure = KeyringFailure | Config.ConfigError;

/** Opens one secret entry in the backend this process was started with. */
export const openKeyringEntry: {
  (account: string): (service: string) => ReturnType<typeof openKeyringEntryBody>;
} & typeof openKeyringEntryBody = EffectFunction.dual(2, openKeyringEntryBody);
function openKeyringEntryBody(service: string, account: string) {
  return Effect.flatMap(configuredBackend, (backend) => keyringEntry(service, account, backend));
}
