import {
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
import { runNativeEffect } from "./native-effect.ts";
import { nodePlatform } from "./node-platform.ts";
import { requireRuntime } from "./resources.ts";
import { sha256 } from "./synchronous-crypto.ts";

/** The keychain entry operations the app uses; `@napi-rs/keyring`'s `AsyncEntry` has this shape. */
export interface KeyringEntry {
  getPassword(): Promise<string | null | undefined>;
  setPassword(password: string): Promise<void>;
  deletePassword(): Promise<boolean>;
  deleteCredential(): Promise<boolean>;
}

/** The encrypted secret directory could not be used. Never answered by falling back to the OS keychain. */
export class SecretFileStoreFailed extends Schema.TaggedError<SecretFileStoreFailed>()(
  "SecretFileStoreFailed",
  {
    reason: Schema.Literals(["key_missing", "key_invalid", "read", "write", "delete", "decrypt"]),
  },
) {}
type FailureReason = SecretFileStoreFailed["reason"];

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

// The file system and path services own no resources; entries run their Effects through the
// process's platform runtime.
const fs = nodePlatform.runSync(FileSystem.FileSystem);
const path = nodePlatform.runSync(Path.Path);

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

/** 32 random bytes in Base64, e.g. `openssl rand -base64 32`. Read on use, so a rotated key file applies. */
const fileKey = Effect.fn("keyring.fileKey")(function* ({ key, keyFile }: FileBackend) {
  const encoded = yield* Option.match(key, {
    onSome: Effect.succeed,
    onNone: () =>
      Option.match(keyFile, {
        onSome: (file) => fs.readFileString(file).pipe(Effect.mapError(failWith("key_missing"))),
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

const fileEntry = (backend: FileBackend, service: string, account: string): KeyringEntry => {
  const { directory } = backend;
  const file = path.join(directory, `${sha256(`${service}\n${account}`)}.secret`);
  // Binds each ciphertext to its entry, so a file copied over another entry does not decrypt.
  const additionalData = new TextEncoder().encode(`${service}\n${account}`);

  const read = Effect.gen(function* () {
    const stored = yield* fs.readFileString(file).pipe(Effect.mapError(failWith("read")));
    const [iv, ciphertext] = yield* Effect.succeed(stored.trim().split(":")).pipe(
      Effect.filterOrFail((parts) => parts.length === 3 && parts[0] === "v1", failWith("decrypt")),
      Effect.flatMap(([, iv = "", ciphertext = ""]) =>
        Effect.all([base64(iv, "decrypt"), base64(ciphertext, "decrypt")]),
      ),
    );
    const key = yield* fileKey(backend);
    const plain = yield* Effect.tryPromise({
      try: () => crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData }, key, ciphertext),
      catch: failWith("decrypt"),
    });
    return new TextDecoder().decode(plain);
  });

  const write = (password: string) =>
    Effect.gen(function* () {
      const key = yield* fileKey(backend);
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
    getPassword: () =>
      runNativeEffect(
        read.pipe(
          Effect.when(fs.exists(file).pipe(Effect.mapError(failWith("read")))),
          Effect.map(Option.getOrNull),
        ),
      ),
    setPassword: (password) => runNativeEffect(write(password)),
    deletePassword: () => runNativeEffect(remove),
    deleteCredential: () => runNativeEffect(remove),
  };
};

/** Opens one secret entry in the given backend. */
export const keyringEntry: {
  (account: string, backend: SecretBackend): (service: string) => KeyringEntry;
} & typeof keyringEntryBody = EffectFunction.dual(3, keyringEntryBody);
function keyringEntryBody(service: string, account: string, backend: SecretBackend): KeyringEntry {
  return SecretBackend.$match(backend, {
    keychain: (): KeyringEntry =>
      new (requireRuntime("@napi-rs/keyring").AsyncEntry)(service, account),
    file: (file) => fileEntry(file, service, account),
  });
}

/** Opens one secret entry in the backend this process was started with. */
export const openKeyringEntry: {
  (account: string): (service: string) => KeyringEntry;
} & typeof openKeyringEntryBody = EffectFunction.dual(2, openKeyringEntryBody);
function openKeyringEntryBody(service: string, account: string): KeyringEntry {
  return keyringEntry(service, account, Effect.runSync(configuredBackend));
}
