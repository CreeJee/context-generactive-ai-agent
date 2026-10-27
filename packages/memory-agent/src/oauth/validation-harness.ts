import { nativePromise } from "../runtime/native-effect.ts";
import { Result } from "effect";
import { isTruthy } from "../truthy.ts";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import { optionalProperty } from "../optional-property.ts";
import {
  Cause,
  Context,
  Crypto,
  Data,
  Deferred,
  Fiber,
  Effect,
  FileSystem,
  Semaphore,
  Stream,
  HashMap,
  HashSet,
  MutableHashSet,
  DateTime,
  Option,
  Path,
  Predicate,
  Ref,
  Schema,
  Layer,
  Scope,
  Exit,
} from "effect";
import { NetAddress } from "effect/net";
import { JsonValue } from "../json.ts";
import { type KeyringFailure, openKeyringEntry } from "../runtime/keyring.ts";
import { SubscriptionAccountProvider } from "../providers/contracts.ts";
import { prepareAnthropicValidationBody } from "./anthropic-validation-adapter.ts";
import {
  createChunkedPasswordEntry,
  type ChunkedPasswordFailure,
  type PasswordEntry,
} from "./chunked-password-entry.ts";
import {
  fetchOpenAiTokenViaSystemProxy,
  ProxyRoute,
  type TokenProxyResult,
} from "./windows-token-proxy.ts";
import {
  createOAuthState,
  createPkce,
  decodeProviderEvent,
  ProviderFeatureRejectedError,
  ProviderStatusRejected,
  ProviderStreamFailed,
  RequestNotSent,
  RequestOutcomeUnknown,
  ResponseInterrupted,
  type NormalizedStreamEvent,
  type OAuthProvider,
  type ProviderProtocol,
} from "./protocol.ts";

export const StoredCredentialSchema = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.String,
  idToken: Schema.optional(Schema.String),
  accountId: Schema.optional(Schema.String),
  expiresAt: Schema.Finite,
});

export interface StoredCredential {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly idToken?: string;
  readonly accountId?: string;
  readonly expiresAt: number;
}

const decodeStoredCredential = Schema.decodeUnknownOption(
  Schema.fromJsonString(StoredCredentialSchema),
);
const encodeStoredCredential = Schema.encodeEffect(Schema.fromJsonString(StoredCredentialSchema));

export interface CredentialStore {
  readonly read: (
    provider: OAuthProvider,
  ) => Effect.Effect<StoredCredential | null, OAuthHarnessError>;
  readonly write: (
    provider: OAuthProvider,
    credential: StoredCredential,
  ) => Effect.Effect<void, OAuthHarnessError>;
  readonly remove: (provider: OAuthProvider) => Effect.Effect<void, OAuthHarnessError>;
}

export const providerKeychainService = (provider: OAuthProvider) =>
  `com.context-agent.oauth.${provider}`;

export const CredentialStoreStage = Schema.Literals([
  "module_load",
  "entry_open",
  "read",
  "decode",
  "write",
  "delete",
]);
export type CredentialStoreStage = typeof CredentialStoreStage.Type;

const credentialStoreFailure = (provider: OAuthProvider, stage: CredentialStoreStage) =>
  OAuthHarnessError.fromCode("credential_store_unavailable", null, {
    provider,
    operation: "credential_store",
    credentialStage: stage,
  });

/** A failed open keeps its `entry_open` stage; any other failure is the stage of the call. */
const storeFailure = (provider: OAuthProvider, stage: CredentialStoreStage) => (cause: unknown) =>
  Schema.is(OAuthHarnessError)(cause) ? cause : credentialStoreFailure(provider, stage);

/** Credentials in the vault entry `open` gives each provider; never in SQLite. */
export const createKeychainCredentialStore = <E>(
  open: (provider: OAuthProvider) => Effect.Effect<PasswordEntry<E>, E>,
): CredentialStore => ({
  read: (provider) =>
    Effect.gen(function* () {
      const encoded = yield* Effect.flatMap(open(provider), (entry) => entry.getPassword).pipe(
        Effect.mapError(storeFailure(provider, "read")),
      );
      if (encoded === null) return null;
      const credential = yield* Effect.fromOption(decodeStoredCredential(encoded), () =>
        credentialStoreFailure(provider, "decode"),
      );
      return {
        accessToken: credential.accessToken,
        refreshToken: credential.refreshToken,
        expiresAt: credential.expiresAt,
        ...optionalProperty("idToken", credential.idToken),
        ...optionalProperty("accountId", credential.accountId),
      };
    }),
  write: (provider, credential) =>
    encodeStoredCredential(credential).pipe(
      Effect.flatMap((encoded) =>
        Effect.flatMap(open(provider), (entry) => entry.setPassword(encoded)),
      ),
      Effect.mapError(storeFailure(provider, "write")),
    ),
  remove: (provider) =>
    Effect.flatMap(open(provider), (entry) => entry.deleteCredential).pipe(
      Effect.mapError(storeFailure(provider, "delete")),
      Effect.asVoid,
    ),
});

type KeychainEntryFailure = OAuthHarnessError | KeyringFailure;
type KeychainPlatform = FileSystem.FileSystem | Path.Path | Crypto.Crypto;

/** The OS vault entry of a provider's account; on Windows a long credential is kept in fragments. */
const keychainEntry =
  (options: { readonly platform: Context.Context<KeychainPlatform>; readonly account: string }) =>
  (
    provider: OAuthProvider,
  ): Effect.Effect<
    PasswordEntry<KeychainEntryFailure | ChunkedPasswordFailure>,
    KeychainEntryFailure | ChunkedPasswordFailure
  > => {
    // Opening an entry also loads the native keyring addon; `module_load` stays decodable for old records.
    const open = (
      account: string,
    ): Effect.Effect<PasswordEntry<KeychainEntryFailure>, KeychainEntryFailure> =>
      openKeyringEntry(providerKeychainService(provider), account).pipe(
        Effect.mapError(() => credentialStoreFailure(provider, "entry_open")),
        Effect.provideContext(options.platform),
      );
    return process.platform === "win32"
      ? Effect.provideContext(
          createChunkedPasswordEntry({ open, account: options.account }),
          options.platform,
        )
      : open(options.account);
  };

/** Credentials kept in memory only, keyed by account and provider. */
const memoryCredentialStore = (
  values: Ref.Ref<HashMap.HashMap<string, StoredCredential>>,
  account: string,
): CredentialStore => {
  const key = (provider: OAuthProvider) => `${account}:${provider}`;
  return {
    read: (provider) =>
      Effect.map(Ref.get(values), (stored) => Option.getOrNull(HashMap.get(stored, key(provider)))),
    write: (provider, credential) => Ref.update(values, HashMap.set(key(provider), credential)),
    remove: (provider) => Ref.update(values, HashMap.remove(key(provider))),
  };
};

/** A keychain slot was asked for with an id no profile can have. */
export class OAuthProfileIdRejected extends Schema.TaggedError<OAuthProfileIdRejected>()(
  "OAuthProfileIdRejected",
  {},
) {
  override get message() {
    return "invalid_oauth_profile_id";
  }
}

const profileIdPattern =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|legacy-(?:openai|anthropic))$/;

export const OAuthHarnessFailure = Schema.Literals([
  "cancelled",
  "callback_invalid",
  "callback_state_mismatch",
  "callback_timeout",
  "credential_store_unavailable",
  "invalid_token_response",
  "login_in_progress",
  "not_connected",
  "provider_rejected",
  "transport_unavailable",
]);
export type OAuthHarnessFailure = typeof OAuthHarnessFailure.Type;

const failureMessages: Record<OAuthHarnessFailure, string> = {
  cancelled: "OAuth login was cancelled.",
  callback_invalid: "OAuth callback was invalid.",
  callback_state_mismatch: "OAuth callback state did not match.",
  callback_timeout: "OAuth callback timed out.",
  credential_store_unavailable: "The OS credential store is unavailable.",
  invalid_token_response: "The provider returned an invalid token response.",
  login_in_progress: "An OAuth login is already in progress.",
  not_connected: "The provider is not connected.",
  provider_rejected: "The provider rejected the request.",
  transport_unavailable: "The provider could not be reached.",
};

export const OAuthHarnessOperation = Schema.Literals([
  "credential_store",
  "login_callback",
  "model_catalog",
  "model_stream",
  "subscription_usage",
  "token_exchange",
  "token_refresh",
]);
export type OAuthHarnessOperation = typeof OAuthHarnessOperation.Type;

/** A fixed explanation appended to the message; never provider text. */
const OAuthHarnessDetail = Schema.Literals(["catalog_pagination_unbounded"]);
const detailMessages: Record<typeof OAuthHarnessDetail.Type, string> = {
  catalog_pagination_unbounded: "Model catalog pagination did not terminate.",
};

export interface OAuthHarnessErrorContext {
  readonly provider?: OAuthProvider;
  readonly operation?: OAuthHarnessOperation;
  readonly detail?: typeof OAuthHarnessDetail.Type;
  /** A short machine-readable provider code, never a raw response body. */
  readonly providerCode?: string;
  /** Fixed stage only; never a native exception message or credential. */
  readonly credentialStage?: CredentialStoreStage;
  /** Allowlisted network/TLS code or a fixed category; never the native exception text. */
  readonly transportCode?: string;
  /** Fixed route outcome only; never a proxy URL or credentials. */
  readonly proxyRoute?: ProxyRoute;
}

const safeTransportCodes = HashSet.fromIterable([
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);
const NativeCause = Schema.Struct({ code: Schema.String });
const decodeNativeCause = Schema.decodeUnknownOption(NativeCause);
const safeTransportCode = (error: Error): string =>
  error.name === "TimeoutError"
    ? "timeout"
    : decodeNativeCause(error.cause).pipe(
        Option.map((cause) => cause.code),
        Option.filter((code) => HashSet.has(safeTransportCodes, code)),
        Option.getOrElse(() => "other"),
      );
/** The transport code of a rejected native request; anything but an `Error` is `other`. */
const transportCodeOf = (cause: unknown) =>
  Predicate.isError(cause) ? safeTransportCode(cause) : "other";

// Codes raised before any request byte is written: name resolution, TCP connect or TLS handshake.
// ETIMEDOUT, ECONNRESET and socket/header errors can follow a written request and stay uncertain.
const RequestNotSentCode = Schema.Literals([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);
const isRequestNotSentCode = Schema.is(RequestNotSentCode);
const requestNotSentStages = {
  ENOTFOUND: "dns",
  EAI_AGAIN: "dns",
  ECONNREFUSED: "connect",
  ENETUNREACH: "connect",
  EHOSTUNREACH: "connect",
  UND_ERR_CONNECT_TIMEOUT: "connect",
  CERT_HAS_EXPIRED: "tls",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "tls",
  SELF_SIGNED_CERT_IN_CHAIN: "tls",
  DEPTH_ZERO_SELF_SIGNED_CERT: "tls",
  ERR_TLS_CERT_ALTNAME_INVALID: "tls",
} as const satisfies Record<typeof RequestNotSentCode.Type, typeof RequestNotSent.Type.stage>;

const modelRequestFailed = (provider: OAuthProvider, transportCode: string) =>
  ProviderStreamFailed.make({
    provider,
    reason: isRequestNotSentCode(transportCode)
      ? RequestNotSent.make({ stage: requestNotSentStages[transportCode] })
      : RequestOutcomeUnknown.make({}),
  });

const providerName = (provider: OAuthProvider) => (provider === "openai" ? "OpenAI" : "Anthropic");

const safeOAuthCodes = HashSet.fromIterable([
  "access_denied",
  "invalid_client",
  "invalid_grant",
  "invalid_request",
  "invalid_scope",
  "server_error",
  "temporarily_unavailable",
  "unauthorized_client",
  "unsupported_grant_type",
]);
const TokenErrorBody = Schema.Struct({
  error: Schema.Union([Schema.String, Schema.Struct({ code: Schema.String })]),
});
const decodeTokenErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(TokenErrorBody));
const providerCode = (body: string): string | undefined =>
  decodeTokenErrorBody(body).pipe(
    Option.map((parsed) =>
      Schema.is(Schema.String)(parsed.error) ? parsed.error : parsed.error.code,
    ),
    Option.filter((code) => HashSet.has(safeOAuthCodes, code)),
    Option.getOrUndefined,
  );

export class OAuthHarnessError extends Schema.TaggedError<OAuthHarnessError>()(
  "OAuthHarnessError",
  {
    code: OAuthHarnessFailure,
    status: Schema.NullOr(Schema.Int),
    provider: Schema.NullOr(SubscriptionAccountProvider),
    operation: Schema.NullOr(OAuthHarnessOperation),
    /** An allowlisted OAuth error code, never a raw response body. */
    providerCode: Schema.NullOr(Schema.String),
    credentialStage: Schema.NullOr(CredentialStoreStage),
    transportCode: Schema.NullOr(Schema.String),
    proxyRoute: Schema.NullOr(ProxyRoute),
    detail: Schema.NullOr(OAuthHarnessDetail),
  },
) {
  static fromCode(
    code: OAuthHarnessFailure,
    status: number | null = null,
    context: OAuthHarnessErrorContext = {},
  ) {
    return OAuthHarnessError.make({
      code,
      status,
      provider: context.provider ?? null,
      operation: context.operation ?? null,
      providerCode: context.providerCode ?? null,
      credentialStage: context.credentialStage ?? null,
      transportCode: context.transportCode ?? null,
      proxyRoute: context.proxyRoute ?? null,
      detail: context.detail ?? null,
    });
  }

  override get message() {
    const details = [
      this.provider === null ? null : `provider=${providerName(this.provider)}`,
      this.operation === null ? null : `operation=${this.operation}`,
      this.status === null ? null : `status=${this.status}`,
    ].filter((detail) => detail !== null);
    return `oauth_${this.code}${details.length === 0 ? "" : ` [${details.join(", ")}]`}: ${failureMessages[this.code]}${this.detail === null ? "" : ` ${detailMessages[this.detail]}`}`;
  }
}

/** The credential slots of one keychain: the provider's own, and one per local account. */
const keychainSlots = (slot: (account: string) => CredentialStore) => ({
  store: slot("subscription-oauth"),
  // Preserve the original 'subscription-oauth' entry for rollback until migration is verified.
  profileStore: (profileId: string) =>
    profileIdPattern.test(profileId)
      ? Effect.succeed(slot(`subscription-oauth-${profileId}`))
      : Effect.fail(OAuthProfileIdRejected.make()),
});

/** Where subscription OAuth credentials live: one OS keychain slot per provider and account. */
export class OAuthKeychain extends Context.Service<
  OAuthKeychain,
  {
    /** The slot each provider used before local accounts existed. */
    readonly store: CredentialStore;
    /** The slot of one local account; an id no profile can have is refused. */
    readonly profileStore: (
      profileId: string,
    ) => Effect.Effect<CredentialStore, OAuthProfileIdRejected>;
  }
>()("memory-agent/oauth/validation-harness/OAuthKeychain") {
  static readonly keychain = Layer.effect(
    OAuthKeychain,
    Effect.map(Effect.context<KeychainPlatform>(), (platform) =>
      OAuthKeychain.of(
        keychainSlots((account) =>
          createKeychainCredentialStore(keychainEntry({ platform, account })),
        ),
      ),
    ),
  );

  /** Kept in memory only, for tests. */
  static readonly memory = Layer.effect(
    OAuthKeychain,
    Effect.map(Ref.make(HashMap.empty<string, StoredCredential>()), (values) =>
      OAuthKeychain.of(keychainSlots((account) => memoryCredentialStore(values, account))),
    ),
  );
}

// Only a definite refresh-token rejection signs the account out. A 403 is also what an edge proxy,
// region block or rate limiter returns, other 400s can be our own request's fault, and an
// unreadable success body says nothing about the stored token: those keep the login.
const invalidatesStoredCredential = (error: OAuthHarnessError) =>
  error.operation === "token_refresh" &&
  error.code === "provider_rejected" &&
  (error.status === 401 || (error.status === 400 && error.providerCode === "invalid_grant"));

export interface OAuthConnectionStatus {
  readonly provider: OAuthProvider;
  readonly connected: boolean;
  readonly expiresAt: number | null;
}

export interface LoginAttempt<E = OAuthHarnessError> {
  readonly provider: OAuthProvider;
  readonly authorizationUrl: string;
  /** The login's outcome; the login finishes whether or not anything waits for it. */
  readonly completed: Effect.Effect<OAuthConnectionStatus, E>;
  readonly cancel: Effect.Effect<void>;
}

/** What a subscription model stream fails with. */
export type SubscriptionClientFailure =
  | ProviderStreamFailed
  | ProviderFeatureRejectedError
  | OAuthHarnessError;

export interface SubscriptionOAuthClient {
  readonly status: Effect.Effect<OAuthConnectionStatus, OAuthHarnessError>;
  readonly disconnect: Effect.Effect<OAuthConnectionStatus, OAuthHarnessError>;
  readonly startLogin: (options?: {
    readonly timeoutMs?: number;
  }) => Effect.Effect<LoginAttempt, OAuthHarnessError>;
  readonly refreshForValidation: Effect.Effect<OAuthConnectionStatus, OAuthHarnessError>;
  /** The provider's fixed model-catalog pages; credentials never leave the client. */
  readonly modelCatalog: Effect.Effect<ReadonlyArray<JsonValue>, OAuthHarnessError>;
  readonly stream: (
    body: string,
  ) => Stream.Stream<NormalizedStreamEvent, SubscriptionClientFailure>;
}

export interface SubscriptionOAuthClientOptions {
  readonly protocol: ProviderProtocol;
  readonly store: CredentialStore;
  readonly fetch?: typeof fetch;
  /** Injectable one-shot proxy route for tests; production uses Windows user proxy policy. */
  readonly tokenProxyFetch?: (
    url: string,
    body: string,
    contentType: string,
  ) => Effect.Effect<TokenProxyResult, Cause.UnknownError>;
  readonly now?: () => number;
}

/** The SDK's own operating system names; other platforms send Node's name. */
const stainlessOsNames: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "MacOS",
  win32: "Windows",
  linux: "Linux",
};

const utf8 = new TextEncoder();
// Equal-length inputs are compared in constant time: every byte is folded in, with no early exit.
const safeEqual = (left: string, right: string) => {
  const a = utf8.encode(left);
  const b = utf8.encode(right);
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a[index]! ^ b[index]!;
  return difference === 0;
};

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.Finite,
  id_token: Schema.optional(Schema.String),
});
const decodeTokenResponse = Schema.decodeUnknownOption(TokenResponse);

const CatalogPage = Schema.Struct({
  has_more: Schema.optional(Schema.Boolean),
  last_id: Schema.optional(Schema.String),
});
const decodeCatalogPage = Schema.decodeUnknownOption(CatalogPage);

const OpenAiIdClaims = Schema.Struct({
  "https://api.openai.com/auth": Schema.Struct({ chatgpt_account_id: Schema.String }),
});
const decodeOpenAiIdClaims = Schema.decodeUnknownOption(Schema.fromJsonString(OpenAiIdClaims));

const openAiAccountId = (idToken: string) =>
  Option.fromUndefinedOr(idToken.split(".")[1]).pipe(
    Option.flatMap((payload) => decodeOpenAiIdClaims(Buffer.from(payload, "base64url").toString())),
    Option.map((claims) => claims["https://api.openai.com/auth"].chatgpt_account_id),
    Option.getOrUndefined,
  );

const parseTokens = (
  token: typeof TokenResponse.Type,
  previous?: StoredCredential,
): Result.Result<StoredCredential, OAuthHarnessError> =>
  Result.map(
    Result.fromNullishOr(token.refresh_token ?? previous?.refreshToken, () =>
      OAuthHarnessError.fromCode("invalid_token_response"),
    ),
    (refreshToken) => {
      const idToken = token.id_token ?? previous?.idToken;
      const accountId = (idToken && openAiAccountId(idToken)) ?? previous?.accountId;
      const credential: StoredCredential = {
        accessToken: token.access_token,
        refreshToken,
        expiresAt: DateTime.toEpochMillis(DateTime.nowUnsafe()) + token.expires_in * 1_000,
      };
      const withIdentity = idToken === undefined ? credential : { ...credential, idToken };
      return accountId === undefined ? withIdentity : { ...withIdentity, accountId };
    },
  );

interface AuthorizationCodeGrant {
  readonly grant_type: "authorization_code";
  readonly code: string;
  readonly redirect_uri: string;
  readonly client_id: string;
  readonly code_verifier: string;
  readonly state?: string;
}

interface RefreshTokenGrant {
  readonly grant_type: "refresh_token";
  readonly refresh_token: string;
  readonly client_id: string;
  readonly scope?: string;
}

type TokenGrant = AuthorizationCodeGrant | RefreshTokenGrant;

interface EncodedTokenBody {
  readonly body: string;
  readonly contentType: string;
}

const tokenBody = (protocol: ProviderProtocol, values: TokenGrant): EncodedTokenBody =>
  protocol.tokenEncoding === "form"
    ? {
        body: new URLSearchParams(Object.entries(values)).toString(),
        contentType: "application/x-www-form-urlencoded",
      }
    : { body: JSON.stringify(values), contentType: "application/json" };

/** One SSE frame of a provider stream: a decoded event, or the `[DONE]` marker. */
type Frame = Data.TaggedEnum<{
  Event: { readonly event: NormalizedStreamEvent };
  Done: {};
}>;
const Frame = Data.taggedEnum<Frame>();

// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
function sseEvents(provider: OAuthProvider, response: Response) {
  // The provider accepted the request once headers arrived; any later loss is an interrupted response.
  const interrupted = () =>
    ProviderStreamFailed.make({ provider, reason: ResponseInterrupted.make({}) });
  return Stream.suspend<NormalizedStreamEvent, ProviderStreamFailed, never>(() => {
    if (response.body === null) return Stream.fail(interrupted());
    let buffer = "";
    const frames = function* (part: string): Generator<Frame, void, unknown> {
      buffer += part.replaceAll("\r\n", "\n");
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary < 0) return;
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") {
            yield Frame.Done();
            return;
          }
          const event = decodeProviderEvent(provider, data);
          if (event !== null) yield Frame.Event({ event });
        }
      }
    };
    const body = response.body;
    return Stream.fromReadableStream({
      evaluate: () => body.pipeThrough(new TextDecoderStream()),
      onError: interrupted,
    }).pipe(
      Stream.flatMap((part) => Stream.fromIterable(frames(part))),
      Stream.takeWhile(Frame.$is("Event")),
      Stream.map((frame) => frame.event),
    );
  });
}

export const createSubscriptionOAuthClient = Effect.fnUntraced(function* (
  options: SubscriptionOAuthClientOptions,
): Effect.fn.Return<
  SubscriptionOAuthClient,
  never,
  Crypto.Crypto | ChildProcessSpawner.ChildProcessSpawner
> {
  const { protocol, store } = options;
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const withCrypto = Effect.provideService(Crypto.Crypto, crypto);
  // A failed random source is a defect: nothing here could recover from it.
  const requestId = Effect.orDie(crypto.randomUUIDv4());
  const anthropicSessionId = yield* requestId;
  const proxyFetch =
    options.tokenProxyFetch ??
    (options.fetch === undefined
      ? (url: string, body: string, contentType: string) =>
          fetchOpenAiTokenViaSystemProxy(url, body, contentType).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          )
      : undefined);
  const loginActive = yield* Ref.make(false);
  const refreshLock = yield* Semaphore.make(1);
  type Refresh = {
    readonly token: object;
    readonly load: Effect.Effect<StoredCredential, OAuthHarnessError>;
  };
  const refreshing = yield* Ref.make(Option.none<Refresh>());

  const status = Effect.fn("OAuth.status")(function* (): Effect.fn.Return<
    OAuthConnectionStatus,
    OAuthHarnessError
  > {
    const stored = yield* store.read(protocol.provider);
    const credential =
      stored !== null && stored.expiresAt <= now() + 30_000
        ? yield* refresh(stored).pipe(
            Effect.catchIf(
              (error) => invalidatesStoredCredential(error) || error.code === "not_connected",
              () => Effect.succeed(null),
            ),
          )
        : stored;
    return {
      provider: protocol.provider,
      connected: credential !== null,
      expiresAt: credential?.expiresAt ?? null,
    };
  });

  const startLogin = Effect.fn("OAuth.startLogin")(function* (
    loginOptions: { readonly timeoutMs?: number } = {},
  ): Effect.fn.Return<LoginAttempt, OAuthHarnessError> {
    const pkce = yield* Effect.orDie(withCrypto(createPkce));
    const state =
      protocol.provider === "anthropic"
        ? pkce.verifier
        : yield* Effect.orDie(withCrypto(createOAuthState));
    yield* Effect.when(
      Effect.fail(OAuthHarnessError.fromCode("login_in_progress")),
      Ref.getAndSet(loginActive, true),
    );
    const verifier = yield* Ref.make(Option.some(pkce.verifier));
    const timeoutMs = loginOptions.timeoutMs ?? 120_000;
    const listenerScope = yield* Scope.make();
    const closeListener = Scope.close(listenerScope, Exit.void);
    const serverServices = yield* Layer.buildWithScope(
      NodeHttpServer.layer(NodeHttpServer.createServer, {
        port: protocol.callbackPort ?? 0,
        host: protocol.callbackRedirectHost,
      }),
      listenerScope,
    ).pipe(
      Effect.onError(() => closeListener.pipe(Effect.andThen(Ref.set(loginActive, false)))),
      Effect.mapError(() => OAuthHarnessError.fromCode("transport_unavailable")),
    );
    const server = yield* Effect.provideContext(HttpServer.HttpServer, serverServices);
    if (!NetAddress.isInetAddress(server.address)) {
      yield* closeListener;
      yield* Ref.set(loginActive, false);
      return yield* OAuthHarnessError.fromCode("transport_unavailable");
    }
    const port = server.address.port;
    const redirectAuthority = `${protocol.callbackRedirectHost}:${port}`;
    const redirectUri = `http://${redirectAuthority}${protocol.callbackPath}`;
    const authorize = new URL(protocol.authorizeUrl);
    Object.entries({
      response_type: "code",
      client_id: protocol.clientId,
      redirect_uri: redirectUri,
      scope: protocol.scopes,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      state,
      ...protocol.authorizeParameters,
    }).forEach(([key, value]) => authorize.searchParams.set(key, value));

    // Login completion has its own lifetime and explicit cancellation, independent of the HTTP request.
    const completion = yield* Deferred.make<OAuthConnectionStatus, OAuthHarnessError>();
    const finished = yield* Ref.make(false);
    const callbackClaimed = yield* Ref.make(false);
    const finish = Effect.fn("OAuth.finishLogin")(function* (
      result: Result.Result<OAuthConnectionStatus, OAuthHarnessError>,
      fromTimeout: boolean = false,
    ): Effect.fn.Return<void> {
      if (yield* Ref.getAndSet(finished, true)) return;
      yield* Ref.set(verifier, Option.none());
      yield* Ref.set(loginActive, false);
      // Closing the listener waits for an in-flight callback, which first rolls back its own
      // write; the login reports its outcome after that, without holding up the caller.
      yield* Effect.forkDetach(
        Effect.gen(function* () {
          yield* Effect.when(Fiber.interrupt(timer), Effect.succeed(!fromTimeout));
          yield* closeListener;
          yield* Result.match(result, {
            onSuccess: (status) => Deferred.succeed(completion, status),
            onFailure: (error) => Deferred.fail(completion, error),
          });
        }),
      );
    });
    const timer = yield* Effect.sleep(timeoutMs).pipe(
      Effect.andThen(() =>
        finish(Result.fail(OAuthHarnessError.fromCode("callback_timeout")), true),
      ),
      Effect.forkDetach,
    );
    // HttpEffect closes each request Scope only after writing its response. Finish from a
    // detached finalizer Fiber so closing the listener never interrupts its own callback.
    const settleAfterResponse = (result: Result.Result<OAuthConnectionStatus, OAuthHarnessError>) =>
      Effect.addFinalizer(() => Effect.forkDetach(finish(result)).pipe(Effect.asVoid));
    const callbackResponse = (text: string, status: number) =>
      HttpServerResponse.text(text, { status, headers: { connection: "close" } });
    const consumed = () => callbackResponse("OAuth callback already consumed.", 410);
    const onCallback = Effect.fn("OAuth.loginCallback")(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if ((yield* Ref.get(callbackClaimed)) || (yield* Ref.get(finished))) {
        return consumed();
      }
      const callback = new URL(request.url, redirectUri);
      if (
        request.method !== "GET" ||
        callback.pathname !== protocol.callbackPath ||
        request.headers.host !== redirectAuthority
      ) {
        return callbackResponse("Invalid OAuth callback.", 400);
      }
      // Admission happens before any suspension; replay cannot exchange or settle twice.
      if (yield* Ref.getAndSet(callbackClaimed, true)) return consumed();
      const returnedState = callback.searchParams.get("state");
      const code = callback.searchParams.get("code");
      if (returnedState === null || !safeEqual(returnedState, state)) {
        yield* settleAfterResponse(
          Result.fail(OAuthHarnessError.fromCode("callback_state_mismatch")),
        );
        return callbackResponse("OAuth state mismatch.", 400);
      }
      const codeVerifier = yield* Ref.get(verifier);
      if (code === null || code.length === 0 || Option.isNone(codeVerifier)) {
        const callbackCode = callback.searchParams.get("error");
        yield* settleAfterResponse(
          Result.fail(
            callbackCode !== null && HashSet.has(safeOAuthCodes, callbackCode)
              ? OAuthHarnessError.fromCode("provider_rejected", null, {
                  provider: protocol.provider,
                  operation: "login_callback",
                  providerCode: callbackCode,
                })
              : OAuthHarnessError.fromCode("callback_invalid"),
          ),
        );
        return callbackResponse("Invalid OAuth callback.", 400);
      }
      /** The credential stored before this login wrote its own; none until it writes. */
      const rollback = yield* Ref.make(Option.none<StoredCredential | null>());
      // A login cancelled or timed out meanwhile stops before its next step.
      const unlessFinished = Effect.when(
        Effect.fail(OAuthHarnessError.fromCode("cancelled")),
        Ref.get(finished),
      );
      return yield* Effect.gen(function* () {
        yield* unlessFinished;
        const commonGrant = {
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: protocol.clientId,
          code_verifier: codeVerifier.value,
        } as const;
        const grant: AuthorizationCodeGrant =
          protocol.provider === "anthropic" ? { ...commonGrant, state } : commonGrant;
        const credential = yield* exchange(grant);
        yield* unlessFinished;
        const previous = yield* store.read(protocol.provider);
        yield* unlessFinished;
        yield* Ref.set(rollback, Option.some(previous));
        yield* store.write(protocol.provider, credential);
        yield* unlessFinished;
        const connection = yield* status();
        yield* unlessFinished;
        yield* settleAfterResponse(Result.succeed(connection));
        return callbackResponse("Connected. You may close this window.", 200);
      }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            // Best-effort rollback of a written credential; the login already failed with `error`.
            yield* Effect.transposeOption(
              Option.map(yield* Ref.get(rollback), (previous) =>
                (previous === null
                  ? store.remove(protocol.provider)
                  : store.write(protocol.provider, previous)
                ).pipe(
                  Effect.catchTag("OAuthHarnessError", () =>
                    Effect.logWarning("OAuth credential rollback failed", {
                      error: "OAuthHarnessError",
                    }),
                  ),
                ),
              ),
            );
            yield* settleAfterResponse(Result.fail(error));
            return callbackResponse(
              error.code === "credential_store_unavailable"
                ? "Login succeeded, but the system credential store is unavailable. Return to the app for diagnostic details."
                : "Login could not be completed. Return to the app for diagnostic details.",
              error.code === "cancelled" ? 410 : 502,
            );
          }),
        ),
      );
    });
    yield* Effect.provideContext(
      Scope.provide(HttpServer.serveEffect(onCallback()), listenerScope),
      serverServices,
    );
    return {
      provider: protocol.provider,
      authorizationUrl: authorize.toString(),
      completed: Deferred.await(completion),
      cancel: finish(Result.fail(OAuthHarnessError.fromCode("cancelled"))),
    };
  });

  const exchange = Effect.fn("OAuth.exchange")(function* (
    values: TokenGrant,
    previous?: StoredCredential,
  ) {
    const context: OAuthHarnessErrorContext = {
      provider: protocol.provider,
      operation: values.grant_type === "refresh_token" ? "token_refresh" : "token_exchange",
    };
    const encoded = tokenBody(protocol, values);
    const withProxyRoute = (
      details: OAuthHarnessErrorContext,
      route: Option.Option<ProxyRoute>,
    ): OAuthHarnessErrorContext => ({
      ...details,
      ...optionalProperty("proxyRoute", Option.getOrUndefined(route)),
    });
    /** The one proxy retry after a direct request that could not connect; only OpenAI's login takes it. */
    const retryThroughProxy = Effect.fnUntraced(function* (transportCode: string) {
      const unavailable = (route: Option.Option<ProxyRoute>) =>
        OAuthHarnessError.fromCode(
          "transport_unavailable",
          null,
          withProxyRoute({ ...context, transportCode }, route),
        );
      if (
        protocol.provider !== "openai" ||
        values.grant_type !== "authorization_code" ||
        transportCode !== "UND_ERR_CONNECT_TIMEOUT" ||
        proxyFetch === undefined
      )
        return yield* unavailable(Option.none());
      const retry = yield* proxyFetch(protocol.tokenUrl, encoded.body, encoded.contentType).pipe(
        Effect.mapError((failure) =>
          OAuthHarnessError.fromCode("transport_unavailable", null, {
            ...context,
            transportCode: transportCodeOf(failure.cause),
            proxyRoute: "attempted",
          }),
        ),
      );
      const route = Option.some(retry.route);
      return yield* Option.match(Option.fromNullishOr(retry.response), {
        onNone: () => Effect.fail(unavailable(route)),
        onSome: (response) => Effect.succeed({ response, route }),
      });
    });
    const { response, route } = yield* Effect.tryPromise({
      try: (signal) =>
        fetcher(protocol.tokenUrl, {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": encoded.contentType },
          body: encoded.body,
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        }),
      catch: transportCodeOf,
    }).pipe(
      Effect.map((response) => ({ response, route: Option.none<ProxyRoute>() })),
      Effect.catch(retryThroughProxy),
    );
    if (!response.ok) {
      // The body is read only for an allowlisted OAuth code; an unreadable body has none.
      const body = yield* nativePromise(() => response.text()).pipe(Effect.orElseSucceed(() => ""));
      return yield* OAuthHarnessError.fromCode(
        "provider_rejected",
        response.status,
        withProxyRoute(
          { ...context, ...optionalProperty("providerCode", providerCode(body)) },
          route,
        ),
      );
    }
    const invalidResponse = () =>
      OAuthHarnessError.fromCode("invalid_token_response", response.status, context);
    const body = yield* nativePromise(() => response.json()).pipe(Effect.mapError(invalidResponse));
    const token = yield* Effect.fromOption(decodeTokenResponse(body), invalidResponse);
    const parsed = yield* Effect.fromResult(parseTokens(token, previous));
    return {
      ...parsed,
      expiresAt: now() + (parsed.expiresAt - DateTime.toEpochMillis(DateTime.nowUnsafe())),
    };
  });
  const refresh = Effect.fn("OAuth.refresh")(function* (credential: StoredCredential) {
    const begin = Effect.gen(function* () {
      // The caller's credential may predate a refresh that finished while it waited. Refresh
      // tokens rotate, so spending the old one would be rejected and sign out the new login.
      const stored = yield* store.read(protocol.provider).pipe(
        Effect.filterOrFail(Predicate.isNotNull, () =>
          OAuthHarnessError.fromCode("not_connected", null, {
            provider: protocol.provider,
            operation: "token_refresh",
          }),
        ),
      );
      if (stored.refreshToken !== credential.refreshToken) {
        const current: Refresh = { token: {}, load: Effect.succeed(stored) };
        return current;
      }
      const token = {};
      const load = yield* Effect.cachedWithTTL(
        Effect.gen(function* () {
          const commonGrant = {
            grant_type: "refresh_token",
            refresh_token: credential.refreshToken,
            client_id: protocol.clientId,
          } as const;
          const grant: RefreshTokenGrant =
            protocol.provider === "anthropic"
              ? { ...commonGrant, scope: protocol.scopes.replace("org:create_api_key ", "") }
              : commonGrant;
          const next = yield* exchange(grant, credential);
          yield* store.write(protocol.provider, next);
          return next;
        }).pipe(
          Effect.tapError((error) =>
            Effect.when(
              store.remove(protocol.provider),
              Effect.succeed(invalidatesStoredCredential(error)),
            ),
          ),
          // An OS credential write cannot be cancelled; every waiter shares one owner operation.
          Effect.uninterruptible,
          Effect.ensuring(
            Ref.update(
              refreshing,
              Option.filter((current) => current.token !== token),
            ),
          ),
        ),
        0,
      );
      const next: Refresh = { token, load };
      yield* Ref.set(refreshing, Option.some(next));
      return next;
    });
    const entry = yield* refreshLock.withPermits(1)(
      Effect.flatMap(
        Ref.get(refreshing),
        Option.match({ onSome: Effect.succeed, onNone: () => begin }),
      ),
    );
    return yield* entry.load;
  });
  /** The stored credential, refreshed first when it is about to expire. */
  const freshCredential = (context: OAuthHarnessErrorContext) =>
    store.read(protocol.provider).pipe(
      Effect.filterOrFail(isTruthy, () =>
        OAuthHarnessError.fromCode("not_connected", null, context),
      ),
      Effect.filterOrElse((credential) => credential.expiresAt > now() + 30_000, refresh),
    );

  const authorizedCatalogRequest = Effect.fn("OAuth.catalogRequest")(function* (
    url: URL,
    credential: StoredCredential,
    timeout: AbortSignal,
  ) {
    const headers = new Headers(protocol.modelHeaders);
    headers.set("Accept", "application/json");
    headers.delete("Content-Type");
    headers.set("Authorization", `Bearer ${credential.accessToken}`);
    if (protocol.provider === "openai" && credential.accountId !== undefined)
      headers.set("chatgpt-account-id", credential.accountId);
    if (protocol.provider === "anthropic") {
      headers.set("x-client-request-id", yield* requestId);
      headers.set("X-Claude-Code-Session-Id", anthropicSessionId);
    }
    return yield* Effect.tryPromise({
      try: (signal) =>
        fetcher(url, {
          method: "GET",
          headers,
          redirect: "error",
          signal: AbortSignal.any([signal, timeout]),
        }),
      catch: () =>
        OAuthHarnessError.fromCode("transport_unavailable", null, {
          provider: protocol.provider,
          operation: "model_catalog",
        }),
    });
  });

  /** Fetches only the provider's fixed model-catalog endpoint and never returns credentials. */
  const modelCatalog = Effect.fn("OAuth.modelCatalog")(function* () {
    const context: OAuthHarnessErrorContext = {
      provider: protocol.provider,
      operation: "model_catalog",
    };
    let credential = yield* freshCredential(context);

    const pages: Array<JsonValue> = [];
    // Native HTTP boundary: keep the existing timeout and the Effect owner's
    // interruption signal across every page/retry of this single catalog load.
    const timeout = AbortSignal.timeout(30_000);
    const seenCursors = MutableHashSet.empty<string>();
    let afterId: string | undefined;
    for (;;) {
      const url = new URL(protocol.catalogUrl);
      if (protocol.provider === "anthropic") {
        url.searchParams.set("limit", "1000");
        if (afterId !== undefined) url.searchParams.set("after_id", afterId);
      }
      let response = yield* authorizedCatalogRequest(url, credential, timeout);
      if (protocol.refreshStatuses.includes(response.status)) {
        credential = yield* refresh(credential);
        response = yield* authorizedCatalogRequest(url, credential, timeout);
      }
      if (!response.ok)
        return yield* OAuthHarnessError.fromCode("provider_rejected", response.status, context);
      const page = yield* nativePromise(() => response.json()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(JsonValue)),
        Effect.mapError(() =>
          OAuthHarnessError.fromCode("provider_rejected", response.status, context),
        ),
      );
      pages.push(page);
      if (protocol.provider !== "anthropic") break;
      const pagination = Option.getOrUndefined(decodeCatalogPage(page));
      if (pagination?.has_more !== true || pagination.last_id === undefined) break;
      if (pages.length >= 10 || MutableHashSet.has(seenCursors, pagination.last_id))
        return yield* OAuthHarnessError.fromCode("provider_rejected", null, {
          ...context,
          detail: "catalog_pagination_unbounded",
        });
      MutableHashSet.add(seenCursors, pagination.last_id);
      afterId = pagination.last_id;
    }
    const catalog: ReadonlyArray<JsonValue> = pages;
    return catalog;
  });

  const streamResponse = Effect.fn("OAuth.streamResponse")(function* (serializedBody: string) {
    const context: OAuthHarnessErrorContext = {
      provider: protocol.provider,
      operation: "model_stream",
    };
    let credential = yield* freshCredential(context);

    const prepared =
      protocol.provider === "anthropic"
        ? prepareAnthropicValidationBody(serializedBody, anthropicSessionId)
        : { body: serializedBody, betas: [] };
    const providerBody = prepared.body;

    const request = Effect.fnUntraced(function* (current: StoredCredential) {
      const headers = new Headers(protocol.modelHeaders);
      headers.set("Authorization", `Bearer ${current.accessToken}`);
      if (protocol.provider === "openai" && current.accountId !== undefined)
        headers.set("chatgpt-account-id", current.accountId);
      if (protocol.provider === "anthropic") {
        headers.set("x-client-request-id", yield* requestId);
        headers.set("X-Claude-Code-Session-Id", anthropicSessionId);
        if (prepared.betas.length > 0)
          headers.set(
            "anthropic-beta",
            [headers.get("anthropic-beta"), ...prepared.betas].filter(isTruthy).join(","),
          );
        headers.set("X-Stainless-Arch", process.arch === "x64" ? "x64" : process.arch);
        headers.set("X-Stainless-OS", stainlessOsNames[process.platform] ?? process.platform);
      }
      return yield* Effect.tryPromise({
        try: (signal) =>
          fetcher(protocol.modelUrl, {
            method: "POST",
            headers,
            body: providerBody,
            redirect: "error",
            signal,
          }),
        catch: (error) => modelRequestFailed(protocol.provider, transportCodeOf(error)),
      });
    });

    let response = yield* request(credential);
    if (protocol.refreshStatuses.includes(response.status)) {
      credential = yield* refresh(credential);
      response = yield* request(credential);
    }
    if (!response.ok) {
      if (
        protocol.provider === "anthropic" &&
        (response.status === 400 || response.status === 422)
      ) {
        // Read only to recognise a prompt-cache rejection; an unreadable body is not one.
        const responseText = yield* nativePromise(() => response.clone().text()).pipe(
          Effect.orElseSucceed(() => ""),
        );
        if (/cache[_ -]?control|prompt[_ -]?cach/i.test(responseText))
          return yield* ProviderFeatureRejectedError.make({
            provider: "anthropic",
            feature: "prompt-cache",
            status: response.status,
          });
      }
      // Only the status class leaves this boundary; the body may echo the prompt or account data.
      return yield* ProviderStreamFailed.make({
        provider: protocol.provider,
        reason: ProviderStatusRejected.make({
          statusClass: response.status >= 500 ? "server_error" : "client_error",
        }),
      });
    }
    return response;
  });

  return {
    status: status(),
    disconnect: Effect.andThen(store.remove(protocol.provider), status()),
    startLogin,
    refreshForValidation: store.read(protocol.provider).pipe(
      Effect.filterOrFail(Predicate.isNotNull, () => OAuthHarnessError.fromCode("not_connected")),
      Effect.flatMap(refresh),
      Effect.andThen(status()),
    ),
    modelCatalog: modelCatalog(),
    stream: (serializedBody) =>
      Stream.fromEffect(streamResponse(serializedBody)).pipe(
        Stream.flatMap((response) => sseEvents(protocol.provider, response)),
      ),
  };
});
