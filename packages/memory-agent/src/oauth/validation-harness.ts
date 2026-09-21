import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { Option, Schema } from "effect";
import { requireRuntime } from "../runtime/resources.ts";
import { prepareAnthropicValidationBody } from "./anthropic-validation-adapter.ts";
import {
  createOAuthState,
  createPkce,
  decodeProviderEvent,
  ProviderFeatureRejectedError,
  type NormalizedStreamEvent,
  type OAuthProvider,
  type ProviderProtocol,
} from "./protocol.ts";

const StoredCredentialSchema = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.String,
  idToken: Schema.optional(Schema.String),
  accountId: Schema.optional(Schema.String),
  expiresAt: Schema.Number,
});

export interface StoredCredential {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly idToken?: string;
  readonly accountId?: string;
  readonly expiresAt: number;
}

const decodeStoredCredential = Schema.decodeUnknownOption(Schema.parseJson(StoredCredentialSchema));

export interface CredentialStore {
  read(provider: OAuthProvider): Promise<StoredCredential | null>;
  write(provider: OAuthProvider, credential: StoredCredential): Promise<void>;
  remove(provider: OAuthProvider): Promise<void>;
}

export const providerKeychainService = (provider: OAuthProvider) =>
  `com.context-agent.oauth.${provider}`;

export class KeychainCredentialStore implements CredentialStore {
  async read(provider: OAuthProvider): Promise<StoredCredential | null> {
    try {
      const { AsyncEntry } = requireRuntime("@napi-rs/keyring");
      const encoded: unknown = await new AsyncEntry(
        providerKeychainService(provider),
        "subscription-oauth",
      ).getPassword();
      if (encoded === undefined || encoded === null) return null;
      return Option.getOrThrowWith(
        decodeStoredCredential(encoded),
        () => new OAuthHarnessError("credential_store_unavailable"),
      );
    } catch (error) {
      if (error instanceof OAuthHarnessError) throw error;
      throw new OAuthHarnessError("credential_store_unavailable");
    }
  }

  async write(provider: OAuthProvider, credential: StoredCredential): Promise<void> {
    try {
      const { AsyncEntry } = requireRuntime("@napi-rs/keyring");
      await new AsyncEntry(providerKeychainService(provider), "subscription-oauth").setPassword(
        JSON.stringify(credential),
      );
    } catch {
      throw new OAuthHarnessError("credential_store_unavailable");
    }
  }

  async remove(provider: OAuthProvider): Promise<void> {
    try {
      const { AsyncEntry } = requireRuntime("@napi-rs/keyring");
      const entry = new AsyncEntry(providerKeychainService(provider), "subscription-oauth");
      // Native backends make deletion idempotent: false means the credential is already absent.
      await entry.deleteCredential();
    } catch {
      throw new OAuthHarnessError("credential_store_unavailable");
    }
  }
}

export type OAuthHarnessFailure =
  | "cancelled"
  | "callback_invalid"
  | "callback_state_mismatch"
  | "callback_timeout"
  | "credential_store_unavailable"
  | "invalid_token_response"
  | "login_in_progress"
  | "not_connected"
  | "provider_rejected"
  | "transport_unavailable";

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

export type OAuthHarnessOperation =
  | "credential_store"
  | "login_callback"
  | "model_catalog"
  | "model_stream"
  | "token_exchange"
  | "token_refresh";

export interface OAuthHarnessErrorContext {
  readonly provider?: OAuthProvider;
  readonly operation?: OAuthHarnessOperation;
}

const providerName = (provider: OAuthProvider) => (provider === "openai" ? "OpenAI" : "Anthropic");

export class OAuthHarnessError extends Error {
  readonly code: OAuthHarnessFailure;
  readonly status: number | null;
  readonly provider: OAuthProvider | null;
  readonly operation: OAuthHarnessOperation | null;

  constructor(
    code: OAuthHarnessFailure,
    status: number | null = null,
    context: OAuthHarnessErrorContext = {},
  ) {
    const details = [
      context.provider === undefined ? null : `provider=${providerName(context.provider)}`,
      context.operation === undefined ? null : `operation=${context.operation}`,
      status === null ? null : `status=${status}`,
    ].filter((detail) => detail !== null);
    super(
      `oauth_${code}${details.length === 0 ? "" : ` [${details.join(", ")}]`}: ${failureMessages[code]}`,
    );
    this.name = "OAuthHarnessError";
    this.code = code;
    this.status = status;
    this.provider = context.provider ?? null;
    this.operation = context.operation ?? null;
  }
}

const invalidatesStoredCredential = (error: OAuthHarnessError) =>
  error.operation === "token_refresh" &&
  (error.code === "invalid_token_response" ||
    (error.code === "provider_rejected" &&
      error.status !== null &&
      [400, 401, 403].includes(error.status)));

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
  readonly now?: () => number;
}

const safeEqual = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

const close = (server: Server) =>
  new Promise<void>((resolve) => {
    server.close(() => resolve());
  });

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.Number,
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
const decodeOpenAiIdClaims = Schema.decodeUnknownOption(Schema.parseJson(OpenAiIdClaims));

const openAiAccountId = (idToken: string) => {
  const payload = idToken.split(".")[1];
  if (payload === undefined) return undefined;
  try {
    return Option.getOrUndefined(
      decodeOpenAiIdClaims(Buffer.from(payload, "base64url").toString()),
    )?.["https://api.openai.com/auth"].chatgpt_account_id;
  } catch {
    return undefined;
  }
};

const parseTokens = (
  token: typeof TokenResponse.Type,
  previous?: StoredCredential,
): StoredCredential => {
  const refreshToken = token.refresh_token ?? previous?.refreshToken;
  if (refreshToken === undefined) throw new OAuthHarnessError("invalid_token_response");
  const idToken = token.id_token ?? previous?.idToken;
  const accountId = (idToken && openAiAccountId(idToken)) ?? previous?.accountId;
  const credential: StoredCredential = {
    accessToken: token.access_token,
    refreshToken,
    expiresAt: Date.now() + token.expires_in * 1_000,
  };
  const withIdentity = idToken === undefined ? credential : { ...credential, idToken };
  return accountId === undefined ? withIdentity : { ...withIdentity, accountId };
};

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

const tokenBody = (protocol: ProviderProtocol, values: TokenGrant): EncodedTokenBody => {
  if (protocol.tokenEncoding === "form")
    return {
      body: new URLSearchParams(Object.entries(values)).toString(),
      contentType: "application/x-www-form-urlencoded",
    };
  return { body: JSON.stringify(values), contentType: "application/json" };
};

async function* sseEvents(
  provider: OAuthProvider,
  response: Response,
): AsyncGenerator<NormalizedStreamEvent> {
  if (!response.body) throw new OAuthHarnessError("transport_unavailable");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      buffer += part.value.replaceAll("\r\n", "\n");
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary < 0) break;
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") return;
          const event = decodeProviderEvent(provider, data);
          if (event) yield event;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export class SubscriptionOAuthClient {
  readonly #protocol: ProviderProtocol;
  readonly #store: CredentialStore;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #anthropicSessionId = randomUUID();
  #loginActive = false;
  #refreshing: Promise<StoredCredential> | null = null;

  constructor(options: SubscriptionOAuthClientOptions) {
    this.#protocol = options.protocol;
    this.#store = options.store ?? new KeychainCredentialStore();
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  async status(): Promise<OAuthConnectionStatus> {
    let credential = await this.#store.read(this.#protocol.provider);
    if (credential !== null && credential.expiresAt <= this.#now() + 30_000) {
      try {
        credential = await this.#refresh(credential);
      } catch (error) {
        if (error instanceof OAuthHarnessError && invalidatesStoredCredential(error))
          credential = null;
        else throw error;
      }
    }
    return {
      provider: this.#protocol.provider,
      connected: credential !== null,
      expiresAt: credential?.expiresAt ?? null,
    };
  }

  async disconnect(): Promise<OAuthConnectionStatus> {
    await this.#store.remove(this.#protocol.provider);
    return this.status();
  }

  async startLogin(
    options: {
      readonly timeoutMs?: number;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<LoginAttempt> {
    if (this.#loginActive) throw new OAuthHarnessError("login_in_progress");
    this.#loginActive = true;
    const protocol = this.#protocol;
    const pkce = createPkce();
    let verifier: string | null = pkce.verifier;
    // Claude's CLI OAuth contract uses the PKCE verifier as state and returns it on callback.
    const state = protocol.provider === "anthropic" ? pkce.verifier : createOAuthState();
    const timeoutMs = options.timeoutMs ?? 120_000;
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        // Bind the same loopback hostname used in the registered redirect URI. On Windows,
        // `localhost` can prefer ::1, which cannot reach a server bound only to 127.0.0.1.
        server.listen(protocol.callbackPort ?? 0, protocol.callbackRedirectHost, () => resolve());
      });
    } catch {
      this.#loginActive = false;
      throw new OAuthHarnessError("transport_unavailable");
    }
    const listeningAddress = server.address();
    if (listeningAddress === null) {
      await close(server);
      this.#loginActive = false;
      throw new OAuthHarnessError("transport_unavailable");
    }
    // SAFETY: this server was bound to a TCP host/port, never to an IPC pipe.
    const address = listeningAddress as AddressInfo;
    const redirectAuthority = `${protocol.callbackRedirectHost}:${address.port}`;
    const redirectUri = `http://${redirectAuthority}${protocol.callbackPath}`;
    const authorize = new URL(protocol.authorizeUrl);
    for (const [key, value] of Object.entries({
      response_type: "code",
      client_id: protocol.clientId,
      redirect_uri: redirectUri,
      scope: protocol.scopes,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      state,
      ...protocol.authorizeParameters,
    }))
      authorize.searchParams.set(key, value);

    let settle!: (value: OAuthConnectionStatus) => void;
    let reject!: (reason: OAuthHarnessError) => void;
    const completed = new Promise<OAuthConnectionStatus>((resolve, fail) => {
      settle = resolve;
      reject = fail;
    });
    let finished = false;
    const finish = async (
      result: { readonly status: OAuthConnectionStatus } | { readonly error: OAuthHarnessError },
    ) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      verifier = null;
      this.#loginActive = false;
      await close(server);
      if ("status" in result) settle(result.status);
      else reject(result.error);
    };
    const abort = () => void finish({ error: new OAuthHarnessError("cancelled") });
    const timer = setTimeout(
      () => void finish({ error: new OAuthHarnessError("callback_timeout") }),
      timeoutMs,
    );
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();

    server.on("request", (request, response) => {
      void (async () => {
        const callback = new URL(request.url ?? "/", redirectUri);
        if (
          request.method !== "GET" ||
          callback.pathname !== protocol.callbackPath ||
          request.headers.host !== redirectAuthority
        ) {
          response.writeHead(400).end("Invalid OAuth callback.");
          return;
        }
        const returnedState = callback.searchParams.get("state");
        const code = callback.searchParams.get("code");
        if (returnedState === null || !safeEqual(returnedState, state)) {
          response.writeHead(400).end("OAuth state mismatch.");
          await finish({ error: new OAuthHarnessError("callback_state_mismatch") });
          return;
        }
        if (code === null || code.length === 0 || verifier === null) {
          response.writeHead(400).end("Invalid OAuth callback.");
          await finish({ error: new OAuthHarnessError("callback_invalid") });
          return;
        }
        try {
          const commonGrant = {
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            client_id: protocol.clientId,
            code_verifier: verifier,
          } as const;
          const grant: AuthorizationCodeGrant =
            protocol.provider === "anthropic" ? { ...commonGrant, state } : commonGrant;
          const credential = await this.#exchange(grant);
          await this.#store.write(protocol.provider, credential);
          response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
          response.end("Connected. You may close this window.");
          await finish({ status: await this.status() });
        } catch (error) {
          response.writeHead(502).end("OAuth provider rejected the request.");
          await finish({
            error:
              error instanceof OAuthHarnessError
                ? error
                : new OAuthHarnessError("provider_rejected", null, {
                    provider: protocol.provider,
                    operation: "login_callback",
                  }),
          });
        }
      })();
    });

    return {
      provider: protocol.provider,
      authorizationUrl: authorize.toString(),
      completed,
      cancel: abort,
    };
  }

  async #exchange(values: TokenGrant, previous?: StoredCredential): Promise<StoredCredential> {
    const context: OAuthHarnessErrorContext = {
      provider: this.#protocol.provider,
      operation: values.grant_type === "refresh_token" ? "token_refresh" : "token_exchange",
    };
    const encoded = tokenBody(this.#protocol, values);
    let response: Response;
    try {
      response = await this.#fetch(this.#protocol.tokenUrl, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": encoded.contentType },
        body: encoded.body,
        redirect: "error",
      });
    } catch {
      throw new OAuthHarnessError("transport_unavailable", null, context);
    }
    if (!response.ok) throw new OAuthHarnessError("provider_rejected", response.status, context);
    try {
      const token = Option.getOrThrowWith(
        decodeTokenResponse(await response.json()),
        () => new OAuthHarnessError("invalid_token_response", response.status, context),
      );
      const parsed = parseTokens(token, previous);
      return { ...parsed, expiresAt: this.#now() + (parsed.expiresAt - Date.now()) };
    } catch (error) {
      if (error instanceof OAuthHarnessError) throw error;
      throw new OAuthHarnessError("invalid_token_response", response.status, context);
    }
  }

  /** Forces one refresh for an explicit live protocol check and returns no credentials. */
  async refreshForValidation(): Promise<OAuthConnectionStatus> {
    const credential = await this.#store.read(this.#protocol.provider);
    if (!credential) throw new OAuthHarnessError("not_connected");
    await this.#refresh(credential);
    return this.status();
  }

  async #refresh(credential: StoredCredential): Promise<StoredCredential> {
    if (this.#refreshing) return this.#refreshing;
    this.#refreshing = (async () => {
      const commonGrant = {
        grant_type: "refresh_token",
        refresh_token: credential.refreshToken,
        client_id: this.#protocol.clientId,
      } as const;
      const grant: RefreshTokenGrant =
        this.#protocol.provider === "anthropic"
          ? {
              ...commonGrant,
              scope: this.#protocol.scopes.replace("org:create_api_key ", ""),
            }
          : commonGrant;
      try {
        const next = await this.#exchange(grant, credential);
        await this.#store.write(this.#protocol.provider, next);
        return next;
      } catch (error) {
        if (error instanceof OAuthHarnessError && invalidatesStoredCredential(error))
          await this.#store.remove(this.#protocol.provider);
        throw error;
      }
    })();
    try {
      return await this.#refreshing;
    } finally {
      this.#refreshing = null;
    }
  }

  async #authorizedCatalogRequest(url: URL, credential: StoredCredential): Promise<Response> {
    const headers = new Headers(this.#protocol.modelHeaders);
    headers.set("Accept", "application/json");
    headers.delete("Content-Type");
    headers.set("Authorization", `Bearer ${credential.accessToken}`);
    if (this.#protocol.provider === "openai" && credential.accountId !== undefined)
      headers.set("chatgpt-account-id", credential.accountId);
    if (this.#protocol.provider === "anthropic") {
      headers.set("x-client-request-id", randomUUID());
      headers.set("X-Claude-Code-Session-Id", this.#anthropicSessionId);
    }
    return this.#fetch(url, {
      method: "GET",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    }).catch(() => {
      throw new OAuthHarnessError("transport_unavailable", null, {
        provider: this.#protocol.provider,
        operation: "model_catalog",
      });
    });
  }

  /** Fetches only the provider's fixed model-catalog endpoint and never returns credentials. */
  async modelCatalog(): Promise<ReadonlyArray<unknown>> {
    const context: OAuthHarnessErrorContext = {
      provider: this.#protocol.provider,
      operation: "model_catalog",
    };
    let credential = await this.#store.read(this.#protocol.provider);
    if (!credential) throw new OAuthHarnessError("not_connected", null, context);
    if (credential.expiresAt <= this.#now() + 30_000) credential = await this.#refresh(credential);

    const pages: unknown[] = [];
    let afterId: string | undefined;
    for (;;) {
      const url = new URL(this.#protocol.catalogUrl);
      if (this.#protocol.provider === "anthropic") {
        url.searchParams.set("limit", "1000");
        if (afterId !== undefined) url.searchParams.set("after_id", afterId);
      }
      let response = await this.#authorizedCatalogRequest(url, credential);
      if (this.#protocol.refreshStatuses.includes(response.status)) {
        credential = await this.#refresh(credential);
        response = await this.#authorizedCatalogRequest(url, credential);
      }
      if (!response.ok) throw new OAuthHarnessError("provider_rejected", response.status, context);
      let page: unknown;
      try {
        page = await response.json();
      } catch {
        throw new OAuthHarnessError("provider_rejected", response.status, context);
      }
      pages.push(page);
      if (this.#protocol.provider !== "anthropic") break;
      const pagination = Option.getOrUndefined(decodeCatalogPage(page));
      if (pagination?.has_more !== true || pagination.last_id === undefined) break;
      afterId = pagination.last_id;
    }
    return pages;
  }

  async *stream(
    serializedBody: string,
    signal?: AbortSignal,
  ): AsyncGenerator<NormalizedStreamEvent> {
    const context: OAuthHarnessErrorContext = {
      provider: this.#protocol.provider,
      operation: "model_stream",
    };
    let credential = await this.#store.read(this.#protocol.provider);
    if (!credential) throw new OAuthHarnessError("not_connected", null, context);
    if (credential.expiresAt <= this.#now() + 30_000) credential = await this.#refresh(credential);

    const providerBody =
      this.#protocol.provider === "anthropic"
        ? prepareAnthropicValidationBody(serializedBody, this.#anthropicSessionId)
        : serializedBody;

    const request = (current: StoredCredential) => {
      const headers = new Headers(this.#protocol.modelHeaders);
      headers.set("Authorization", `Bearer ${current.accessToken}`);
      if (this.#protocol.provider === "openai" && current.accountId !== undefined)
        headers.set("chatgpt-account-id", current.accountId);
      if (this.#protocol.provider === "anthropic") {
        headers.set("x-client-request-id", randomUUID());
        headers.set("X-Claude-Code-Session-Id", this.#anthropicSessionId);
        headers.set("X-Stainless-Arch", process.arch === "x64" ? "x64" : process.arch);
        headers.set(
          "X-Stainless-OS",
          process.platform === "darwin"
            ? "MacOS"
            : process.platform === "win32"
              ? "Windows"
              : process.platform === "linux"
                ? "Linux"
                : process.platform,
        );
      }
      return this.#fetch(this.#protocol.modelUrl, {
        method: "POST",
        headers,
        body: providerBody,
        redirect: "error",
        signal,
      }).catch(() => {
        throw new OAuthHarnessError("transport_unavailable", null, context);
      });
    };

    let response = await request(credential);
    if (this.#protocol.refreshStatuses.includes(response.status)) {
      credential = await this.#refresh(credential);
      response = await request(credential);
    }
    if (!response.ok) {
      const responseText = await response
        .clone()
        .text()
        .catch(() => "");
      if (
        this.#protocol.provider === "anthropic" &&
        (response.status === 400 || response.status === 422) &&
        /cache[_ -]?control|prompt[_ -]?cach/i.test(responseText)
      )
        throw new ProviderFeatureRejectedError("anthropic", "prompt-cache", response.status);
      throw new OAuthHarnessError("provider_rejected", response.status, context);
    }
    yield* sseEvents(this.#protocol.provider, response);
  }
}

/** @deprecated Use SubscriptionOAuthClient. Retained for validation scripts and tests. */
export { SubscriptionOAuthClient as OAuthValidationHarness };
