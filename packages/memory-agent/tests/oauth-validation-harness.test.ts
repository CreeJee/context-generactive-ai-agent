import { it } from "@effect/vitest";
// OAuth clients keep native HTTP Promise boundaries; test ownership uses Scope.
import {
  Cause,
  Deferred,
  Effect,
  Fiber,
  Function as EffectFunction,
  MutableHashMap,
  MutableRef,
  Option,
  DateTime,
  Result,
  Schema,
  Scope,
  Stream,
} from "effect";
import {
  testHttpServer,
  testHttpClient,
  HttpServerRequest,
  HttpServerResponse,
} from "./support/http.ts";
import { withOAuthTestPlatform } from "./support/platform.ts";
import { HttpClientRequest, FetchHttpClient } from "effect/http";
import { describe, expect, test } from "vite-plus/test";
import {
  createSubscriptionOAuthClient,
  OAuthHarnessError,
  providerKeychainService,
  type CredentialStore,
  type StoredCredential,
  type SubscriptionOAuthClient,
} from "../src/oauth/validation-harness.ts";
import {
  NormalizedStreamEvent,
  ProviderFeatureRejectedError,
  ProviderStatusRejected,
  ProviderStreamFailed,
  providerProtocols,
  RequestNotSent,
  RequestOutcomeUnknown,
  ResponseInterrupted,
  type OAuthProvider,
  type ProviderProtocol,
} from "../src/oauth/protocol.ts";
import { toPrompt } from "../src/model/prompt.ts";
import { subscriptionBody } from "../src/model/subscription.ts";

class MemoryCredentialStore implements CredentialStore {
  readonly values = MutableHashMap.empty<OAuthProvider, StoredCredential>();
  writes = 0;
  read(provider: OAuthProvider) {
    return Effect.sync(() => Option.getOrNull(MutableHashMap.get(this.values, provider)));
  }
  write(provider: OAuthProvider, credential: StoredCredential) {
    return Effect.sync(() => {
      this.writes += 1;
      MutableHashMap.set(this.values, provider, credential);
    });
  }
  remove(provider: OAuthProvider) {
    return Effect.sync(() => {
      MutableHashMap.remove(this.values, provider);
    });
  }
}

/** Runs a fixture Effect for the client's native fetch in the test's Scope; a failure rejects with its cause. */
const nativeRunner = Effect.fn("oauthFixture.nativeRunner")(function* () {
  const scope = yield* Effect.scope;
  const runNative = Effect.runPromiseWith(yield* Effect.context());
  return <A>(program: Effect.Effect<A, Cause.UnknownError>) =>
    runNative(Effect.forkIn(Effect.result(program), scope).pipe(Effect.flatMap(Fiber.join))).then(
      Result.match({
        onSuccess: (value) => value,
        onFailure: (failure) => Promise.reject(failure.cause),
      }),
    );
});

/** undici rejects fetch with a TypeError whose cause carries the socket error code. */
const connectTimeout = () =>
  Promise.reject(
    new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
    }),
  );

it.live("catalog interruption aborts the native HTTP signal without credential writes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const runSdk = yield* nativeRunner();
      const store = new MemoryCredentialStore();
      yield* store.write("openai", {
        accessToken: "fixture",
        refreshToken: "fixture",
        expiresAt: DateTime.toEpochMillis(DateTime.nowUnsafe()) + 3600_000,
      });
      const observed = MutableRef.make<AbortSignal | null | undefined>(undefined);
      const starting = yield* Deferred.make<void>();
      const client = yield* createSubscriptionOAuthClient({
        protocol: providerProtocols.openai,
        store,
        fetch: (_url, init) =>
          runSdk(
            Effect.gen(function* () {
              const signal = init?.signal;
              MutableRef.set(observed, signal);
              yield* Deferred.succeed(starting, undefined);
              return yield* Effect.callback<Response, Cause.UnknownError>((resume) => {
                const abort = () =>
                  resume(
                    Effect.fail(
                      new Cause.UnknownError(new DOMException("Aborted fixture", "AbortError")),
                    ),
                  );
                signal?.addEventListener("abort", abort, { once: true });
                if (signal?.aborted === true) abort();
                return Effect.sync(() => signal?.removeEventListener("abort", abort));
              });
            }),
          ),
      });
      const catalog = yield* Effect.forkChild(client.modelCatalog, { startImmediately: true });
      yield* Deferred.await(starting);
      yield* Fiber.interrupt(catalog);
      expect(MutableRef.get(observed)?.aborted).toBe(true);
      expect(store.writes).toBe(1);
    }),
  ).pipe(withOAuthTestPlatform),
);

it.live.each(["cancel", "timeout"] as const)(
  "%s after callback admission never writes late token results",
  (mode) =>
    Effect.scoped(
      Effect.gen(function* () {
        const runSdk = yield* nativeRunner();
        const store = new MemoryCredentialStore();
        const previous = {
          accessToken: "previous",
          refreshToken: "previous-refresh",
          expiresAt: DateTime.toEpochMillis(DateTime.nowUnsafe()) + 3600_000,
        };
        yield* store.write("openai", previous);
        const gate = yield* Deferred.make<void>();
        const exchanging = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() => Deferred.succeed(gate, undefined));
        const client = yield* createSubscriptionOAuthClient({
          protocol: { ...providerProtocols.openai, callbackPort: null },
          store,
          fetch: () =>
            runSdk(
              Effect.gen(function* () {
                yield* Deferred.succeed(exchanging, undefined);
                yield* Deferred.await(gate);
                return Response.json({
                  access_token: "late",
                  refresh_token: "late-refresh",
                  expires_in: 3600,
                });
              }),
            ),
        });
        const login = yield* Effect.acquireRelease(
          client.startLogin({ timeoutMs: mode === "timeout" ? 100 : 5000 }),
          (started) => started.cancel,
        );
        const authorize = new URL(login.authorizationUrl);
        const callback = new URL(authorize.searchParams.get("redirect_uri")!);
        callback.searchParams.set("code", "accepted-code");
        callback.searchParams.set("state", authorize.searchParams.get("state")!);
        const response = yield* Effect.forkChild(
          (yield* testHttpClient()).get(callback.toString()),
          { startImmediately: true },
        );
        yield* Deferred.await(exchanging);
        if (mode === "cancel") yield* login.cancel;
        else yield* Effect.sleep("150 millis");
        yield* Deferred.succeed(gate, undefined);
        const rejected = yield* Fiber.join(response);
        expect(rejected.status).toBe(410);
        yield* rejected.text;
        expect(yield* Effect.flip(login.completed)).toMatchObject({
          code: mode === "cancel" ? "cancelled" : "callback_timeout",
        });
        expect(yield* store.read("openai")).toEqual(previous);
        expect(store.writes).toBe(1);
      }),
    ).pipe(withOAuthTestPlatform),
);

const nativeHttpResponse = Effect.fn("oauthFixture.nativeHttpResponse")(function* (
  request: HttpClientRequest.HttpClientRequest,
) {
  const client = yield* testHttpClient();
  const response = yield* client
    .execute(request)
    .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "follow" }));
  return new Response(yield* Stream.toReadableStreamEffect(response.stream), {
    status: response.status,
    headers: response.headers,
  });
});
const jsonStringify = EffectFunction.flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)),
  Result.getOrThrow,
);
const fakeProvider = Effect.fn("fakeOAuthProvider")(function* (provider: OAuthProvider) {
  const tokenRequests = MutableRef.make(0);
  const refreshRequests = MutableRef.make(0);
  const modelRequests = MutableRef.make(0);
  const catalogRequests = MutableRef.make(0);
  const forceUnauthorized = MutableRef.make(false);
  const rejectRefresh = MutableRef.make<number | null>(null);
  const authorizations: string[] = [];
  const tokenBodies: string[] = [];
  const modelBodies: string[] = [];
  const modelHeaders: Array<Record<string, string | string[] | undefined>> = [];
  const catalogHeaders: Array<Record<string, string | string[] | undefined>> = [];
  const catalogUrls: string[] = [];
  const { url: base } = yield* testHttpServer(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.pathname === "/authorize") {
        authorizations.push(url.search);
        const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
        redirect.searchParams.set("code", "authorization-code-secret");
        redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
        return HttpServerResponse.empty({
          status: 302,
          headers: { location: redirect.toString() },
        });
      }
      if (url.pathname === "/token") {
        MutableRef.increment(tokenRequests);
        const raw = yield* request.text;
        tokenBodies.push(raw);
        const isRefresh =
          request.headers["content-type"] === "application/json"
            ? raw.includes('"grant_type":"refresh_token"')
            : new URLSearchParams(raw).get("grant_type") === "refresh_token";
        if (isRefresh) MutableRef.increment(refreshRequests);
        const rejection = MutableRef.get(rejectRefresh);
        if (isRefresh && rejection !== null) return HttpServerResponse.empty({ status: rejection });
        const suffix = isRefresh ? "2" : "1";
        const claims = Buffer.from(
          jsonStringify({
            "https://api.openai.com/auth": { chatgpt_account_id: "account-internal-1" },
          }),
        ).toString("base64url");
        return yield* HttpServerResponse.json({
          access_token: `access-secret-${suffix}`,
          refresh_token: `refresh-secret-${suffix}`,
          id_token: `header.${claims}.signature`,
          expires_in: 3600,
        });
      }
      if (url.pathname === "/catalog") {
        MutableRef.increment(catalogRequests);
        catalogHeaders.push(request.headers);
        catalogUrls.push(url.toString());
        if (
          MutableRef.get(forceUnauthorized) &&
          request.headers.authorization === "Bearer access-secret-1"
        )
          return HttpServerResponse.empty({ status: provider === "openai" ? 401 : 403 });
        return yield* HttpServerResponse.json(
          provider === "openai"
            ? { models: [{ slug: "gpt-test" }] }
            : url.searchParams.get("after_id") === "page-1"
              ? { data: [{ id: "claude-page-2" }], has_more: false }
              : { data: [{ id: "claude-page-1" }], has_more: true, last_id: "page-1" },
        );
      }
      if (url.pathname === "/model") {
        MutableRef.increment(modelRequests);
        modelHeaders.push(request.headers);
        modelBodies.push(yield* request.text);
        if (
          MutableRef.get(forceUnauthorized) &&
          request.headers.authorization === "Bearer access-secret-1"
        )
          return HttpServerResponse.empty({ status: 401 });
        const events: string[] = [];
        if (provider === "openai") {
          events.push('data: {"type":"response.output_text.delta","delta":"hello"}\n\n');
          events.push(
            'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call-1","name":"lookup","arguments":"{\\\"q\\\":\\\"x\\\"}"}}\n\n',
          );
        } else {
          events.push(
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n',
          );
          events.push(
            'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call-1","name":"lookup","input":{}}}\n\n',
          );
          events.push(
            `data: ${jsonStringify({
              type: "content_block_delta",
              index: 1,
              delta: { type: "input_json_delta", partial_json: '{"q":"x"}' },
            })}\n\n`,
          );
          events.push('data: {"type":"content_block_stop","index":1}\n\n');
        }
        events.push("data: [DONE]\n\n");
        return HttpServerResponse.stream(Stream.fromIterable(events).pipe(Stream.encodeText), {
          contentType: "text/event-stream",
        });
      }
      return HttpServerResponse.empty({ status: 404 });
    }),
  );
  const original = providerProtocols[provider];
  const protocol: ProviderProtocol = {
    ...original,
    authorizeUrl: `${base}/authorize`,
    tokenUrl: `${base}/token`,
    modelUrl: `${base}/model`,
    catalogUrl: `${base}/catalog`,
    callbackPort: null,
    // Keep each provider's production hostname while using an ephemeral callback port.
    callbackRedirectHost: original.callbackRedirectHost,
  };
  return {
    protocol,
    authorizations,
    tokenBodies,
    modelBodies,
    modelHeaders,
    catalogHeaders,
    catalogUrls,
    counts: () => ({
      tokenRequests: MutableRef.get(tokenRequests),
      refreshRequests: MutableRef.get(refreshRequests),
      modelRequests: MutableRef.get(modelRequests),
      catalogRequests: MutableRef.get(catalogRequests),
    }),
    requireRefresh: () => {
      MutableRef.set(forceUnauthorized, true);
    },
    rejectRefresh: (status = 401) => {
      MutableRef.set(rejectRefresh, status);
    },
  };
});

const login = Effect.fn("loginOAuthFixture")(function* (harness: SubscriptionOAuthClient) {
  const attempt = yield* harness.startLogin({ timeoutMs: 1_000 });
  const browser = yield* (yield* testHttpClient()).get(String(attempt.authorizationUrl));
  expect(browser.status).toBe(200);
  return yield* attempt.completed;
});

test("identifies the provider, operation and HTTP status without exposing response data", () => {
  const error = OAuthHarnessError.fromCode("provider_rejected", 429, {
    provider: "openai",
    operation: "model_stream",
  });

  expect(error).toMatchObject({
    code: "provider_rejected",
    provider: "openai",
    operation: "model_stream",
    status: 429,
  });
  expect(error.message).toBe(
    "oauth_provider_rejected [provider=OpenAI, operation=model_stream, status=429]: The provider rejected the request.",
  );
});

it.live("reports a browser denial without exposing OAuth callback parameters", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = yield* fakeProvider("openai");
      const harness = yield* createSubscriptionOAuthClient({
        protocol: fake.protocol,
        store: new MemoryCredentialStore(),
      });
      const attempt = yield* harness.startLogin({ timeoutMs: 1_000 });
      const authorize = new URL(attempt.authorizationUrl);
      const callback = new URL(authorize.searchParams.get("redirect_uri")!);
      callback.searchParams.set("state", authorize.searchParams.get("state")!);
      callback.searchParams.set("error", "access_denied");
      callback.searchParams.set("error_description", "secret-from-browser");
      expect((yield* (yield* testHttpClient()).get(String(callback))).status).toBe(400);
      expect(yield* Effect.flip(attempt.completed)).toMatchObject({
        code: "provider_rejected",
        operation: "login_callback",
        providerCode: "access_denied",
      });
    }),
  ).pipe(withOAuthTestPlatform),
);

it.live("reports credential write failure without blaming the provider or exposing tokens", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = yield* fakeProvider("openai");
      const store: CredentialStore = {
        read: () => Effect.succeed(null),
        write: () =>
          Effect.fail(
            OAuthHarnessError.fromCode("credential_store_unavailable", null, {
              provider: "openai",
              operation: "credential_store",
              credentialStage: "write",
            }),
          ),
        remove: () => Effect.void,
      };
      const harness = yield* createSubscriptionOAuthClient({ protocol: fake.protocol, store });
      const attempt = yield* harness.startLogin({ timeoutMs: 1_000 });
      const browser = yield* (yield* testHttpClient()).get(String(attempt.authorizationUrl));
      expect(browser.status).toBe(502);
      const text = yield* browser.text;
      expect(text).toContain("credential store is unavailable");
      expect(text).not.toContain("access-secret");
      expect(yield* Effect.flip(attempt.completed)).toMatchObject({
        code: "credential_store_unavailable",
        operation: "credential_store",
        credentialStage: "write",
      });
    }),
  ).pipe(withOAuthTestPlatform),
);

it.live("classifies token exchange transport failures without exposing native error text", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = yield* fakeProvider("openai");
      const harness = yield* createSubscriptionOAuthClient({
        protocol: fake.protocol,
        store: new MemoryCredentialStore(),
        fetch: () =>
          Promise.reject(
            new TypeError("private network detail", {
              cause: Object.assign(new Error("private host detail"), { code: "ENETUNREACH" }),
            }),
          ),
      });
      const attempt = yield* harness.startLogin({ timeoutMs: 1_000 });
      expect((yield* (yield* testHttpClient()).get(String(attempt.authorizationUrl))).status).toBe(
        502,
      );
      const failure = yield* Effect.flip(attempt.completed);
      expect(failure).toMatchObject({
        code: "transport_unavailable",
        operation: "token_exchange",
        transportCode: "ENETUNREACH",
      });
      expect(jsonStringify(failure)).not.toContain("private network detail");
      expect(jsonStringify(failure)).not.toContain("private host detail");
    }),
  ).pipe(withOAuthTestPlatform),
);

it.live("retries an OpenAI pre-connect timeout once on a scoped proxy route", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const fake = yield* fakeProvider("openai");
      const proxyCalls = MutableRef.make(0);
      const harness = yield* createSubscriptionOAuthClient({
        protocol: fake.protocol,
        store: new MemoryCredentialStore(),
        fetch: connectTimeout,
        tokenProxyFetch: (url, body, contentType) =>
          Effect.gen(function* () {
            MutableRef.increment(proxyCalls);
            expect(url).toBe(fake.protocol.tokenUrl);
            return {
              route: "attempted" as const,
              response: yield* Scope.provide(
                nativeHttpResponse(
                  HttpClientRequest.post(url).pipe(HttpClientRequest.bodyText(body, contentType)),
                ),
                scope,
              ).pipe(Effect.mapError((cause) => new Cause.UnknownError(cause))),
            };
          }),
      });
      expect(yield* login(harness)).toMatchObject({ provider: "openai", connected: true });
      expect(MutableRef.get(proxyCalls)).toBe(1);
      expect(fake.counts().tokenRequests).toBe(1);
    }),
  ).pipe(withOAuthTestPlatform),
);

it.live.each(["direct", "unavailable", "attempted"] as const)(
  "reports proxy route %s without exposing the proxy address",
  (route) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* fakeProvider("openai");
        const harness = yield* createSubscriptionOAuthClient({
          protocol: fake.protocol,
          store: new MemoryCredentialStore(),
          fetch: connectTimeout,
          tokenProxyFetch: () =>
            route === "attempted"
              ? Effect.fail(
                  new Cause.UnknownError(
                    new TypeError("http://private-proxy.example", {
                      cause: Object.assign(new Error("connect timeout"), {
                        code: "UND_ERR_CONNECT_TIMEOUT",
                      }),
                    }),
                  ),
                )
              : Effect.succeed({ route, response: null }),
        });
        const attempt = yield* harness.startLogin({ timeoutMs: 1_000 });
        expect(
          (yield* (yield* testHttpClient()).get(String(attempt.authorizationUrl))).status,
        ).toBe(502);
        const failure = yield* Effect.flip(attempt.completed);
        expect(failure).toMatchObject({
          code: "transport_unavailable",
          transportCode: "UND_ERR_CONNECT_TIMEOUT",
          proxyRoute: route,
        });
        expect(jsonStringify(failure)).not.toContain("private-proxy.example");
      }),
    ).pipe(withOAuthTestPlatform),
);

it.live("does not replay an authorization code after a non-connect failure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = yield* fakeProvider("openai");
      const proxyCalls = MutableRef.make(0);
      const harness = yield* createSubscriptionOAuthClient({
        protocol: fake.protocol,
        store: new MemoryCredentialStore(),
        fetch: () => Promise.reject(new DOMException("timed out", "TimeoutError")),
        tokenProxyFetch: () =>
          Effect.sync(() => {
            MutableRef.increment(proxyCalls);
            return { route: "unavailable" as const, response: null };
          }),
      });
      const attempt = yield* harness.startLogin({ timeoutMs: 1_000 });
      expect((yield* (yield* testHttpClient()).get(String(attempt.authorizationUrl))).status).toBe(
        502,
      );
      expect(yield* Effect.flip(attempt.completed)).toMatchObject({
        code: "transport_unavailable",
        transportCode: "timeout",
      });
      expect(MutableRef.get(proxyCalls)).toBe(0);
    }),
  ).pipe(withOAuthTestPlatform),
);

it.live("exposes only a validated provider error code from a failed token exchange", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const runSdk = yield* nativeRunner();
      const fake = yield* fakeProvider("openai");
      const harness = yield* createSubscriptionOAuthClient({
        protocol: fake.protocol,
        store: new MemoryCredentialStore(),
        fetch: (input, init) =>
          runSdk(
            (input === fake.protocol.tokenUrl
              ? Effect.succeed(
                  new Response(
                    jsonStringify({
                      error: { code: "access_denied", message: "private-user-data" },
                      access_token: "secret-token",
                    }),
                    { status: 403 },
                  ),
                )
              : Scope.provide(
                  nativeHttpResponse(HttpClientRequest.fromWeb(new Request(input, init))),
                  scope,
                )
            ).pipe(Effect.mapError((cause) => new Cause.UnknownError(cause))),
          ),
      });
      const attempt = yield* harness.startLogin({ timeoutMs: 1_000 });
      expect((yield* (yield* testHttpClient()).get(String(attempt.authorizationUrl))).status).toBe(
        502,
      );
      expect(yield* Effect.flip(attempt.completed)).toMatchObject({
        code: "provider_rejected",
        operation: "token_exchange",
        status: 403,
        providerCode: "access_denied",
      });
    }),
  ).pipe(withOAuthTestPlatform),
);

describe.each(["openai", "anthropic"] as const)("%s OAuth validation harness", (provider) => {
  it.live("uses PKCE/state, exchanges the callback internally, and exposes only status", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* fakeProvider(provider);
        const store = new MemoryCredentialStore();
        const harness = yield* createSubscriptionOAuthClient({ protocol: fake.protocol, store });
        const status = yield* login(harness);

        expect(status).toMatchObject({ provider, connected: true });
        expect(jsonStringify(status)).not.toContain("secret");
        const auth = new URLSearchParams(fake.authorizations[0]);
        const redirect = new URL(auth.get("redirect_uri")!);
        expect(redirect.hostname).toBe(provider === "openai" ? "127.0.0.1" : "localhost");
        expect(redirect.pathname).toBe(fake.protocol.callbackPath);
        expect(fake.tokenBodies[0]).toContain(
          provider === "openai" ? encodeURIComponent(redirect.toString()) : redirect.toString(),
        );
        expect(auth.get("code_challenge_method")).toBe("S256");
        expect(auth.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(auth.get("state")).toMatch(/^[A-Za-z0-9_-]{40,}$/);
        expect(auth.get("scope")).toContain(
          provider === "anthropic" ? "user:inference" : "offline_access",
        );
        expect(fake.tokenBodies[0]).toContain("code_verifier");
        expect(fake.tokenBodies[0]).toContain("authorization-code-secret");
        if (provider === "anthropic") {
          const expectedState = auth.get("state");
          expect(fake.tokenBodies[0]).toContain(`"state":"${expectedState}"`);
          expect(fake.tokenBodies[0]).toContain(`"code_verifier":"${expectedState}"`);
        }
        expect(yield* harness.disconnect).toEqual({
          provider,
          connected: false,
          expiresAt: null,
        });
      }),
    ).pipe(withOAuthTestPlatform),
  );

  it.live("streams text and one tool call with provider headers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* fakeProvider(provider);
        const harness = yield* createSubscriptionOAuthClient({
          protocol: fake.protocol,
          store: new MemoryCredentialStore(),
        });
        yield* login(harness);

        const events = yield* Stream.runCollect(harness.stream('{"model":"test","stream":true}'));

        expect(events).toEqual(
          provider === "openai"
            ? [
                NormalizedStreamEvent.text({ text: "hello" }),
                NormalizedStreamEvent["tool-call"]({
                  id: "call-1",
                  name: "lookup",
                  arguments: { q: "x" },
                }),
              ]
            : [
                NormalizedStreamEvent.text({ text: "hello" }),
                NormalizedStreamEvent["tool-call-start"]({
                  index: 1,
                  id: "call-1",
                  name: "lookup",
                }),
                NormalizedStreamEvent["tool-call-arguments"]({
                  index: 1,
                  delta: '{"q":"x"}',
                }),
                NormalizedStreamEvent["content-block-end"]({ index: 1 }),
              ],
        );
        expect(fake.modelHeaders[0]?.authorization).toBe("Bearer access-secret-1");
        if (provider === "openai")
          expect(fake.modelHeaders[0]?.["chatgpt-account-id"]).toBe("account-internal-1");
        if (provider === "anthropic") {
          expect(fake.modelHeaders[0]?.["anthropic-version"]).toBe("2023-06-01");
          expect(fake.modelHeaders[0]?.["anthropic-beta"]).toContain("claude-code-20250219");
          expect(fake.modelHeaders[0]?.["anthropic-beta"]).toContain("oauth-2025-04-20");
          expect(fake.modelHeaders[0]?.["x-claude-code-session-id"]).toBeTruthy();
          expect(fake.modelHeaders[0]?.["x-client-request-id"]).toBeTruthy();
          expect(fake.modelHeaders[0]?.["anthropic-dangerous-direct-browser-access"]).toBe("true");
          expect(fake.modelBodies[0]).toContain("x-anthropic-billing-header");
          expect(fake.modelBodies[0]).toContain("Claude Agent SDK");
          expect(fake.modelBodies[0]).toContain('\\"account_uuid\\":\\"unknown-account\\"');
          expect(fake.modelBodies[0]).toContain('"metadata":{"user_id":');
          expect(fake.modelBodies[0]).not.toContain("access-secret");
        }
      }),
    ).pipe(withOAuthTestPlatform),
  );

  if (provider === "anthropic")
    it.live(
      "sends effort, summarized thinking to models that think by default, bound when always on",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fake = yield* fakeProvider(provider);
            const harness = yield* createSubscriptionOAuthClient({
              protocol: fake.protocol,
              store: new MemoryCredentialStore(),
            });
            yield* login(harness);
            yield* Effect.forEach(
              ["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"],
              (model) =>
                Stream.runDrain(
                  harness.stream(
                    subscriptionBody({
                      provider,
                      selection: { provider, model, reasoningEffort: "high" },
                      prompt: toPrompt([{ role: "user", content: "hi" }], []),
                      tools: [],
                      promptCache: undefined,
                    }),
                  ),
                ),
              { discard: true },
            );
            const [bound, shown, plain] = fake.modelBodies.map((body) => JSON.parse(body));
            expect(bound.output_config).toEqual({ effort: "high" });
            expect(bound.thinking).toEqual({
              type: "adaptive",
              display: "summarized",
              block_binding: { prefix_mismatch_behavior: "drop_block" },
            });
            expect(fake.modelHeaders[0]?.["anthropic-beta"]).toContain(
              "thinking-binding-controls-2026-08-01",
            );
            // Thinks by default, so asking only for the summary changes what is shown, not how it thinks.
            expect(shown.thinking).toEqual({ type: "adaptive", display: "summarized" });
            expect(fake.modelHeaders[1]?.["anthropic-beta"]).toBe(
              providerProtocols.anthropic.modelHeaders["anthropic-beta"],
            );
            // Thinks only when asked: the request leaves that to the model's default.
            expect(plain.output_config).toEqual({ effort: "high" });
            expect(plain.thinking).toBeUndefined();
          }),
        ).pipe(withOAuthTestPlatform),
    );

  it.live("fetches the fixed catalog, paginates, and returns no credentials", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* fakeProvider(provider);
        const harness = yield* createSubscriptionOAuthClient({
          protocol: fake.protocol,
          store: new MemoryCredentialStore(),
        });
        yield* login(harness);
        const pages = yield* harness.modelCatalog;

        expect(pages).toHaveLength(provider === "anthropic" ? 2 : 1);
        expect(jsonStringify(pages)).not.toContain("secret");
        expect(fake.catalogHeaders[0]?.authorization).toBe("Bearer access-secret-1");
        expect(fake.catalogHeaders[0]?.accept).toBe("application/json");
        expect(fake.catalogHeaders[0]?.["content-type"]).toBeUndefined();
        if (provider === "anthropic") {
          expect(fake.catalogUrls[0]).toContain("limit=1000");
          expect(fake.catalogUrls[1]).toContain("after_id=page-1");
        }
      }),
    ).pipe(withOAuthTestPlatform),
  );

  it.live("refreshes once when the fixed catalog rejects the current token", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* fakeProvider(provider);
        const harness = yield* createSubscriptionOAuthClient({
          protocol: fake.protocol,
          store: new MemoryCredentialStore(),
        });
        yield* login(harness);
        fake.requireRefresh();
        yield* harness.modelCatalog;

        expect(fake.counts().refreshRequests).toBe(1);
        expect(fake.catalogHeaders.at(-1)?.authorization).toBe("Bearer access-secret-2");
      }),
    ).pipe(withOAuthTestPlatform),
  );

  it.live("rotates refresh tokens once for concurrent 401/403 retries", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* fakeProvider(provider);
        const store = new MemoryCredentialStore();
        const harness = yield* createSubscriptionOAuthClient({ protocol: fake.protocol, store });
        yield* login(harness);
        fake.requireRefresh();

        const collect = Stream.runCollect(harness.stream('{"stream":true}'));
        const [first, second] = yield* Effect.all([collect, collect], {
          concurrency: "unbounded",
        });

        expect(first).toHaveLength(provider === "openai" ? 2 : 4);
        expect(second).toHaveLength(provider === "openai" ? 2 : 4);
        expect(fake.counts().refreshRequests).toBe(1);
        expect(
          Option.getOrUndefined(MutableHashMap.get(store.values, provider))?.refreshToken,
        ).toBe("refresh-secret-2");
        expect(fake.modelHeaders.at(-1)?.authorization).toBe("Bearer access-secret-2");
      }),
    ).pipe(withOAuthTestPlatform),
  );

  it.live("refreshes an expiring credential while checking connection status", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* fakeProvider(provider);
        const store = new MemoryCredentialStore();
        const harness = yield* createSubscriptionOAuthClient({ protocol: fake.protocol, store });
        yield* login(harness);
        const credential = Option.getOrUndefined(MutableHashMap.get(store.values, provider))!;
        MutableHashMap.set(store.values, provider, {
          ...credential,
          expiresAt: DateTime.toEpochMillis(DateTime.nowUnsafe()) + 20_000,
        });

        expect(yield* harness.status).toMatchObject({ provider, connected: true });
        expect(fake.counts().refreshRequests).toBe(1);
        expect(Option.getOrUndefined(MutableHashMap.get(store.values, provider))?.accessToken).toBe(
          "access-secret-2",
        );
      }),
    ).pipe(withOAuthTestPlatform),
  );

  it.live("signs out after the provider permanently rejects an expired credential", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* fakeProvider(provider);
        const store = new MemoryCredentialStore();
        const harness = yield* createSubscriptionOAuthClient({ protocol: fake.protocol, store });
        yield* login(harness);
        const credential = Option.getOrUndefined(MutableHashMap.get(store.values, provider))!;
        MutableHashMap.set(store.values, provider, {
          ...credential,
          expiresAt: DateTime.toEpochMillis(DateTime.nowUnsafe()) - 1,
        });
        fake.rejectRefresh();

        expect(yield* harness.status).toEqual({
          provider,
          connected: false,
          expiresAt: null,
        });
        expect(fake.counts().refreshRequests).toBe(1);
        expect(MutableHashMap.has(store.values, provider)).toBe(false);
      }),
    ).pipe(withOAuthTestPlatform),
  );

  it.live("keeps the login when a refresh is refused with 403", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* fakeProvider(provider);
        const store = new MemoryCredentialStore();
        const harness = yield* createSubscriptionOAuthClient({ protocol: fake.protocol, store });
        yield* login(harness);
        const credential = Option.getOrUndefined(MutableHashMap.get(store.values, provider))!;
        const expired = {
          ...credential,
          expiresAt: DateTime.toEpochMillis(DateTime.nowUnsafe()) - 1,
        };
        MutableHashMap.set(store.values, provider, expired);
        fake.rejectRefresh(403);

        expect(yield* Effect.flip(harness.status)).toMatchObject({
          code: "provider_rejected",
          status: 403,
        });
        expect(Option.getOrUndefined(MutableHashMap.get(store.values, provider))).toEqual(expired);
      }),
    ).pipe(withOAuthTestPlatform),
  );

  it.live("a caller holding a credential rotated meanwhile reuses the new one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* fakeProvider(provider);
        const store = new MemoryCredentialStore();
        const reading = yield* Deferred.make<void>();
        const held = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() => Deferred.succeed(held, undefined));
        const holdNextRead = MutableRef.make(false);
        const gated: CredentialStore = {
          read: (key) =>
            Effect.suspend(() =>
              MutableRef.getAndSet(holdNextRead, false)
                ? // Snapshot before waiting, as a caller that read the keychain just before a refresh.
                  store
                    .read(key)
                    .pipe(
                      Effect.tap(Deferred.succeed(reading, undefined)),
                      Effect.tap(Deferred.await(held)),
                    )
                : store.read(key),
            ),
          write: (key, value) => store.write(key, value),
          remove: (key) => store.remove(key),
        };
        const harness = yield* createSubscriptionOAuthClient({
          protocol: fake.protocol,
          store: gated,
        });
        yield* login(harness);
        const credential = Option.getOrUndefined(MutableHashMap.get(store.values, provider))!;
        MutableHashMap.set(store.values, provider, {
          ...credential,
          expiresAt: DateTime.toEpochMillis(DateTime.nowUnsafe()) - 1,
        });

        MutableRef.set(holdNextRead, true);
        const stale = yield* Effect.forkChild(harness.status, { startImmediately: true });
        yield* Deferred.await(reading);
        yield* harness.status;
        yield* Deferred.succeed(held, undefined);

        expect(yield* Fiber.join(stale)).toMatchObject({ provider, connected: true });
        expect(fake.counts().refreshRequests).toBe(1);
        expect(
          Option.getOrUndefined(MutableHashMap.get(store.values, provider))?.refreshToken,
        ).toBe("refresh-secret-2");
      }),
    ).pipe(withOAuthTestPlatform),
  );
});

describe("provider wire contracts", () => {
  test("matches the registered OpenAI Codex loopback redirect and login prompt", () => {
    expect(providerProtocols.openai.callbackPort).toBe(1455);
    expect(providerProtocols.openai.callbackRedirectHost).toBe("127.0.0.1");
    expect(providerProtocols.openai.callbackPath).toBe("/auth/callback");
    expect(providerProtocols.openai.authorizeParameters?.["prompt"]).toBe("login");
  });

  test("matches the Claude Code automatic localhost callback contract", () => {
    expect(providerProtocols.anthropic.callbackPort).toBeNull();
    expect(providerProtocols.anthropic.callbackRedirectHost).toBe("localhost");
    expect(providerProtocols.anthropic.callbackPath).toBe("/callback");
    expect(providerProtocols.anthropic.authorizeParameters?.["code"]).toBe("true");
    expect(providerProtocols.anthropic.modelHeaders["anthropic-beta"]).toContain(
      "prompt-caching-scope-2026-01-05",
    );
  });

  it.live("classifies only Anthropic cache-feature HTTP rejection for safe fallback", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const store = new MemoryCredentialStore();
        MutableHashMap.set(store.values, "anthropic", {
          accessToken: "access-secret",
          refreshToken: "refresh-secret",
          expiresAt: DateTime.toEpochMillis(DateTime.nowUnsafe()) + 60_000,
        });
        const cacheRejected = yield* createSubscriptionOAuthClient({
          protocol: providerProtocols.anthropic,
          store,
          fetch: () =>
            Promise.resolve(
              new Response('{"error":{"message":"cache_control is unsupported"}}', {
                status: 400,
              }),
            ),
        });
        const unrelated = yield* createSubscriptionOAuthClient({
          protocol: providerProtocols.anthropic,
          store,
          fetch: () =>
            Promise.resolve(
              new Response(
                '{"type":"error","error":{"type":"invalid_request_error","message":"invalid model"},"request_id":"req_body"}',
                { status: 400, headers: { "request-id": "req_header" } },
              ),
            ),
        });
        const drain = (harness: SubscriptionOAuthClient) =>
          Stream.runDrain(harness.stream('{"model":"test","stream":true}'));

        expect(yield* Effect.flip(drain(cacheRejected))).toBeInstanceOf(
          ProviderFeatureRejectedError,
        );
        const unrelatedFailure = yield* Effect.flip(drain(unrelated));
        expect(unrelatedFailure).toBeInstanceOf(ProviderStreamFailed);
        expect(unrelatedFailure).toMatchObject({
          reason: ProviderStatusRejected.make({
            statusClass: "client_error",
            status: 400,
            error: { type: "invalid_request_error", message: "invalid model" },
            requestId: "req_header",
          }),
        });
      }),
    ).pipe(withOAuthTestPlatform),
  );

  it.live("classifies model request transport failures at the fetch boundary", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const store = new MemoryCredentialStore();
        MutableHashMap.set(store.values, "openai", {
          accessToken: "access-secret",
          refreshToken: "refresh-secret",
          expiresAt: DateTime.toEpochMillis(DateTime.nowUnsafe()) + 60_000,
        });
        const failureOf = Effect.fn("modelStreamFailure")(function* (fetcher: typeof fetch) {
          const harness = yield* createSubscriptionOAuthClient({
            protocol: providerProtocols.openai,
            store,
            fetch: fetcher,
          });
          const failure = yield* Effect.flip(
            Stream.runDrain(harness.stream('{"model":"test","stream":true}')),
          );
          return yield* Schema.decodeUnknownEffect(ProviderStreamFailed)(failure).pipe(
            Effect.map((error) => error.reason),
          );
        });
        // undici rejects fetch with a TypeError whose cause carries the socket error code.
        const rejectsWith = (code: string) => () =>
          Promise.reject(
            new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) }),
          );

        expect(yield* failureOf(rejectsWith("ECONNREFUSED"))).toEqual(
          RequestNotSent.make({ stage: "connect" }),
        );
        expect(yield* failureOf(rejectsWith("ENOTFOUND"))).toEqual(
          RequestNotSent.make({ stage: "dns" }),
        );
        expect(yield* failureOf(rejectsWith("ECONNRESET"))).toEqual(RequestOutcomeUnknown.make({}));
        expect(
          yield* failureOf(() =>
            Promise.resolve(
              new Response(
                new ReadableStream({
                  start(controller) {
                    controller.enqueue(new TextEncoder().encode('data: {"type":"response.'));
                    controller.error(new Error("terminated"));
                  },
                }),
              ),
            ),
          ),
        ).toEqual(ResponseInterrupted.make({}));
      }),
    ).pipe(withOAuthTestPlatform),
  );
});

describe("OAuth callback safety", () => {
  it.live("rejects a mismatched state without including code, state, or tokens in the error", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* fakeProvider("openai");
        const harness = yield* createSubscriptionOAuthClient({
          protocol: fake.protocol,
          store: new MemoryCredentialStore(),
        });
        const attempt = yield* harness.startLogin({ timeoutMs: 1_000 });
        const authorization = new URL(attempt.authorizationUrl);
        const callback = new URL(authorization.searchParams.get("redirect_uri") ?? "");
        callback.searchParams.set("code", "authorization-code-secret");
        callback.searchParams.set("state", "attacker-state-secret");
        yield* (yield* testHttpClient()).get(String(callback));

        const thrown = yield* Effect.flip(attempt.completed);
        expect(thrown).toBeInstanceOf(OAuthHarnessError);
        const message = String(thrown);
        expect(message).toContain("state_mismatch");
        expect(message).not.toContain("authorization-code-secret");
        expect(message).not.toContain("attacker-state-secret");
      }),
    ).pipe(withOAuthTestPlatform),
  );

  it.live("rejects a same-length state that differs in its last byte", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* fakeProvider("openai");
        const harness = yield* createSubscriptionOAuthClient({
          protocol: fake.protocol,
          store: new MemoryCredentialStore(),
        });
        const attempt = yield* harness.startLogin({ timeoutMs: 1_000 });
        const authorization = new URL(attempt.authorizationUrl);
        const state = authorization.searchParams.get("state") ?? "";
        const callback = new URL(authorization.searchParams.get("redirect_uri") ?? "");
        callback.searchParams.set("code", "authorization-code-secret");
        callback.searchParams.set(
          "state",
          `${state.slice(0, -1)}${state.endsWith("A") ? "B" : "A"}`,
        );
        yield* (yield* testHttpClient()).get(String(callback));

        expect(String(yield* Effect.flip(attempt.completed))).toContain("state_mismatch");
      }),
    ).pipe(withOAuthTestPlatform),
  );

  it.live("supports timeout and explicit cancellation with sanitized errors", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* fakeProvider("openai");
        const timeoutHarness = yield* createSubscriptionOAuthClient({
          protocol: fake.protocol,
          store: new MemoryCredentialStore(),
        });
        const timed = yield* timeoutHarness.startLogin({ timeoutMs: 10 });
        expect(yield* Effect.flip(timed.completed)).toMatchObject({ code: "callback_timeout" });

        const cancelHarness = yield* createSubscriptionOAuthClient({
          protocol: fake.protocol,
          store: new MemoryCredentialStore(),
        });
        const cancelled = yield* cancelHarness.startLogin({ timeoutMs: 1_000 });
        yield* cancelled.cancel;
        expect(yield* Effect.flip(cancelled.completed)).toMatchObject({ code: "cancelled" });
      }),
    ).pipe(withOAuthTestPlatform),
  );

  it.live(
    "cancelling while a callback writes restores the prior credential, not the cancelled login",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fake = yield* fakeProvider("anthropic");
          const writing = yield* Deferred.make<void>();
          const held = yield* Deferred.make<void>();
          yield* Effect.addFinalizer(() => Deferred.succeed(held, undefined));
          const prior: StoredCredential = {
            accessToken: "prior-access",
            refreshToken: "prior-refresh",
            expiresAt: DateTime.toEpochMillis(DateTime.nowUnsafe()) + 300_000,
          };
          const store = new MemoryCredentialStore();
          MutableHashMap.set(store.values, "anthropic", prior);
          const deferred: CredentialStore = {
            read: (provider) => store.read(provider),
            write: (provider, value) =>
              Effect.gen(function* () {
                yield* store.write(provider, value);
                yield* Deferred.succeed(writing, undefined);
                yield* Deferred.await(held);
              }),
            remove: (provider) => store.remove(provider),
          };
          const harness = yield* createSubscriptionOAuthClient({
            protocol: fake.protocol,
            store: deferred,
          });
          const attempt = yield* harness.startLogin({ timeoutMs: 5_000 });
          const browser = yield* Effect.forkChild(
            (yield* testHttpClient()).get(attempt.authorizationUrl),
            { startImmediately: true },
          );
          yield* Deferred.await(writing);
          yield* attempt.cancel;
          yield* Deferred.succeed(held, undefined);
          expect(yield* Effect.flip(attempt.completed)).toMatchObject({ code: "cancelled" });
          yield* Fiber.join(browser);
          expect(Option.getOrUndefined(MutableHashMap.get(store.values, "anthropic"))).toEqual(
            prior,
          );
        }),
      ).pipe(withOAuthTestPlatform),
  );

  test("uses separate OS-keychain namespaces and has no file fallback contract", () => {
    expect(providerKeychainService("openai")).toBe("com.context-agent.oauth.openai");
    expect(providerKeychainService("anthropic")).toBe("com.context-agent.oauth.anthropic");
    expect(providerKeychainService("openai")).not.toBe(providerKeychainService("anthropic"));
  });
});
