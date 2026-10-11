import { it } from "@effect/vitest";
// OAuth clients retain native HTTP/credential Promise boundaries; test ownership uses Scope.
import {
  Cause,
  Deferred,
  Effect,
  Fiber,
  Function as EffectFunction,
  MutableHashMap,
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
import { HttpClientRequest, FetchHttpClient } from "effect/http";
import { describe, expect, test } from "vite-plus/test";
import {
  createSubscriptionOAuthClient,
  OAuthHarnessError,
  OAuthValidationHarness,
  providerKeychainService,
  type CredentialStore,
  type StoredCredential,
} from "../src/oauth/validation-harness.ts";
import {
  ProviderFeatureRejectedError,
  providerProtocols,
  type OAuthProvider,
  type ProviderProtocol,
} from "../src/oauth/protocol.ts";

class MemoryCredentialStore implements CredentialStore {
  readonly values = MutableHashMap.empty<OAuthProvider, StoredCredential>();
  writes = 0;
  read(provider: OAuthProvider) {
    return Promise.resolve(
      Option.getOrUndefined(MutableHashMap.get(this.values, provider)) ?? null,
    );
  }
  write(provider: OAuthProvider, credential: StoredCredential) {
    this.writes += 1;
    MutableHashMap.set(this.values, provider, credential);
    return Promise.resolve();
  }
  remove(provider: OAuthProvider) {
    MutableHashMap.remove(this.values, provider);
    return Promise.resolve();
  }
}

it.live(
  "catalog owner cancellation reaches the native HTTP signal without credential writes",
  () => {
    const callerOwner = new AbortController();
    return Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Effect.scope;
        const runNative = Effect.runPromiseWith(yield* Effect.context());
        const runSdk = <A>(program: Effect.Effect<A, Cause.UnknownError>) =>
          runNative(
            Effect.forkIn(Effect.result(program), scope).pipe(Effect.flatMap(Fiber.join)),
          ).then(
            Result.match({
              onSuccess: (value) => value,
              onFailure: (failure) => Promise.reject(failure.cause),
            }),
          );

        const store = new MemoryCredentialStore();
        yield* sdkCall(() =>
          store.write("openai", {
            accessToken: "fixture",
            refreshToken: "fixture",
            expiresAt: DateTime.toEpochMillis(DateTime.nowUnsafe()) + 3600_000,
          }),
        );
        const owner = callerOwner;
        let observed: AbortSignal | null | undefined;
        const starting = yield* Deferred.make<void>();
        const client = createSubscriptionOAuthClient({
          protocol: providerProtocols.openai,
          store,
          fetch: (_url, init) =>
            runSdk(
              Effect.gen(function* () {
                observed = init?.signal;
                yield* Deferred.succeed(starting, undefined);
                return yield* Effect.callback<Response, Cause.UnknownError>((resume) => {
                  const abort = () =>
                    resume(
                      Effect.fail(
                        new Cause.UnknownError(new DOMException("Aborted fixture", "AbortError")),
                      ),
                    );
                  observed?.addEventListener("abort", abort, { once: true });
                  if (observed?.aborted === true) abort();
                  return Effect.sync(() => observed?.removeEventListener("abort", abort));
                });
              }),
            ),
        });
        const outcome = client
          .modelCatalog(owner.signal)
          .catch((failure: OAuthHarnessError) => failure);
        yield* Deferred.await(starting);
        owner.abort();
        expect(observed?.aborted).toBe(true);
        expect(yield* sdkCall(() => outcome)).toMatchObject({
          code: "transport_unavailable",
          operation: "model_catalog",
        });
        expect(store.writes).toBe(1);
      }),
    );
  },
);

it.live.each(["cancel", "timeout"] as const)(
  "%s after callback admission never writes late token results",
  (mode) =>
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Effect.scope;
        const runNative = Effect.runPromiseWith(yield* Effect.context());
        const runSdk = <A>(program: Effect.Effect<A, Cause.UnknownError>) =>
          runNative(
            Effect.forkIn(Effect.result(program), scope).pipe(Effect.flatMap(Fiber.join)),
          ).then(
            Result.match({
              onSuccess: (value) => value,
              onFailure: (failure) => Promise.reject(failure.cause),
            }),
          );

        const store = new MemoryCredentialStore();
        const previous = {
          accessToken: "previous",
          refreshToken: "previous-refresh",
          expiresAt: DateTime.toEpochMillis(DateTime.nowUnsafe()) + 3600_000,
        };
        yield* sdkCall(() => store.write("openai", previous));
        const gate = yield* Deferred.make<void>();
        const exchanging = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() => Deferred.succeed(gate, undefined));
        const client = createSubscriptionOAuthClient({
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
        const login = yield* sdkCall(() =>
          client.startLogin({ timeoutMs: mode === "timeout" ? 100 : 5000 }),
        );
        const completed = login.completed.catch((error: OAuthHarnessError) => error);
        const authorize = new URL(login.authorizationUrl);
        const callback = new URL(authorize.searchParams.get("redirect_uri")!);
        callback.searchParams.set("code", "accepted-code");
        callback.searchParams.set("state", authorize.searchParams.get("state")!);
        const response = yield* Effect.forkChild(
          (yield* testHttpClient()).get(callback.toString()),
          { startImmediately: true },
        );
        try {
          yield* Deferred.await(exchanging);
          if (mode === "cancel") login.cancel();
          else yield* Effect.sleep("150 millis");
          yield* Deferred.succeed(gate, undefined);
          const rejected = yield* Fiber.join(response);
          expect(rejected.status).toBe(410);
          yield* rejected.text;
          expect(yield* sdkCall(() => completed)).toMatchObject({
            code: mode === "cancel" ? "cancelled" : "callback_timeout",
          });
          expect(yield* sdkCall(() => store.read("openai"))).toEqual(previous);
          expect(store.writes).toBe(1);
        } finally {
          yield* Deferred.succeed(gate, undefined);
          login.cancel();
          yield* Fiber.join(response).pipe(
            Effect.flatMap((result) => result.text),
            Effect.orElseSucceed(() => ""),
          );
          yield* sdkCall(() => completed);
        }
      }),
    ),
);

const sdkCall = <A>(call: () => A | PromiseLike<A>) =>
  Effect.tryPromise(() => Promise.resolve(call()));
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
  let tokenRequests = 0;
  let refreshRequests = 0;
  let modelRequests = 0;
  let catalogRequests = 0;
  let forceUnauthorized = false;
  let rejectRefresh = false;
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
        tokenRequests += 1;
        const raw = yield* request.text;
        tokenBodies.push(raw);
        const isRefresh =
          request.headers["content-type"] === "application/json"
            ? raw.includes('"grant_type":"refresh_token"')
            : new URLSearchParams(raw).get("grant_type") === "refresh_token";
        if (isRefresh) refreshRequests += 1;
        if (isRefresh && rejectRefresh) return HttpServerResponse.empty({ status: 401 });
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
        catalogRequests += 1;
        catalogHeaders.push(request.headers);
        catalogUrls.push(url.toString());
        if (forceUnauthorized && request.headers.authorization === "Bearer access-secret-1")
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
        modelRequests += 1;
        modelHeaders.push(request.headers);
        modelBodies.push(yield* request.text);
        if (forceUnauthorized && request.headers.authorization === "Bearer access-secret-1")
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
    counts: () => ({ tokenRequests, refreshRequests, modelRequests, catalogRequests }),
    requireRefresh: () => {
      forceUnauthorized = true;
    },
    rejectRefresh: () => {
      rejectRefresh = true;
    },
  };
});

const login = Effect.fn("loginOAuthFixture")(function* (harness: OAuthValidationHarness) {
  const attempt = yield* sdkCall(() => harness.startLogin({ timeoutMs: 1_000 }));
  const browser = yield* (yield* testHttpClient()).get(String(attempt.authorizationUrl));
  expect(browser.status).toBe(200);
  return yield* sdkCall(() => attempt.completed);
});

test("identifies the provider, operation and HTTP status without exposing response data", () => {
  const error = new OAuthHarnessError("provider_rejected", 429, {
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
      const harness = OAuthValidationHarness({
        protocol: fake.protocol,
        store: new MemoryCredentialStore(),
      });
      const attempt = yield* sdkCall(() => harness.startLogin({ timeoutMs: 1_000 }));
      const completion = expect(attempt.completed).rejects.toMatchObject({
        code: "provider_rejected",
        operation: "login_callback",
        providerCode: "access_denied",
      });
      const authorize = new URL(attempt.authorizationUrl);
      const callback = new URL(authorize.searchParams.get("redirect_uri")!);
      callback.searchParams.set("state", authorize.searchParams.get("state")!);
      callback.searchParams.set("error", "access_denied");
      callback.searchParams.set("error_description", "secret-from-browser");
      expect((yield* (yield* testHttpClient()).get(String(callback))).status).toBe(400);
      yield* sdkCall(() => completion);
    }),
  ),
);

it.live("reports credential write failure without blaming the provider or exposing tokens", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const runNative = Effect.runPromiseWith(yield* Effect.context());
      const runSdk = <A>(program: Effect.Effect<A, Cause.UnknownError>) =>
        runNative(
          Effect.forkIn(Effect.result(program), scope).pipe(Effect.flatMap(Fiber.join)),
        ).then(
          Result.match({
            onSuccess: (value) => value,
            onFailure: (failure) => Promise.reject(failure.cause),
          }),
        );

      const fake = yield* fakeProvider("openai");
      const store: CredentialStore = {
        read: () => Promise.resolve(null),
        write: () =>
          runSdk(
            Effect.fail(
              new Cause.UnknownError(
                new OAuthHarnessError("credential_store_unavailable", null, {
                  provider: "openai",
                  operation: "credential_store",
                  credentialStage: "write",
                  reason: "private-native-error",
                }),
              ),
            ),
          ),
        remove: () => Promise.resolve(),
      };
      const harness = OAuthValidationHarness({ protocol: fake.protocol, store });
      const attempt = yield* sdkCall(() => harness.startLogin({ timeoutMs: 1_000 }));
      const completion = expect(attempt.completed).rejects.toMatchObject({
        code: "credential_store_unavailable",
        operation: "credential_store",
        credentialStage: "write",
      });
      const browser = yield* (yield* testHttpClient()).get(String(attempt.authorizationUrl));
      expect(browser.status).toBe(502);
      const text = yield* browser.text;
      expect(text).toContain("credential store is unavailable");
      expect(text).not.toContain("private-native-error");
      expect(text).not.toContain("access-secret");
      yield* sdkCall(() => completion);
    }),
  ),
);

it.live("classifies token exchange transport failures without exposing native error text", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const runNative = Effect.runPromiseWith(yield* Effect.context());
      const runSdk = <A>(program: Effect.Effect<A, Cause.UnknownError>) =>
        runNative(
          Effect.forkIn(Effect.result(program), scope).pipe(Effect.flatMap(Fiber.join)),
        ).then(
          Result.match({
            onSuccess: (value) => value,
            onFailure: (failure) => Promise.reject(failure.cause),
          }),
        );

      const fake = yield* fakeProvider("openai");
      const harness = OAuthValidationHarness({
        protocol: fake.protocol,
        store: new MemoryCredentialStore(),
        fetch: () =>
          runSdk(
            Effect.fail(
              new Cause.UnknownError(
                new TypeError("private network detail", {
                  cause: Object.assign(new Error("private host detail"), { code: "ENETUNREACH" }),
                }),
              ),
            ),
          ),
      });
      const attempt = yield* sdkCall(() => harness.startLogin({ timeoutMs: 1_000 }));
      const completion = attempt.completed.catch((error: OAuthHarnessError) => error);
      expect((yield* (yield* testHttpClient()).get(String(attempt.authorizationUrl))).status).toBe(
        502,
      );
      const failure = yield* sdkCall(() => completion);
      expect(failure).toMatchObject({
        code: "transport_unavailable",
        operation: "token_exchange",
        transportCode: "ENETUNREACH",
      });
      expect(jsonStringify(failure)).not.toContain("private network detail");
      expect(jsonStringify(failure)).not.toContain("private host detail");
    }),
  ),
);

it.live("retries an OpenAI pre-connect timeout once on a scoped proxy route", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const runNative = Effect.runPromiseWith(yield* Effect.context());
      const runSdk = <A>(program: Effect.Effect<A, Cause.UnknownError>) =>
        runNative(
          Effect.forkIn(Effect.result(program), scope).pipe(Effect.flatMap(Fiber.join)),
        ).then(
          Result.match({
            onSuccess: (value) => value,
            onFailure: (failure) => Promise.reject(failure.cause),
          }),
        );

      const fake = yield* fakeProvider("openai");
      let proxyCalls = 0;
      const harness = OAuthValidationHarness({
        protocol: fake.protocol,
        store: new MemoryCredentialStore(),
        fetch: () =>
          runSdk(
            Effect.fail(
              new Cause.UnknownError(
                new TypeError("fetch failed", {
                  cause: Object.assign(new Error("connect timeout"), {
                    code: "UND_ERR_CONNECT_TIMEOUT",
                  }),
                }),
              ),
            ),
          ),
        tokenProxyFetch: (url, body, contentType) =>
          runSdk(
            Effect.gen(function* () {
              proxyCalls += 1;
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
          ),
      });
      expect(yield* login(harness)).toMatchObject({ provider: "openai", connected: true });
      expect(proxyCalls).toBe(1);
      expect(fake.counts().tokenRequests).toBe(1);
    }),
  ),
);

for (const route of ["direct", "unavailable", "attempted"] as const) {
  it.live(`reports proxy route ${route} without exposing the proxy address`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Effect.scope;
        const runNative = Effect.runPromiseWith(yield* Effect.context());
        const runSdk = <A>(program: Effect.Effect<A, Cause.UnknownError>) =>
          runNative(
            Effect.forkIn(Effect.result(program), scope).pipe(Effect.flatMap(Fiber.join)),
          ).then(
            Result.match({
              onSuccess: (value) => value,
              onFailure: (failure) => Promise.reject(failure.cause),
            }),
          );

        const fake = yield* fakeProvider("openai");
        const harness = OAuthValidationHarness({
          protocol: fake.protocol,
          store: new MemoryCredentialStore(),
          fetch: () =>
            runSdk(
              Effect.fail(
                new Cause.UnknownError(
                  new TypeError("fetch failed", {
                    cause: Object.assign(new Error("connect timeout"), {
                      code: "UND_ERR_CONNECT_TIMEOUT",
                    }),
                  }),
                ),
              ),
            ),
          tokenProxyFetch: () =>
            runSdk(
              Effect.gen(function* () {
                if (route === "attempted")
                  return yield* new Cause.UnknownError(
                    new TypeError("http://private-proxy.example", {
                      cause: Object.assign(new Error("connect timeout"), {
                        code: "UND_ERR_CONNECT_TIMEOUT",
                      }),
                    }),
                  );
                return { route, response: null };
              }),
            ),
        });
        const attempt = yield* sdkCall(() => harness.startLogin({ timeoutMs: 1_000 }));
        const completion = attempt.completed.catch((error: OAuthHarnessError) => error);
        expect(
          (yield* (yield* testHttpClient()).get(String(attempt.authorizationUrl))).status,
        ).toBe(502);
        const failure = yield* sdkCall(() => completion);
        expect(failure).toMatchObject({
          code: "transport_unavailable",
          transportCode: "UND_ERR_CONNECT_TIMEOUT",
          proxyRoute: route,
        });
        expect(jsonStringify(failure)).not.toContain("private-proxy.example");
      }),
    ),
  );
}

it.live("does not replay an authorization code after a non-connect failure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const runNative = Effect.runPromiseWith(yield* Effect.context());
      const runSdk = <A>(program: Effect.Effect<A, Cause.UnknownError>) =>
        runNative(
          Effect.forkIn(Effect.result(program), scope).pipe(Effect.flatMap(Fiber.join)),
        ).then(
          Result.match({
            onSuccess: (value) => value,
            onFailure: (failure) => Promise.reject(failure.cause),
          }),
        );

      const fake = yield* fakeProvider("openai");
      let proxyCalls = 0;
      const harness = OAuthValidationHarness({
        protocol: fake.protocol,
        store: new MemoryCredentialStore(),
        fetch: () =>
          runSdk(
            Effect.fail(new Cause.UnknownError(new DOMException("timed out", "TimeoutError"))),
          ),
        tokenProxyFetch: () =>
          runSdk(
            Effect.sync(() => {
              proxyCalls += 1;
              return { route: "unavailable" as const, response: null };
            }),
          ),
      });
      const attempt = yield* sdkCall(() => harness.startLogin({ timeoutMs: 1_000 }));
      const completion = expect(attempt.completed).rejects.toMatchObject({
        code: "transport_unavailable",
        transportCode: "timeout",
      });
      expect((yield* (yield* testHttpClient()).get(String(attempt.authorizationUrl))).status).toBe(
        502,
      );
      yield* sdkCall(() => completion);
      expect(proxyCalls).toBe(0);
    }),
  ),
);

it.live("exposes only a validated provider error code from a failed token exchange", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const runNative = Effect.runPromiseWith(yield* Effect.context());
      const runSdk = <A>(program: Effect.Effect<A, Cause.UnknownError>) =>
        runNative(
          Effect.forkIn(Effect.result(program), scope).pipe(Effect.flatMap(Fiber.join)),
        ).then(
          Result.match({
            onSuccess: (value) => value,
            onFailure: (failure) => Promise.reject(failure.cause),
          }),
        );

      const fake = yield* fakeProvider("openai");
      const harness = OAuthValidationHarness({
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
      const attempt = yield* sdkCall(() => harness.startLogin({ timeoutMs: 1_000 }));
      const completion = expect(attempt.completed).rejects.toMatchObject({
        code: "provider_rejected",
        operation: "token_exchange",
        status: 403,
        providerCode: "access_denied",
      });
      expect((yield* (yield* testHttpClient()).get(String(attempt.authorizationUrl))).status).toBe(
        502,
      );
      yield* sdkCall(() => completion);
    }),
  ),
);

for (const provider of ["openai", "anthropic"] as const) {
  describe(`${provider} OAuth validation harness`, () => {
    it.live("uses PKCE/state, exchanges the callback internally, and exposes only status", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fake = yield* fakeProvider(provider);
          const store = new MemoryCredentialStore();
          const harness = OAuthValidationHarness({ protocol: fake.protocol, store });
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
          expect(yield* sdkCall(() => harness.disconnect())).toEqual({
            provider,
            connected: false,
            expiresAt: null,
          });
        }),
      ),
    );

    it.live("streams text and one tool call with provider headers", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fake = yield* fakeProvider(provider);
          const harness = OAuthValidationHarness({
            protocol: fake.protocol,
            store: new MemoryCredentialStore(),
          });
          yield* login(harness);

          const events = yield* Stream.runCollect(
            Stream.fromAsyncIterable(
              harness.stream('{"model":"test","stream":true}'),
              (cause) => new Cause.UnknownError(cause),
            ),
          );

          expect(events).toEqual(
            provider === "openai"
              ? [
                  { type: "text", text: "hello" },
                  {
                    type: "tool-call",
                    id: "call-1",
                    name: "lookup",
                    arguments: { q: "x" },
                  },
                ]
              : [
                  { type: "text", text: "hello" },
                  {
                    type: "tool-call-start",
                    index: 1,
                    id: "call-1",
                    name: "lookup",
                  },
                  {
                    type: "tool-call-arguments",
                    index: 1,
                    delta: '{"q":"x"}',
                  },
                  { type: "content-block-end", index: 1 },
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
            expect(fake.modelHeaders[0]?.["anthropic-dangerous-direct-browser-access"]).toBe(
              "true",
            );
            expect(fake.modelBodies[0]).toContain("x-anthropic-billing-header");
            expect(fake.modelBodies[0]).toContain("Claude Agent SDK");
            expect(fake.modelBodies[0]).toContain('\\"account_uuid\\":\\"unknown-account\\"');
            expect(fake.modelBodies[0]).toContain('"metadata":{"user_id":');
            expect(fake.modelBodies[0]).not.toContain("access-secret");
          }
        }),
      ),
    );

    it.live("fetches the fixed catalog, paginates, and returns no credentials", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fake = yield* fakeProvider(provider);
          const harness = OAuthValidationHarness({
            protocol: fake.protocol,
            store: new MemoryCredentialStore(),
          });
          yield* login(harness);
          const pages = yield* sdkCall(() => harness.modelCatalog());

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
      ),
    );

    it.live("refreshes once when the fixed catalog rejects the current token", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fake = yield* fakeProvider(provider);
          const harness = OAuthValidationHarness({
            protocol: fake.protocol,
            store: new MemoryCredentialStore(),
          });
          yield* login(harness);
          fake.requireRefresh();
          yield* sdkCall(() => harness.modelCatalog());

          expect(fake.counts().refreshRequests).toBe(1);
          expect(fake.catalogHeaders.at(-1)?.authorization).toBe("Bearer access-secret-2");
        }),
      ),
    );

    it.live("rotates refresh tokens once for concurrent 401/403 retries", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fake = yield* fakeProvider(provider);
          const store = new MemoryCredentialStore();
          const harness = OAuthValidationHarness({ protocol: fake.protocol, store });
          yield* login(harness);
          fake.requireRefresh();

          const collect = Effect.fn("collectOAuthStream")(function* () {
            const events = yield* Stream.runCollect(
              Stream.fromAsyncIterable(
                harness.stream('{"stream":true}'),
                (cause) => new Cause.UnknownError(cause),
              ),
            );
            return events;
          });
          const [first, second] = yield* Effect.all([collect(), collect()], {
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
      ),
    );

    it.live("refreshes an expiring credential while checking connection status", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fake = yield* fakeProvider(provider);
          const store = new MemoryCredentialStore();
          const harness = OAuthValidationHarness({ protocol: fake.protocol, store });
          yield* login(harness);
          const credential = Option.getOrUndefined(MutableHashMap.get(store.values, provider))!;
          MutableHashMap.set(store.values, provider, {
            ...credential,
            expiresAt: DateTime.toEpochMillis(DateTime.nowUnsafe()) + 20_000,
          });

          yield* sdkCall(() =>
            expect(harness.status()).resolves.toMatchObject({ provider, connected: true }),
          );
          expect(fake.counts().refreshRequests).toBe(1);
          expect(
            Option.getOrUndefined(MutableHashMap.get(store.values, provider))?.accessToken,
          ).toBe("access-secret-2");
        }),
      ),
    );

    it.live("signs out after the provider permanently rejects an expired credential", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fake = yield* fakeProvider(provider);
          const store = new MemoryCredentialStore();
          const harness = OAuthValidationHarness({ protocol: fake.protocol, store });
          yield* login(harness);
          const credential = Option.getOrUndefined(MutableHashMap.get(store.values, provider))!;
          MutableHashMap.set(store.values, provider, {
            ...credential,
            expiresAt: DateTime.toEpochMillis(DateTime.nowUnsafe()) - 1,
          });
          fake.rejectRefresh();

          yield* sdkCall(() =>
            expect(harness.status()).resolves.toEqual({
              provider,
              connected: false,
              expiresAt: null,
            }),
          );
          expect(fake.counts().refreshRequests).toBe(1);
          expect(MutableHashMap.has(store.values, provider)).toBe(false);
        }),
      ),
    );
  });
}

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
        const scope = yield* Effect.scope;
        const runNative = Effect.runPromiseWith(yield* Effect.context());
        const runSdk = <A>(program: Effect.Effect<A, Cause.UnknownError>) =>
          runNative(
            Effect.forkIn(Effect.result(program), scope).pipe(Effect.flatMap(Fiber.join)),
          ).then(
            Result.match({
              onSuccess: (value) => value,
              onFailure: (failure) => Promise.reject(failure.cause),
            }),
          );

        const store = new MemoryCredentialStore();
        MutableHashMap.set(store.values, "anthropic", {
          accessToken: "access-secret",
          refreshToken: "refresh-secret",
          expiresAt: DateTime.toEpochMillis(DateTime.nowUnsafe()) + 60_000,
        });
        const cacheRejected = OAuthValidationHarness({
          protocol: providerProtocols.anthropic,
          store,
          fetch: () =>
            runSdk(
              sdkCall(
                () =>
                  new Response('{"error":{"message":"cache_control is unsupported"}}', {
                    status: 400,
                  }),
              ),
            ),
        });
        const unrelated = OAuthValidationHarness({
          protocol: providerProtocols.anthropic,
          store,
          fetch: () =>
            runSdk(
              sdkCall(() => new Response('{"error":{"message":"invalid model"}}', { status: 400 })),
            ),
        });
        const drain = Effect.fn("drainOAuthStream")(function* (harness: OAuthValidationHarness) {
          yield* Stream.runDrain(
            Stream.fromAsyncIterable(
              harness.stream('{"model":"test","stream":true}'),
              (cause) => new Cause.UnknownError(cause),
            ),
          );
        });

        expect((yield* Effect.flip(drain(cacheRejected))).cause).toBeInstanceOf(
          ProviderFeatureRejectedError,
        );
        expect((yield* Effect.flip(drain(unrelated))).cause).toMatchObject({
          message:
            "oauth_provider_rejected [provider=Anthropic, operation=model_stream, status=400]: The provider rejected the request. invalid model",
        });
      }),
    ),
  );
});

describe("OAuth callback safety", () => {
  it.live("rejects a mismatched state without including code, state, or tokens in the error", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* fakeProvider("openai");
        const harness = OAuthValidationHarness({
          protocol: fake.protocol,
          store: new MemoryCredentialStore(),
        });
        const attempt = yield* sdkCall(() => harness.startLogin({ timeoutMs: 1_000 }));
        const completion = attempt.completed.catch((error: OAuthHarnessError) => error);
        const authorization = new URL(attempt.authorizationUrl);
        const callback = new URL(authorization.searchParams.get("redirect_uri") ?? "");
        callback.searchParams.set("code", "authorization-code-secret");
        callback.searchParams.set("state", "attacker-state-secret");
        yield* (yield* testHttpClient()).get(String(callback));

        const thrown = yield* sdkCall(() => completion);
        expect(thrown).toBeInstanceOf(OAuthHarnessError);
        const message = thrown instanceof OAuthHarnessError ? String(thrown) : "";
        expect(message).toContain("state_mismatch");
        expect(message).not.toContain("authorization-code-secret");
        expect(message).not.toContain("attacker-state-secret");
      }),
    ),
  );

  it.live("supports timeout and explicit cancellation with sanitized errors", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* fakeProvider("openai");
        const timeoutHarness = OAuthValidationHarness({
          protocol: fake.protocol,
          store: new MemoryCredentialStore(),
        });
        const timed = yield* sdkCall(() => timeoutHarness.startLogin({ timeoutMs: 10 }));
        expect((yield* Effect.flip(sdkCall(() => timed.completed))).cause).toMatchObject({
          code: "callback_timeout",
        });

        const cancelHarness = OAuthValidationHarness({
          protocol: fake.protocol,
          store: new MemoryCredentialStore(),
        });
        const cancelled = yield* sdkCall(() => cancelHarness.startLogin({ timeoutMs: 1_000 }));
        cancelled.cancel();
        expect((yield* Effect.flip(sdkCall(() => cancelled.completed))).cause).toMatchObject({
          code: "cancelled",
        });
      }),
    ),
  );

  it.live(
    "cancelling while a callback writes restores the prior credential, not the cancelled login",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Effect.scope;
          const runNative = Effect.runPromiseWith(yield* Effect.context());
          const runSdk = <A>(program: Effect.Effect<A, Cause.UnknownError>) =>
            runNative(
              Effect.forkIn(Effect.result(program), scope).pipe(Effect.flatMap(Fiber.join)),
            ).then(
              Result.match({
                onSuccess: (value) => value,
                onFailure: (failure) => Promise.reject(failure.cause),
              }),
            );

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
              runSdk(
                Effect.gen(function* () {
                  yield* sdkCall(() => store.write(provider, value));
                  yield* Deferred.succeed(writing, undefined);
                  yield* Deferred.await(held);
                }),
              ),
            remove: (provider) => store.remove(provider),
          };
          const harness = OAuthValidationHarness({ protocol: fake.protocol, store: deferred });
          const attempt = yield* sdkCall(() => harness.startLogin({ timeoutMs: 5_000 }));
          const browser = yield* Effect.forkChild(
            (yield* testHttpClient()).get(attempt.authorizationUrl),
            { startImmediately: true },
          );
          yield* Deferred.await(writing);
          attempt.cancel();
          yield* Deferred.succeed(held, undefined);
          expect((yield* Effect.flip(sdkCall(() => attempt.completed))).cause).toMatchObject({
            code: "cancelled",
          });
          yield* Fiber.join(browser);
          expect(Option.getOrUndefined(MutableHashMap.get(store.values, "anthropic"))).toEqual(
            prior,
          );
        }),
      ),
  );

  test("uses separate OS-keychain namespaces and has no file fallback contract", () => {
    expect(providerKeychainService("openai")).toBe("com.context-agent.oauth.openai");
    expect(providerKeychainService("anthropic")).toBe("com.context-agent.oauth.anthropic");
    expect(providerKeychainService("openai")).not.toBe(providerKeychainService("anthropic"));
  });
});
