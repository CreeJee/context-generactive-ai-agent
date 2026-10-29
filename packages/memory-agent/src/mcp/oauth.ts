import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  auth,
  computeScopeUnion,
  createPrivateKeyJwtAuth,
  DpopSession,
  extractWWWAuthenticateParams,
  generateDpopKeyPair,
  InsufficientScopeError,
  OAuthError,
  StreamableHTTPClientTransport,
  withDpopFromProvider,
  type AddClientAuthentication,
  type AuthOptions,
  type AuthProvider,
  type FetchLike,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import {
  Cause,
  Crypto,
  Data,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Predicate,
  Ref,
  Schema,
  Scope,
  Semaphore,
  SynchronizedRef,
} from "effect";
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { NetAddress } from "effect/net";
import { SecretStore, type SecretName, type SecretStoreFailed } from "../config/secrets.ts";
import { JsonValue } from "../json.ts";
import { optionalProperty } from "../optional-property.ts";
import { nativePromise, runNativeEffect } from "../runtime/native-effect.ts";
import type { McpLoginFailureCode, ShownFailure } from "../runtime/shown-failure.ts";
import { sha256 } from "../runtime/synchronous-crypto.ts";
import {
  expandVariablesResult,
  McpClientAuthentication,
  McpOAuthClient,
  McpOAuthConfig,
  type McpScope,
  type MissingVariable,
} from "./config.ts";

/**
 * MCP authorization (spec 2025-06-18 and later) for HTTP servers, on the SDK's `auth()`: discovery
 * of the protected resource and its authorization server, client registration, PKCE, resource
 * indicators, refresh, DPoP and step-up. This module keeps one server's login in the keychain,
 * answers the transport's 401s one refresh at a time, and runs the browser login on a loopback
 * listener.
 */

/** The server answered 401 and no stored login could answer it; settings offer a login. */
export class McpLoginRequired extends Schema.TaggedError<
  McpLoginRequired,
  { readonly brand: unique symbol }
>()("McpLoginRequired", {}) {
  override get message() {
    return "The MCP server needs a login.";
  }
}
const isLoginRequired = Schema.is(McpLoginRequired);

/** Whether the error, or one it wraps, is `McpLoginRequired`, which the SDK passes on as it is. */
export const needsLogin = (cause: unknown): boolean =>
  isLoginRequired(cause) || (Predicate.hasProperty(cause, "cause") && needsLogin(cause.cause));

/** A login could not start. */
export class McpLoginFailed extends Schema.TaggedError<
  McpLoginFailed,
  { readonly brand: unique symbol }
>()("McpLoginFailed", {
  code: Schema.Literals([
    "callback_port_unavailable",
    "login_timed_out",
    "login_denied",
    "login_failed",
  ]),
  detail: Schema.NullOr(Schema.String),
}) {
  override get message() {
    return this.code;
  }
}

/** How a login ended. */
export type McpLoginOutcome = Data.TaggedEnum<{
  succeeded: {};
  cancelled: {};
  failed: { readonly failure: ShownFailure<McpLoginFailureCode> };
}>;
export const McpLoginOutcome = Data.taggedEnum<McpLoginOutcome>();

export interface McpLoginAttempt {
  /** Where the person logs in; the browser comes back to the loopback listener. */
  readonly authorizationUrl: string;
  /** How the login ended; it ends whether or not anything waits for it. */
  readonly outcome: Effect.Effect<McpLoginOutcome>;
  readonly cancel: Effect.Effect<void>;
}

/** What a server asked for in its last `WWW-Authenticate` challenge, for the next login. */
const Challenge = Schema.Struct({
  scope: Schema.optional(Schema.String),
  resourceMetadataUrl: Schema.optional(Schema.String),
});
type Challenge = typeof Challenge.Type;

/** The SDK's client information, as much as token requests read of it. */
const StoredClient = Schema.Struct({
  client_id: Schema.String,
  client_secret: Schema.optional(Schema.String),
  client_id_issued_at: Schema.optional(Schema.Finite),
  client_secret_expires_at: Schema.optional(Schema.Finite),
  token_endpoint_auth_method: Schema.optional(Schema.String),
  redirect_uris: Schema.optional(Schema.Array(Schema.String)),
  issuer: Schema.optional(Schema.String),
});
type StoredClient = typeof StoredClient.Type;

const StoredTokens = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.String,
  id_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Finite),
  scope: Schema.optional(Schema.String),
  refresh_token: Schema.optional(Schema.String),
  issuer: Schema.optional(Schema.String),
});

const PublicJwk = Schema.Struct({
  kty: Schema.Literal("EC"),
  crv: Schema.Literal("P-256"),
  x: Schema.String,
  y: Schema.String,
});

/** The ES256 key DPoP-bound tokens are bound to (RFC 9449), so they outlive a restart. */
const StoredDpopKey = Schema.Struct({
  privateJwk: Schema.Struct({ ...PublicJwk.fields, d: Schema.String }),
  publicJwk: PublicJwk,
  thumbprint: Schema.String,
});
type StoredDpopKey = typeof StoredDpopKey.Type;

/** One server's login in the keychain. `binding` names the configuration it was made for. */
const StoredLogin = Schema.Struct({
  binding: Schema.String,
  client: Schema.optional(StoredClient),
  tokens: Schema.optional(StoredTokens),
  dpopKey: Schema.optional(StoredDpopKey),
  challenge: Schema.optional(Challenge),
});
type StoredLogin = typeof StoredLogin.Type;

const decodeStoredLogin = Schema.decodeUnknownOption(Schema.fromJsonString(StoredLogin));
const encodeStoredLogin = Schema.encodeEffect(Schema.fromJsonString(StoredLogin));
const decodeClient = Schema.decodeUnknownEffect(StoredClient);
const decodeTokens = Schema.decodeUnknownEffect(StoredTokens);
const decodeDpopKey = Schema.decodeUnknownEffect(StoredDpopKey);
/** RFC 9449 §5.1: the proof algorithms an authorization server that offers DPoP accepts. */
const isDpopMetadata = Schema.is(
  Schema.Struct({ dpop_signing_alg_values_supported: Schema.Array(Schema.String) }),
);
const decodeJwk = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, JsonValue)),
);

/** The keychain entry of a server's login; a global server's login serves every project. */
export const loginSlot = (server: {
  readonly scope: McpScope;
  readonly projectId: string;
  readonly name: string;
}): SecretName =>
  `mcp-oauth:${server.scope}:${server.scope === "global" ? "" : server.projectId}:${server.name}`;

/** What a login is made for: a stored login for another URL or OAuth setting is not used. */
export const loginBinding = (server: { readonly url: string; readonly oauth: McpOAuthConfig }) =>
  sha256(JSON.stringify([server.url, server.oauth]));

/** Without `oauth`, a server that asks for authorization gets a login by a self-registering client. */
export const defaultOAuth = McpOAuthConfig.cases.authorizationCode.make({
  client: McpOAuthClient.cases.automatic.make({}),
});

const clientName = "context-generactive-agent";
const loopbackHost = "127.0.0.1";
const callbackPath = "/callback";
const dpopAlgorithm = "ES256";
/** How long discovery and registration may take before a login gives up on starting. */
const startTimeoutMs = 30_000;

/** What the configuration says about the client, with its `${NAME}` secrets read. */
interface ClientSetup {
  /** A person logs in (authorization code), rather than the app as itself (client credentials). */
  readonly interactive: boolean;
  /** Client information known before any login; none when the client registers itself. */
  readonly registered: Option.Option<StoredClient>;
  readonly metadataUrl: string | undefined;
  readonly addClientAuthentication: AddClientAuthentication | undefined;
  readonly scope: string | undefined;
  readonly callbackPort: number | undefined;
}

const expand = (value: string) => Effect.fromResult(expandVariablesResult(value, process.env));

/** A PEM is passed as text; a JWK as its object. */
const keyMaterial = (key: string) => Option.getOrElse(decodeJwk(key), () => key);

type Registration = Effect.Effect<
  Pick<ClientSetup, "registered" | "addClientAuthentication">,
  MissingVariable
>;

/** The client registered beforehand, with how it proves itself at the token endpoint. */
const registeredClient = (
  clientId: string,
  issuer: string | undefined,
  authentication: McpClientAuthentication | undefined,
): Registration => {
  const client = (secret: string | undefined) =>
    Option.some({
      client_id: clientId,
      ...optionalProperty("client_secret", secret),
      ...optionalProperty("issuer", issuer),
    });
  return authentication === undefined
    ? Effect.succeed({ registered: client(undefined), addClientAuthentication: undefined })
    : McpClientAuthentication.match<Registration>(authentication, {
        secret: ({ secret }) =>
          Effect.map(expand(secret), (value) => ({
            registered: client(value),
            addClientAuthentication: undefined,
          })),
        privateKeyJwt: ({ privateKey, algorithm }) =>
          Effect.map(expand(privateKey), (key) => ({
            registered: client(undefined),
            addClientAuthentication: createPrivateKeyJwtAuth({
              issuer: clientId,
              subject: clientId,
              privateKey: keyMaterial(key),
              alg: algorithm,
            }),
          })),
      });
};

type Setup = Effect.Effect<ClientSetup, MissingVariable>;

const setupOf = McpOAuthConfig.match<Setup>({
  authorizationCode: (login) =>
    McpOAuthClient.match<Setup>(login.client, {
      automatic: (client) =>
        Effect.succeed({
          interactive: true,
          registered: Option.none(),
          metadataUrl: client.metadataUrl,
          addClientAuthentication: undefined,
          scope: login.scope,
          callbackPort: login.callbackPort,
        }),
      registered: (client) =>
        Effect.map(
          registeredClient(client.clientId, client.issuer, client.authentication),
          (registered) => ({
            ...registered,
            interactive: true,
            metadataUrl: undefined,
            scope: login.scope,
            callbackPort: login.callbackPort,
          }),
        ),
    }),
  clientCredentials: (machine) =>
    Effect.map(
      registeredClient(machine.clientId, machine.issuer, machine.authentication),
      (registered) => ({
        ...registered,
        interactive: false,
        metadataUrl: undefined,
        scope: machine.scope,
        callbackPort: undefined,
      }),
    ),
});

/** Who drives the SDK's `auth()`: a connection's requests, or a login waiting for the browser. */
type Flow = Data.TaggedEnum<{
  /** Nothing here opens a browser or registers a client; a login is required instead. */
  connection: {};
  login: {
    readonly redirectUrl: string;
    readonly state: string;
    readonly authorizationUrl: Deferred.Deferred<URL>;
  };
}>;
const Flow = Data.taggedEnum<Flow>();

const challengeOf = (response: Response): Challenge => {
  const { scope, resourceMetadataUrl } = extractWWWAuthenticateParams(response);
  return {
    ...optionalProperty("scope", scope),
    ...optionalProperty("resourceMetadataUrl", resourceMetadataUrl?.href),
  };
};

/** The SDK's error for a failed login, as settings word it; the detail is hidden by the owner. */
const loginFailureOf = (cause: unknown): ShownFailure<McpLoginFailureCode> => {
  const error = cause instanceof Cause.UnknownError ? cause.cause : cause;
  return error instanceof OAuthError
    ? {
        code: error.code === "access_denied" ? "login_denied" : "login_failed",
        detail: `${error.code}: ${error.message}`,
      }
    : { code: "login_failed", detail: error instanceof Error ? error.message : String(error) };
};

/** The app as itself asks for a token by client credentials, for the scope `auth()` passes. */
const clientCredentialsRequest = (scope?: string) =>
  new URLSearchParams({ grant_type: "client_credentials", ...optionalProperty("scope", scope) });

const failedLogin = (failure: ShownFailure<McpLoginFailureCode>) =>
  McpLoginOutcome.failed({ failure });

type UnauthorizedContext = Parameters<NonNullable<AuthProvider["onUnauthorized"]>>[0];

/** One server's login, shared by every connection that uses it. */
export interface McpCredentials {
  readonly binding: string;
  /**
   * What the transport authenticates with. Not the SDK's own OAuth handling, so that concurrent
   * 401s refresh once (a rotated refresh token works only once) and a connection never starts a
   * browser login or registers a client.
   */
  readonly transport: { readonly authProvider: AuthProvider; readonly fetch: FetchLike };
  /** Whether a person's login is stored; only known once a connection or login read it. */
  readonly signedIn: Effect.Effect<boolean>;
  /**
   * A call was refused for scope (403 `insufficient_scope`). A client that is the app itself gets a
   * token with the wider scope; a person logs in again, and the next login asks for it.
   */
  readonly stepUp: (
    refused: InsufficientScopeError,
  ) => Effect.Effect<
    void,
    McpLoginRequired | Cause.UnknownError | Schema.SchemaError | SecretStoreFailed
  >;
  readonly login: (options: {
    readonly timeoutMs: number;
  }) => Effect.Effect<McpLoginAttempt, McpLoginFailed>;
}

export const openMcpCredentials = Effect.fnUntraced(function* (options: {
  readonly slot: SecretName;
  readonly url: URL;
  readonly config: McpOAuthConfig;
  readonly binding: string;
}): Effect.fn.Return<McpCredentials, MissingVariable, SecretStore | Crypto.Crypto> {
  const secrets = yield* SecretStore;
  const crypto = yield* Crypto.Crypto;
  const setup = yield* setupOf(options.config);
  const empty: StoredLogin = { binding: options.binding };
  /** The stored login, read from the keychain on first use; `None` until then. */
  const stored = yield* SynchronizedRef.make(Option.none<StoredLogin>());
  const discovery = yield* Ref.make(Option.none<OAuthDiscoveryState>());
  const verifier = yield* Ref.make(Option.none<string>());
  const dpop = yield* SynchronizedRef.make(Option.none<DpopSession>());
  /** Counts saved tokens, so a refresh that waited sees that another one already ran. */
  const saved = yield* Ref.make(0);
  const refreshes = yield* Semaphore.make(1);

  const read = Effect.map(secrets.get(options.slot), (text) =>
    Option.fromNullOr(text).pipe(
      Option.flatMap(decodeStoredLogin),
      Option.filter((login) => login.binding === options.binding),
      Option.getOrElse(() => empty),
    ),
  );
  const current = SynchronizedRef.modifyEffect(stored, (loaded) =>
    Option.match(loaded, {
      onSome: (login) => Effect.succeed([login, loaded] as const),
      onNone: () => Effect.map(read, (login) => [login, Option.some(login)] as const),
    }),
  );
  const update = (change: (login: StoredLogin) => StoredLogin) =>
    SynchronizedRef.updateEffect(stored, (loaded) =>
      Effect.gen(function* () {
        const next = change(
          yield* Option.match(loaded, { onSome: Effect.succeed, onNone: () => read }),
        );
        yield* secrets.set(options.slot, yield* encodeStoredLogin(next));
        return Option.some(next);
      }),
    );

  /** Keeps what the server asked for, for the next login, and fails with `McpLoginRequired`. */
  const requireLogin = (challenge: Challenge) =>
    update((login) => ({
      ...login,
      challenge: {
        ...optionalProperty("scope", computeScopeUnion(login.challenge?.scope, challenge.scope)),
        ...optionalProperty(
          "resourceMetadataUrl",
          challenge.resourceMetadataUrl ?? login.challenge?.resourceMetadataUrl,
        ),
      },
    })).pipe(Effect.andThen(Effect.fail(McpLoginRequired.make())));

  const saveTokens = (tokens: StoredOAuthTokens) =>
    Effect.flatMap(decodeTokens(tokens), (decoded) =>
      update((login) => ({ ...login, tokens: decoded, challenge: undefined })),
    ).pipe(Effect.andThen(Ref.update(saved, (count) => count + 1)));

  const importDpopKey = (key: StoredDpopKey) =>
    nativePromise(() =>
      Promise.all([
        globalThis.crypto.subtle.importKey(
          "jwk",
          key.privateJwk,
          { name: "ECDSA", namedCurve: "P-256" },
          false,
          ["sign"],
        ),
        globalThis.crypto.subtle.importKey(
          "jwk",
          key.publicJwk,
          { name: "ECDSA", namedCurve: "P-256" },
          true,
          ["verify"],
        ),
      ]),
    ).pipe(
      Effect.flatMap(([privateKey, publicKey]) =>
        nativePromise(() =>
          DpopSession.create({
            keyPair: {
              privateKey,
              publicKey,
              publicJwk: key.publicJwk,
              thumbprint: key.thumbprint,
              alg: dpopAlgorithm,
            },
          }),
        ),
      ),
    );

  /** A new key, kept before its first proof so tokens bound to it stay usable. */
  const newDpopSession = Effect.gen(function* () {
    const pair = yield* nativePromise(() =>
      generateDpopKeyPair({ alg: dpopAlgorithm, extractable: true }),
    );
    const privateJwk = yield* nativePromise(() =>
      globalThis.crypto.subtle.exportKey("jwk", pair.privateKey),
    );
    const dpopKey = yield* decodeDpopKey({
      privateJwk,
      publicJwk: pair.publicJwk,
      thumbprint: pair.thumbprint,
    });
    yield* update((login) => ({ ...login, dpopKey }));
    return yield* nativePromise(() => DpopSession.create({ keyPair: pair }));
  });

  /** DPoP only where the authorization server offers it, or a stored key binds the tokens. */
  const offersDpop = Effect.map(Ref.get(discovery), (state) =>
    Option.exists(
      state,
      ({ authorizationServerMetadata }) =>
        isDpopMetadata(authorizationServerMetadata) &&
        authorizationServerMetadata.dpop_signing_alg_values_supported.includes(dpopAlgorithm),
    ),
  );
  const dpopSession = SynchronizedRef.modifyEffect(dpop, (cached) =>
    Option.match(cached, {
      onSome: () => Effect.succeed([cached, cached] as const),
      onNone: () =>
        Effect.gen(function* () {
          const { dpopKey } = yield* current;
          const session =
            dpopKey !== undefined
              ? Option.some(yield* importDpopKey(dpopKey))
              : (yield* offersDpop)
                ? Option.some(yield* newDpopSession)
                : Option.none();
          return [session, session] as const;
        }),
    }),
  );

  const invalidate = {
    all: Effect.all(
      [
        update(() => empty),
        Ref.set(discovery, Option.none()),
        Ref.set(verifier, Option.none()),
        SynchronizedRef.set(dpop, Option.none()),
      ],
      { discard: true },
    ),
    client: update((login) => ({ ...login, client: undefined })),
    tokens: update((login) => ({ ...login, tokens: undefined })),
    verifier: Ref.set(verifier, Option.none()),
    discovery: Ref.set(discovery, Option.none()),
  };

  /** A client that registered itself, if it did so for this login's redirect. */
  const registeredFor = (flow: Flow) => (client: StoredClient) =>
    Flow.$match(flow, {
      connection: () => true,
      login: ({ redirectUrl }) =>
        client.client_id === setup.metadataUrl ||
        (client.redirect_uris ?? []).includes(redirectUrl),
    });

  const clientInformation = (flow: Flow) =>
    Option.match(setup.registered, {
      onSome: Effect.succeed,
      onNone: () =>
        Effect.flatMap(current, (login) => {
          const client = Option.filter(Option.fromUndefinedOr(login.client), registeredFor(flow));
          // A connection never registers a client: that happens at a login.
          return Flow.$is("login")(flow)
            ? Effect.succeed(Option.getOrUndefined(client))
            : Effect.fromOption(client, () => McpLoginRequired.make());
        }),
    });

  /** Only a client that registers itself saves what registration gave it. */
  const saveClient = (information: StoredOAuthClientInformation) =>
    runNativeEffect(
      Effect.flatMap(decodeClient(information), (client) =>
        update((login) => ({ ...login, client })),
      ),
    );

  const providerFor = (flow: Flow): OAuthClientProvider => {
    // A connection never redirects, but `auth()` takes the flow as interactive only with a URL.
    const redirectUrl = setup.interactive
      ? Flow.$match(flow, {
          connection: () => `http://${loopbackHost}${callbackPath}`,
          login: (login) => login.redirectUrl,
        })
      : undefined;
    const clientMetadata: OAuthClientMetadata = {
      client_name: clientName,
      redirect_uris: redirectUrl === undefined ? [] : [redirectUrl],
      grant_types: setup.interactive
        ? ["authorization_code", "refresh_token"]
        : ["client_credentials"],
      ...optionalProperty("response_types", setup.interactive ? ["code"] : undefined),
      // A client that registers itself is public: PKCE, and no secret.
      ...optionalProperty(
        "token_endpoint_auth_method",
        Option.isNone(setup.registered) ? "none" : undefined,
      ),
      ...optionalProperty("scope", setup.scope),
    };
    return {
      redirectUrl,
      clientMetadata,
      ...optionalProperty("clientMetadataUrl", setup.metadataUrl),
      ...optionalProperty("state", Flow.$is("login")(flow) ? () => flow.state : undefined),
      clientInformation: () => runNativeEffect(clientInformation(flow)),
      ...optionalProperty(
        "saveClientInformation",
        Option.isNone(setup.registered) ? saveClient : undefined,
      ),
      tokens: () => runNativeEffect(Effect.map(current, (login) => login.tokens)),
      saveTokens: (tokens) => runNativeEffect(saveTokens(tokens)),
      redirectToAuthorization: (url) =>
        runNativeEffect(
          Flow.$match(flow, {
            connection: () => Effect.fail(McpLoginRequired.make()),
            login: ({ authorizationUrl }) => Effect.asVoid(Deferred.succeed(authorizationUrl, url)),
          }),
        ),
      saveCodeVerifier: (value) => runNativeEffect(Ref.set(verifier, Option.some(value))),
      codeVerifier: () => runNativeEffect(Effect.flatMap(Ref.get(verifier), Effect.fromOption)),
      ...optionalProperty("addClientAuthentication", setup.addClientAuthentication),
      ...optionalProperty(
        "prepareTokenRequest",
        setup.interactive ? undefined : clientCredentialsRequest,
      ),
      dpop: () => runNativeEffect(Effect.map(dpopSession, Option.getOrUndefined)),
      invalidateCredentials: (scope) => runNativeEffect(invalidate[scope]),
      saveDiscoveryState: (state) => runNativeEffect(Ref.set(discovery, Option.some(state))),
      discoveryState: () => runNativeEffect(Effect.map(Ref.get(discovery), Option.getOrUndefined)),
    };
  };

  /** The SDK's `auth()`, failing with `McpLoginRequired` when that is why it stopped. */
  const authorize = (provider: OAuthClientProvider, authOptions: AuthOptions) =>
    nativePromise(() => auth(provider, authOptions)).pipe(
      Effect.catchTag("UnknownError", (error) =>
        Effect.fail(isLoginRequired(error.cause) ? error.cause : error),
      ),
    );

  const connectionProvider = providerFor(Flow.connection());

  /**
   * One refresh at a time. Discovery and token requests go out without the server's configured
   * headers, which are for the MCP server only.
   */
  const refreshAfter = (context: UnauthorizedContext) => {
    const challenge = challengeOf(context.response);
    return Effect.gen(function* () {
      const seen = yield* Ref.get(saved);
      yield* refreshes.withPermits(1)(
        Effect.gen(function* () {
          // Another refresh saved a token while this one waited: the retry uses it.
          if ((yield* Ref.get(saved)) !== seen) return;
          const { tokens } = yield* current;
          // A person's login without a refresh token is renewed only by logging in again.
          const result =
            setup.interactive && tokens?.refresh_token === undefined
              ? "REDIRECT"
              : yield* authorize(connectionProvider, {
                  serverUrl: context.serverUrl,
                  ...optionalProperty("scope", computeScopeUnion(setup.scope, challenge.scope)),
                  ...optionalProperty(
                    "resourceMetadataUrl",
                    Option.getOrUndefined(urlOf(challenge.resourceMetadataUrl)),
                  ),
                });
          yield* Effect.when(
            Effect.fail(McpLoginRequired.make()),
            Effect.succeed(result !== "AUTHORIZED"),
          );
        }),
      );
    }).pipe(Effect.catchTag("McpLoginRequired", () => requireLogin(challenge)));
  };

  const stepUp = (refused: InsufficientScopeError) =>
    refreshes.withPermits(1)(
      Effect.gen(function* () {
        const { tokens } = yield* current;
        const wider: Challenge = {
          ...optionalProperty(
            "scope",
            computeScopeUnion(setup.scope, tokens?.scope, refused.requiredScope),
          ),
          ...optionalProperty("resourceMetadataUrl", refused.resourceMetadataUrl?.href),
        };
        // Wider scope for a person needs their consent again.
        if (setup.interactive) return yield* requireLogin(wider);
        yield* authorize(connectionProvider, {
          serverUrl: options.url,
          ...optionalProperty("scope", wider.scope),
          ...optionalProperty("resourceMetadataUrl", refused.resourceMetadataUrl),
          forceReauthorization: true,
        });
      }),
    );

  const login = Effect.fn("McpOAuth.login")(function* (loginOptions: {
    readonly timeoutMs: number;
  }): Effect.fn.Return<McpLoginAttempt, McpLoginFailed> {
    const listenerScope = yield* Scope.make();
    const closeListener = Scope.close(listenerScope, Exit.void);
    const failWith = (failure: ShownFailure<McpLoginFailureCode>) =>
      Effect.fail(McpLoginFailed.make(failure));
    return yield* Effect.gen(function* () {
      const serverServices = yield* Layer.buildWithScope(
        NodeHttpServer.layer(NodeHttpServer.createServer, {
          port: setup.callbackPort ?? 0,
          host: loopbackHost,
        }),
        listenerScope,
      ).pipe(
        Effect.catch(() =>
          failWith({
            code: "callback_port_unavailable",
            detail: setup.callbackPort === undefined ? null : String(setup.callbackPort),
          }),
        ),
      );
      const server = yield* Effect.provideContext(HttpServer.HttpServer, serverServices);
      const port = yield* NetAddress.isInetAddress(server.address)
        ? Effect.succeed(server.address.port)
        : failWith({ code: "callback_port_unavailable", detail: null });
      const authority = `${loopbackHost}:${port}`;
      const redirectUrl = `http://${authority}${callbackPath}`;
      const state = yield* crypto
        .randomUUIDv4()
        .pipe(Effect.mapError(loginFailureOf), Effect.catch(failWith));
      const authorizationUrl = yield* Deferred.make<URL>();
      const provider = providerFor(Flow.login({ redirectUrl, state, authorizationUrl }));
      const { challenge } = yield* current.pipe(
        Effect.mapError(loginFailureOf),
        Effect.catch(failWith),
      );
      const started = yield* authorize(provider, {
        serverUrl: options.url,
        ...optionalProperty("scope", computeScopeUnion(setup.scope, challenge?.scope)),
        ...optionalProperty(
          "resourceMetadataUrl",
          Option.getOrUndefined(urlOf(challenge?.resourceMetadataUrl)),
        ),
        forceReauthorization: true,
      }).pipe(
        Effect.mapError(loginFailureOf),
        // Discovery or registration that never answers leaves nothing for the person to do.
        Effect.timeoutOrElse({
          duration: startTimeoutMs,
          orElse: () =>
            Effect.fail<ShownFailure<McpLoginFailureCode>>({
              code: "login_failed",
              detail: "the authorization server did not answer in time",
            }),
        }),
        Effect.catch(failWith),
      );
      // A person's login always goes through the browser.
      yield* Effect.when(
        failWith({ code: "login_failed", detail: "authorization did not redirect" }),
        Effect.succeed(started !== "REDIRECT"),
      );
      const authorizeAt = yield* Deferred.await(authorizationUrl);

      const outcome = yield* Deferred.make<McpLoginOutcome>();
      const finished = yield* Ref.make(false);
      const claimed = yield* Ref.make(false);
      /** Settles once: the listener closes, then the outcome is reported. */
      const finish = (result: McpLoginOutcome): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (yield* Ref.getAndSet(finished, true)) return;
          yield* Ref.set(verifier, Option.none());
          yield* Effect.forkDetach(
            Effect.gen(function* () {
              yield* Fiber.interrupt(timer);
              yield* closeListener;
              yield* Deferred.succeed(outcome, result);
            }),
          );
        });
      const timer = yield* Effect.sleep(loginOptions.timeoutMs).pipe(
        Effect.andThen(finish(failedLogin({ code: "login_timed_out", detail: null }))),
        Effect.forkDetach,
      );
      // The request Scope closes after its response is written, so finishing from its finalizer
      // never interrupts the callback that is answering.
      const settleAfterResponse = (result: McpLoginOutcome) =>
        Effect.addFinalizer(() => Effect.asVoid(Effect.forkDetach(finish(result))));
      const respond = (text: string, status: number) =>
        HttpServerResponse.text(text, {
          status,
          contentType: "text/plain; charset=utf-8",
          headers: { connection: "close" },
        });
      const completed = (params: URLSearchParams) =>
        nativePromise(() =>
          // The SDK checks `iss` and reads an error callback; the transport is not started.
          new StreamableHTTPClientTransport(options.url, { authProvider: provider }).finishAuth(
            params,
          ),
        ).pipe(
          Effect.mapError(loginFailureOf),
          Effect.match({ onSuccess: () => McpLoginOutcome.succeeded(), onFailure: failedLogin }),
        );
      const onCallback = Effect.fn("McpOAuth.loginCallback")(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const callback = new URL(request.url, redirectUrl);
        // Other paths, such as the browser's favicon request, and other hosts leave the login waiting.
        if (
          request.method !== "GET" ||
          callback.pathname !== callbackPath ||
          request.headers.host !== authority
        )
          return respond("Not found.", 404);
        if (yield* Ref.getAndSet(claimed, true)) return respond("이 로그인은 이미 끝났어요.", 410);
        const result =
          callback.searchParams.get("state") === state
            ? yield* completed(callback.searchParams)
            : failedLogin({ code: "login_failed", detail: "state mismatch" });
        yield* settleAfterResponse(result);
        return McpLoginOutcome.$match(result, {
          succeeded: () => respond("로그인했어요. 이 창을 닫고 앱으로 돌아가세요.", 200),
          cancelled: () => respond("로그인을 취소했어요.", 410),
          failed: () => respond("로그인하지 못했어요. 앱에서 이유를 확인하세요.", 400),
        });
      });
      yield* Effect.provideContext(
        Scope.provide(HttpServer.serveEffect(onCallback()), listenerScope),
        serverServices,
      );
      return {
        authorizationUrl: authorizeAt.href,
        outcome: Deferred.await(outcome),
        cancel: finish(McpLoginOutcome.cancelled()),
      };
    }).pipe(
      // A login that does not start leaves no listener behind, also when it is interrupted.
      Effect.onError(() => closeListener),
    );
  });

  return {
    binding: options.binding,
    transport: {
      authProvider: {
        token: () => runNativeEffect(Effect.map(current, (stored) => stored.tokens?.access_token)),
        onUnauthorized: (context) => runNativeEffect(refreshAfter(context)),
      },
      // Bearer tokens pass through; DPoP-bound ones go out with a proof per request.
      fetch: withDpopFromProvider(connectionProvider)(fetch),
    },
    signedIn: Effect.map(SynchronizedRef.get(stored), (loaded) =>
      Option.exists(loaded, (stored) => setup.interactive && stored.tokens !== undefined),
    ),
    stepUp,
    login,
  } satisfies McpCredentials;
});

const urlOf = (text: string | undefined) =>
  Option.liftThrowable((value: string) => new URL(value))(text ?? "");
