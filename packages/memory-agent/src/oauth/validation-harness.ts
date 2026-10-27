import { nativePromise, runNativeEffect } from "../runtime/native-effect.ts";
import { nativeStream } from "../runtime/native-stream.ts";
import { Result } from "effect";
import { isTruthy } from "../truthy.ts";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { optionalProperty } from "../optional-property.ts";
import {
  Cause,
  Data,
  Deferred,
  Fiber,
  Effect,
  Semaphore,
  Stream,
  HashSet,
  MutableHashSet,
  DateTime,
  Option,
  Predicate,
  Schema,
  Layer,
  Scope,
  Exit,
} from "effect";
import { NetAddress } from "effect/net";
import { type KeyringEntry, type KeyringFailure, openKeyringEntry } from "../runtime/keyring.ts";
import { SubscriptionAccountProvider } from "../providers/contracts.ts";
import { oauthProtocolCrypto, runOAuthNodeEffect } from "./node-runtime.ts";
import { prepareAnthropicValidationBody } from "./anthropic-validation-adapter.ts";
import { createChunkedPasswordEntry, type PasswordEntry } from "./chunked-password-entry.ts";
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

export interface CredentialStore {
  read(provider: OAuthProvider): Promise<StoredCredential | null>;
  write(provider: OAuthProvider, credential: StoredCredential): Promise<void>;
  remove(provider: OAuthProvider): Promise<void>;
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

const keychainEntry = (provider: OAuthProvider, account = "subscription-oauth") => {
  // Opening an entry also loads the native keyring addon; `module_load` stays decodable for old records.
  const open = (account: string): PasswordEntry => {
    const entry = openKeyringEntry(providerKeychainService(provider), account).pipe(
      Effect.mapError(() => credentialStoreFailure(provider, "entry_open")),
    );
    // Each call opens the entry again, as the Promise-based credential store calls it.
    const use = <A>(call: (opened: KeyringEntry) => Effect.Effect<A, KeyringFailure>) =>
      runOAuthNodeEffect(Effect.flatMap(entry, call));
    return {
      getPassword: () => use((opened) => opened.getPassword),
      setPassword: (password) => use((opened) => opened.setPassword(password)),
      deleteCredential: () => use((opened) => opened.deleteCredential),
    };
  };
  return process.platform === "win32" ? createChunkedPasswordEntry(open, account) : open(account);
};

export const createKeychainCredentialStore = (
  open: (provider: OAuthProvider) => PasswordEntry = keychainEntry,
): CredentialStore => ({
  read: (provider) =>
    runNativeEffect(
      Effect.gen(function* () {
        const entry = open(provider);
        const encoded = yield* Effect.tryPromise({
          try: () => entry.getPassword(),
          catch: storeFailure(provider, "read"),
        });
        if (encoded == null) return null;
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
    ),
  write: (provider, credential) =>
    runNativeEffect(
      Effect.gen(function* () {
        const entry = open(provider);
        const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(StoredCredentialSchema))(
          credential,
        );
        yield* Effect.tryPromise({
          try: () => entry.setPassword(encoded),
          catch: storeFailure(provider, "write"),
        });
      }),
    ),
  remove: (provider) =>
    runNativeEffect(
      Effect.gen(function* () {
        const entry = open(provider);
        yield* Effect.tryPromise({
          try: () => entry.deleteCredential(),
          catch: storeFailure(provider, "delete"),
        });
      }),
    ).then(() => undefined),
});

/** A keychain slot was asked for with an id no profile can have. */
export class OAuthProfileIdRejected extends Schema.TaggedError<OAuthProfileIdRejected>()(
  "OAuthProfileIdRejected",
  {},
) {
  override get message() {
    return "invalid_oauth_profile_id";
  }
}

export const createKeychainProfileCredentialStore = (profileId: string): CredentialStore => {
  if (
    !/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|legacy-(?:openai|anthropic))$/.test(
      profileId,
    )
  )
    // Synchronous store factory: callers hold no error channel here.
    throw OAuthProfileIdRejected.make();
  // Preserve the original 'subscription-oauth' entry for rollback until migration is verified.
  return createKeychainCredentialStore((provider) =>
    keychainEntry(provider, `subscription-oauth-${profileId}`),
  );
};

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

export interface LoginAttempt {
  readonly provider: OAuthProvider;
  readonly authorizationUrl: string;
  readonly completed: Promise<OAuthConnectionStatus>;
  cancel(): void;
}

export interface SubscriptionOAuthClientOptions {
  readonly protocol: ProviderProtocol;
  readonly store?: CredentialStore;
  readonly fetch?: typeof fetch;
  /** Injectable one-shot proxy route for tests; production uses Windows user proxy policy. */
  readonly tokenProxyFetch?: (
    url: string,
    body: string,
    contentType: string,
  ) => Promise<TokenProxyResult>;
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

export function createSubscriptionOAuthClient(options: SubscriptionOAuthClientOptions) {
  const protocol = options.protocol;
  const store = options.store ?? createKeychainCredentialStore();
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  // Synchronous client factory: a failed random source throws its PlatformError here.
  const anthropicSessionId = Effect.runSync(oauthProtocolCrypto.randomUUIDv4());
  let loginActive = false;
  const refreshLock = Semaphore.makeUnsafe(1);
  type Refresh = {
    readonly token: object;
    readonly load: Effect.Effect<StoredCredential, Cause.UnknownError | OAuthHarnessError>;
  };
  let refreshing: Refresh | null = null;

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const statusEffect = Effect.fn("OAuth.status")(function* () {
    let credential = yield* nativePromise(() => store.read(protocol.provider));
    if (credential !== null && credential.expiresAt <= now() + 30_000) {
      credential = yield* refreshEffect(credential).pipe(
        Effect.catchIf(
          (failure) => {
            const error = Cause.isUnknownError(failure) ? failure.cause : failure;
            return (
              Schema.is(OAuthHarnessError)(error) &&
              (invalidatesStoredCredential(error) || error.code === "not_connected")
            );
          },
          () => Effect.succeed(null),
        ),
      );
    }
    return {
      provider: protocol.provider,
      connected: credential !== null,
      expiresAt: credential?.expiresAt ?? null,
    };
  });
  function status(): Promise<OAuthConnectionStatus> {
    return runNativeEffect(statusEffect());
  }
  function disconnect(): Promise<OAuthConnectionStatus> {
    return runNativeEffect(
      nativePromise(() => store.remove(protocol.provider)).pipe(Effect.andThen(statusEffect())),
    );
  }

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const startLoginEffect = Effect.fn("OAuth.startLogin")(function* (
    options: {
      readonly timeoutMs?: number;
      readonly signal?: AbortSignal;
    } = {},
  ): Effect.fn.Return<LoginAttempt, OAuthHarnessError> {
    yield* Effect.when(
      Effect.fail(OAuthHarnessError.fromCode("login_in_progress")),
      Effect.succeed(loginActive),
    );
    loginActive = true;
    const pkce = createPkce();
    let verifier: string | null = pkce.verifier;
    const state = protocol.provider === "anthropic" ? pkce.verifier : createOAuthState();
    const timeoutMs = options.timeoutMs ?? 120_000;
    const listenerScope = yield* Scope.make();
    const closeListener = Scope.close(listenerScope, Exit.void);
    const serverServices = yield* Layer.buildWithScope(
      NodeHttpServer.layer(NodeHttpServer.createServer, {
        port: protocol.callbackPort ?? 0,
        host: protocol.callbackRedirectHost,
      }),
      listenerScope,
    ).pipe(
      Effect.onError(() =>
        closeListener.pipe(
          Effect.andThen(
            Effect.sync(() => {
              loginActive = false;
            }),
          ),
        ),
      ),
      Effect.mapError(() => OAuthHarnessError.fromCode("transport_unavailable")),
    );
    const server = yield* Effect.provideContext(HttpServer.HttpServer, serverServices);
    if (!NetAddress.isInetAddress(server.address)) {
      yield* closeListener;
      loginActive = false;
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
    const completed = runNativeEffect(Deferred.await(completion));
    let finished = false;
    let callbackClaimed = false;
    let timer: Fiber.Fiber<void> | undefined;
    const finish = Effect.fn("OAuth.finishLogin")(function* (
      result: Result.Result<OAuthConnectionStatus, OAuthHarnessError>,
      fromTimeout: boolean = false,
    ): Effect.fn.Return<void> {
      if (finished) return;
      finished = true;
      if (!fromTimeout && timer !== undefined) yield* Fiber.interrupt(timer);
      options.signal?.removeEventListener("abort", abort);
      verifier = null;
      loginActive = false;
      yield* closeListener;
      yield* Result.match(result, {
        onSuccess: (status) => Deferred.succeed(completion, status),
        onFailure: (error) => Deferred.fail(completion, error),
      });
    });
    const abort = () => {
      void runNativeEffect(Result.fail(OAuthHarnessError.fromCode("cancelled")).pipe(finish));
    };
    // HttpEffect closes each request Scope only after writing its response. Finish from a
    // detached finalizer Fiber so closing the listener never interrupts its own callback.
    const settleAfterResponse = (result: Result.Result<OAuthConnectionStatus, OAuthHarnessError>) =>
      Effect.sync(() => {
        callbackClaimed = true;
      }).pipe(
        Effect.andThen(
          Effect.addFinalizer(() => Effect.forkDetach(finish(result)).pipe(Effect.asVoid)),
        ),
      );
    const callbackResponse = (text: string, status: number) =>
      HttpServerResponse.text(text, { status, headers: { connection: "close" } });
    const onCallback = Effect.fn("OAuth.loginCallback")(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      // Admission happens before any suspension; replay cannot exchange or settle twice.
      if (callbackClaimed || finished) {
        return callbackResponse("OAuth callback already consumed.", 410);
      }
      const callback = new URL(request.url, redirectUri);
      if (
        request.method !== "GET" ||
        callback.pathname !== protocol.callbackPath ||
        request.headers.host !== redirectAuthority
      ) {
        return callbackResponse("Invalid OAuth callback.", 400);
      }
      const returnedState = callback.searchParams.get("state");
      const code = callback.searchParams.get("code");
      if (returnedState === null || !safeEqual(returnedState, state)) {
        yield* settleAfterResponse(
          Result.fail(OAuthHarnessError.fromCode("callback_state_mismatch")),
        );
        return callbackResponse("OAuth state mismatch.", 400);
      }
      if (code === null || code.length === 0 || verifier === null) {
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
      callbackClaimed = true;
      const codeVerifier = verifier;
      let previous: StoredCredential | null = null;
      let written = false;
      // A login cancelled or timed out meanwhile stops before its next step.
      const unlessFinished = Effect.when(
        Effect.fail(OAuthHarnessError.fromCode("cancelled")),
        Effect.sync(() => finished),
      );
      return yield* Effect.gen(function* () {
        yield* unlessFinished;
        const commonGrant = {
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: protocol.clientId,
          code_verifier: codeVerifier,
        } as const;
        const grant: AuthorizationCodeGrant =
          protocol.provider === "anthropic" ? { ...commonGrant, state } : commonGrant;
        const credential = yield* exchangeEffect(grant);
        yield* unlessFinished;
        previous = yield* nativePromise(() => store.read(protocol.provider));
        yield* unlessFinished;
        written = true;
        yield* nativePromise(() => store.write(protocol.provider, credential));
        yield* unlessFinished;
        const connection = yield* statusEffect();
        yield* unlessFinished;
        yield* settleAfterResponse(Result.succeed(connection));
        return callbackResponse("Connected. You may close this window.", 200);
      }).pipe(
        Effect.catch((failure) =>
          Effect.gen(function* () {
            // Store callbacks reject through Promises; their typed errors arrive wrapped.
            const cause = Cause.isUnknownError(failure) ? failure.cause : failure;
            const error = Schema.is(OAuthHarnessError)(cause)
              ? cause
              : OAuthHarnessError.fromCode("provider_rejected", null, {
                  provider: protocol.provider,
                  operation: "login_callback",
                });
            const credential = previous;
            // Best-effort rollback of a written credential; the login already failed with `error`.
            yield* Effect.when(
              nativePromise(() =>
                credential === null
                  ? store.remove(protocol.provider)
                  : store.write(protocol.provider, credential),
              ).pipe(
                Effect.catchTag("UnknownError", () =>
                  Effect.logWarning("OAuth credential rollback failed", { error: "UnknownError" }),
                ),
              ),
              Effect.succeed(written),
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
    timer = yield* Effect.sleep(timeoutMs).pipe(
      Effect.andThen(() =>
        finish(Result.fail(OAuthHarnessError.fromCode("callback_timeout")), true),
      ),
      Effect.forkDetach,
    );
    options.signal?.addEventListener("abort", abort, { once: true });
    yield* Effect.when(Effect.sync(abort), Effect.succeed(options.signal?.aborted === true));
    return {
      provider: protocol.provider,
      authorizationUrl: authorize.toString(),
      completed,
      cancel: abort,
    };
  });
  function startLogin(
    options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
  ): Promise<LoginAttempt> {
    return runNativeEffect(startLoginEffect(options));
  }

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const exchangeEffect = Effect.fn("OAuth.exchange")(function* (
    values: TokenGrant,
    previous?: StoredCredential,
  ) {
    const context: OAuthHarnessErrorContext = {
      provider: protocol.provider,
      operation: values.grant_type === "refresh_token" ? "token_refresh" : "token_exchange",
    };
    const encoded = tokenBody(protocol, values);
    let proxyRoute: ProxyRoute | null = null;
    const withProxyRoute = (details: OAuthHarnessErrorContext): OAuthHarnessErrorContext =>
      proxyRoute === null ? details : { ...details, proxyRoute };
    const response = yield* nativePromise(() =>
      fetcher(protocol.tokenUrl, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": encoded.contentType },
        body: encoded.body,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      }),
    ).pipe(
      Effect.catch((failure) =>
        Effect.gen(function* () {
          const error = failure.cause;
          const transportCode = error instanceof Error ? safeTransportCode(error) : "other";
          const proxyFetch =
            options.tokenProxyFetch ??
            (options.fetch === undefined ? fetchOpenAiTokenViaSystemProxy : undefined);
          if (
            protocol.provider === "openai" &&
            values.grant_type === "authorization_code" &&
            transportCode === "UND_ERR_CONNECT_TIMEOUT" &&
            proxyFetch !== undefined
          ) {
            const retry = yield* nativePromise(() =>
              proxyFetch(protocol.tokenUrl, encoded.body, encoded.contentType),
            ).pipe(
              Effect.mapError((failure) =>
                OAuthHarnessError.fromCode("transport_unavailable", null, {
                  ...context,
                  transportCode:
                    failure.cause instanceof Error ? safeTransportCode(failure.cause) : "other",
                  proxyRoute: "attempted",
                }),
              ),
            );
            proxyRoute = retry.route;
            if (retry.response !== null) return retry.response;
          }
          return yield* OAuthHarnessError.fromCode(
            "transport_unavailable",
            null,
            withProxyRoute({ ...context, transportCode }),
          );
        }),
      ),
    );
    if (!response.ok) {
      // The body is read only for an allowlisted OAuth code; an unreadable body has none.
      const body = yield* nativePromise(() => response.text()).pipe(
        Effect.catchTag("UnknownError", () => Effect.succeed("")),
      );
      return yield* OAuthHarnessError.fromCode(
        "provider_rejected",
        response.status,
        withProxyRoute({ ...context, ...optionalProperty("providerCode", providerCode(body)) }),
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
  const refreshEffect = Effect.fn("OAuth.refresh")(function* (credential: StoredCredential) {
    const entry = yield* refreshLock.withPermits(1)(
      Effect.gen(function* () {
        if (refreshing !== null) return refreshing;
        // The caller's credential may predate a refresh that finished while it waited. Refresh
        // tokens rotate, so spending the old one would be rejected and sign out the new login.
        const stored = yield* nativePromise(() => store.read(protocol.provider)).pipe(
          Effect.filterOrFail(Predicate.isNotNull, () =>
            OAuthHarnessError.fromCode("not_connected", null, {
              provider: protocol.provider,
              operation: "token_refresh",
            }),
          ),
        );
        if (stored.refreshToken !== credential.refreshToken)
          return { token: {}, load: Effect.succeed(stored) };
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
            const next = yield* exchangeEffect(grant, credential);
            yield* nativePromise(() => store.write(protocol.provider, next));
            return next;
          }).pipe(
            Effect.catch((failure) =>
              Effect.gen(function* () {
                const error = Cause.isUnknownError(failure) ? failure.cause : failure;
                if (Schema.is(OAuthHarnessError)(error) && invalidatesStoredCredential(error))
                  yield* nativePromise(() => store.remove(protocol.provider));
                return yield* failure;
              }),
            ),
            // An OS credential write cannot be cancelled; every waiter shares one owner operation.
            Effect.uninterruptible,
            Effect.ensuring(
              Effect.sync(() => {
                if (refreshing?.token === token) refreshing = null;
              }),
            ),
          ),
          0,
        );
        const next = { token, load };
        refreshing = next;
        return next;
      }),
    );
    return yield* entry.load;
  });
  /** The stored credential, refreshed first when it is about to expire. */
  const freshCredential = (context: OAuthHarnessErrorContext) =>
    nativePromise(() => store.read(protocol.provider)).pipe(
      Effect.filterOrFail(isTruthy, () =>
        OAuthHarnessError.fromCode("not_connected", null, context),
      ),
      Effect.filterOrElse((credential) => credential.expiresAt > now() + 30_000, refreshEffect),
    );
  function refreshForValidation(): Promise<OAuthConnectionStatus> {
    return runNativeEffect(
      nativePromise(() => store.read(protocol.provider)).pipe(
        Effect.filterOrFail(Predicate.isNotNull, () => OAuthHarnessError.fromCode("not_connected")),
        Effect.flatMap(refreshEffect),
        Effect.andThen(statusEffect()),
      ),
    );
  }

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const authorizedCatalogRequest = Effect.fn("OAuth.catalogRequest")(function* (
    url: URL,
    credential: StoredCredential,
    signal: AbortSignal,
  ) {
    const headers = new Headers(protocol.modelHeaders);
    headers.set("Accept", "application/json");
    headers.delete("Content-Type");
    headers.set("Authorization", `Bearer ${credential.accessToken}`);
    if (protocol.provider === "openai" && credential.accountId !== undefined)
      headers.set("chatgpt-account-id", credential.accountId);
    if (protocol.provider === "anthropic") {
      headers.set("x-client-request-id", yield* oauthProtocolCrypto.randomUUIDv4());
      headers.set("X-Claude-Code-Session-Id", anthropicSessionId);
    }
    return yield* Effect.tryPromise({
      try: () =>
        fetcher(url, {
          method: "GET",
          headers,
          redirect: "error",
          signal,
        }),
      catch: () =>
        OAuthHarnessError.fromCode("transport_unavailable", null, {
          provider: protocol.provider,
          operation: "model_catalog",
        }),
    });
  });

  /** Fetches only the provider's fixed model-catalog endpoint and never returns credentials. */
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const modelCatalogEffect = Effect.fn("OAuth.modelCatalog")(function* (ownerSignal?: AbortSignal) {
    const context: OAuthHarnessErrorContext = {
      provider: protocol.provider,
      operation: "model_catalog",
    };
    let credential = yield* freshCredential(context);

    const pages: unknown[] = [];
    // Native HTTP boundary: keep the existing timeout and the Effect owner's
    // interruption signal across every page/retry of this single catalog load.
    const timeout = AbortSignal.timeout(30_000);
    const signal = ownerSignal === undefined ? timeout : AbortSignal.any([ownerSignal, timeout]);
    const seenCursors = MutableHashSet.empty<string>();
    let afterId: string | undefined;
    for (;;) {
      const url = new URL(protocol.catalogUrl);
      if (protocol.provider === "anthropic") {
        url.searchParams.set("limit", "1000");
        if (afterId !== undefined) url.searchParams.set("after_id", afterId);
      }
      let response = yield* authorizedCatalogRequest(url, credential, signal);
      if (protocol.refreshStatuses.includes(response.status)) {
        credential = yield* refreshEffect(credential);
        response = yield* authorizedCatalogRequest(url, credential, signal);
      }
      if (!response.ok)
        return yield* OAuthHarnessError.fromCode("provider_rejected", response.status, context);
      const page = yield* nativePromise(() => response.json()).pipe(
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
    return pages;
  });
  function modelCatalog(ownerSignal?: AbortSignal): Promise<ReadonlyArray<unknown>> {
    return runNativeEffect(modelCatalogEffect(ownerSignal));
  }

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const streamResponse = Effect.fn("OAuth.streamResponse")(function* (
    serializedBody: string,
    signal?: AbortSignal,
  ) {
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
        headers.set("x-client-request-id", yield* oauthProtocolCrypto.randomUUIDv4());
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
        try: (ownerSignal) =>
          fetcher(protocol.modelUrl, {
            method: "POST",
            headers,
            body: providerBody,
            redirect: "error",
            // A supplied signal belongs to the SDK run; preserve its reference contract.
            signal: signal ?? ownerSignal,
          }),
        catch: (error) =>
          modelRequestFailed(
            protocol.provider,
            error instanceof Error ? safeTransportCode(error) : "other",
          ),
      });
    });

    let response = yield* request(credential);
    if (protocol.refreshStatuses.includes(response.status)) {
      credential = yield* refreshEffect(credential);
      response = yield* request(credential);
    }
    if (!response.ok) {
      if (
        protocol.provider === "anthropic" &&
        (response.status === 400 || response.status === 422)
      ) {
        // Read only to recognise a prompt-cache rejection; an unreadable body is not one.
        const responseText = yield* nativePromise(() => response.clone().text()).pipe(
          Effect.catchTag("UnknownError", () => Effect.succeed("")),
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
  function stream(
    serializedBody: string,
    signal?: AbortSignal,
  ): AsyncGenerator<NormalizedStreamEvent> {
    return nativeStream(
      Stream.fromEffect(streamResponse(serializedBody, signal)).pipe(
        Stream.flatMap((response) => sseEvents(protocol.provider, response)),
      ),
    );
  }
  return { status, disconnect, startLogin, refreshForValidation, modelCatalog, stream };
}

export type SubscriptionOAuthClient = ReturnType<typeof createSubscriptionOAuthClient>;

/** @deprecated Use createSubscriptionOAuthClient. Retained for validation scripts and tests. */
export const OAuthValidationHarness = createSubscriptionOAuthClient;
export type OAuthValidationHarness = SubscriptionOAuthClient;
