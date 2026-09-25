import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
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
  readonly values = new Map<OAuthProvider, StoredCredential>();
  writes = 0;
  async read(provider: OAuthProvider) {
    return this.values.get(provider) ?? null;
  }
  async write(provider: OAuthProvider, credential: StoredCredential) {
    this.writes += 1;
    this.values.set(provider, credential);
  }
  async remove(provider: OAuthProvider) {
    this.values.delete(provider);
  }
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

const body = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
};

async function fakeProvider(provider: OAuthProvider) {
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
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/authorize") {
      authorizations.push(url.search);
      const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
      redirect.searchParams.set("code", "authorization-code-secret");
      redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
      response.writeHead(302, { Location: redirect.toString() }).end();
      return;
    }
    if (url.pathname === "/token") {
      tokenRequests += 1;
      const raw = await body(request);
      tokenBodies.push(raw);
      const isRefresh =
        request.headers["content-type"] === "application/json"
          ? raw.includes('"grant_type":"refresh_token"')
          : new URLSearchParams(raw).get("grant_type") === "refresh_token";
      if (isRefresh) refreshRequests += 1;
      if (isRefresh && rejectRefresh) {
        response.writeHead(401).end();
        return;
      }
      const suffix = isRefresh ? "2" : "1";
      const claims = Buffer.from(
        JSON.stringify({
          "https://api.openai.com/auth": { chatgpt_account_id: "account-internal-1" },
        }),
      ).toString("base64url");
      response.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          access_token: `access-secret-${suffix}`,
          refresh_token: `refresh-secret-${suffix}`,
          id_token: `header.${claims}.signature`,
          expires_in: 3_600,
        }),
      );
      return;
    }
    if (url.pathname === "/catalog") {
      catalogRequests += 1;
      catalogHeaders.push(request.headers);
      catalogUrls.push(url.toString());
      if (forceUnauthorized && request.headers.authorization === "Bearer access-secret-1") {
        response.writeHead(provider === "openai" ? 401 : 403).end();
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      if (provider === "openai") response.end(JSON.stringify({ models: [{ slug: "gpt-test" }] }));
      else if (url.searchParams.get("after_id") === "page-1")
        response.end(JSON.stringify({ data: [{ id: "claude-page-2" }], has_more: false }));
      else
        response.end(
          JSON.stringify({
            data: [{ id: "claude-page-1" }],
            has_more: true,
            last_id: "page-1",
          }),
        );
      return;
    }
    if (url.pathname === "/model") {
      modelRequests += 1;
      modelHeaders.push(request.headers);
      modelBodies.push(await body(request));
      if (forceUnauthorized && request.headers.authorization === "Bearer access-secret-1") {
        response.writeHead(401).end();
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      if (provider === "openai") {
        response.write('data: {"type":"response.output_text.delta","delta":"hello"}\n\n');
        response.write(
          'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call-1","name":"lookup","arguments":"{\\\"q\\\":\\\"x\\\"}"}}\n\n',
        );
      } else {
        response.write(
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n',
        );
        response.write(
          'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call-1","name":"lookup","input":{}}}\n\n',
        );
        response.write(
          `data: ${JSON.stringify({
            type: "content_block_delta",
            index: 1,
            delta: { type: "input_json_delta", partial_json: '{"q":"x"}' },
          })}\n\n`,
        );
        response.write('data: {"type":"content_block_stop","index":1}\n\n');
      }
      response.end("data: [DONE]\n\n");
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  // SAFETY: the fake server was bound to a TCP host/port, never to an IPC pipe.
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
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
}

async function login(harness: OAuthValidationHarness) {
  const attempt = await harness.startLogin({ timeoutMs: 1_000 });
  const browser = await fetch(attempt.authorizationUrl);
  expect(browser.status).toBe(200);
  return attempt.completed;
}

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

test("reports a browser denial without exposing OAuth callback parameters", async () => {
  const fake = await fakeProvider("openai");
  const harness = OAuthValidationHarness({
    protocol: fake.protocol,
    store: new MemoryCredentialStore(),
  });
  const attempt = await harness.startLogin({ timeoutMs: 1_000 });
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
  expect((await fetch(callback)).status).toBe(400);
  await completion;
});

test("reports credential write failure without blaming the provider or exposing tokens", async () => {
  const fake = await fakeProvider("openai");
  const store: CredentialStore = {
    read: async () => null,
    write: async () => {
      throw new OAuthHarnessError("credential_store_unavailable", null, {
        provider: "openai",
        operation: "credential_store",
        credentialStage: "write",
        reason: "private-native-error",
      });
    },
    remove: async () => {},
  };
  const harness = OAuthValidationHarness({ protocol: fake.protocol, store });
  const attempt = await harness.startLogin({ timeoutMs: 1_000 });
  const completion = expect(attempt.completed).rejects.toMatchObject({
    code: "credential_store_unavailable",
    operation: "credential_store",
    credentialStage: "write",
  });
  const browser = await fetch(attempt.authorizationUrl);
  expect(browser.status).toBe(502);
  const text = await browser.text();
  expect(text).toContain("credential store is unavailable");
  expect(text).not.toContain("private-native-error");
  expect(text).not.toContain("access-secret");
  await completion;
});

test("classifies token exchange transport failures without exposing native error text", async () => {
  const fake = await fakeProvider("openai");
  const harness = OAuthValidationHarness({
    protocol: fake.protocol,
    store: new MemoryCredentialStore(),
    fetch: async () => {
      throw new TypeError("private network detail", {
        cause: Object.assign(new Error("private host detail"), { code: "ENETUNREACH" }),
      });
    },
  });
  const attempt = await harness.startLogin({ timeoutMs: 1_000 });
  const completion = attempt.completed.catch((error: OAuthHarnessError) => error);
  expect((await fetch(attempt.authorizationUrl)).status).toBe(502);
  const failure = await completion;
  expect(failure).toMatchObject({
    code: "transport_unavailable",
    operation: "token_exchange",
    transportCode: "ENETUNREACH",
  });
  expect(JSON.stringify(failure)).not.toContain("private network detail");
  expect(JSON.stringify(failure)).not.toContain("private host detail");
});

test("retries an OpenAI pre-connect timeout once on a scoped proxy route", async () => {
  const fake = await fakeProvider("openai");
  let proxyCalls = 0;
  const harness = OAuthValidationHarness({
    protocol: fake.protocol,
    store: new MemoryCredentialStore(),
    fetch: async () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
      });
    },
    tokenProxyFetch: async (url, body, contentType) => {
      proxyCalls += 1;
      expect(url).toBe(fake.protocol.tokenUrl);
      return {
        route: "attempted",
        response: await fetch(url, {
          method: "POST",
          body,
          headers: { "Content-Type": contentType },
        }),
      };
    },
  });
  expect(await login(harness)).toMatchObject({ provider: "openai", connected: true });
  expect(proxyCalls).toBe(1);
  expect(fake.counts().tokenRequests).toBe(1);
});

for (const route of ["direct", "unavailable", "attempted"] as const) {
  test(`reports proxy route ${route} without exposing the proxy address`, async () => {
    const fake = await fakeProvider("openai");
    const harness = OAuthValidationHarness({
      protocol: fake.protocol,
      store: new MemoryCredentialStore(),
      fetch: async () => {
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("connect timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
        });
      },
      tokenProxyFetch: async () => {
        if (route === "attempted")
          throw new TypeError("http://private-proxy.example", {
            cause: Object.assign(new Error("connect timeout"), {
              code: "UND_ERR_CONNECT_TIMEOUT",
            }),
          });
        return { route, response: null };
      },
    });
    const attempt = await harness.startLogin({ timeoutMs: 1_000 });
    const completion = attempt.completed.catch((error: OAuthHarnessError) => error);
    expect((await fetch(attempt.authorizationUrl)).status).toBe(502);
    const failure = await completion;
    expect(failure).toMatchObject({
      code: "transport_unavailable",
      transportCode: "UND_ERR_CONNECT_TIMEOUT",
      proxyRoute: route,
    });
    expect(JSON.stringify(failure)).not.toContain("private-proxy.example");
  });
}

test("does not replay an authorization code after a non-connect failure", async () => {
  const fake = await fakeProvider("openai");
  let proxyCalls = 0;
  const harness = OAuthValidationHarness({
    protocol: fake.protocol,
    store: new MemoryCredentialStore(),
    fetch: async () => {
      throw new DOMException("timed out", "TimeoutError");
    },
    tokenProxyFetch: async () => {
      proxyCalls += 1;
      return { route: "unavailable", response: null };
    },
  });
  const attempt = await harness.startLogin({ timeoutMs: 1_000 });
  const completion = expect(attempt.completed).rejects.toMatchObject({
    code: "transport_unavailable",
    transportCode: "timeout",
  });
  expect((await fetch(attempt.authorizationUrl)).status).toBe(502);
  await completion;
  expect(proxyCalls).toBe(0);
});

test("exposes only a validated provider error code from a failed token exchange", async () => {
  const fake = await fakeProvider("openai");
  const harness = OAuthValidationHarness({
    protocol: fake.protocol,
    store: new MemoryCredentialStore(),
    fetch: async (input, init) =>
      input === fake.protocol.tokenUrl
        ? new Response(
            JSON.stringify({
              error: { code: "access_denied", message: "private-user-data" },
              access_token: "secret-token",
            }),
            { status: 403 },
          )
        : fetch(input, init),
  });
  const attempt = await harness.startLogin({ timeoutMs: 1_000 });
  const completion = expect(attempt.completed).rejects.toMatchObject({
    code: "provider_rejected",
    operation: "token_exchange",
    status: 403,
    providerCode: "access_denied",
  });
  expect((await fetch(attempt.authorizationUrl)).status).toBe(502);
  await completion;
});

for (const provider of ["openai", "anthropic"] as const) {
  describe(`${provider} OAuth validation harness`, () => {
    test("uses PKCE/state, exchanges the callback internally, and exposes only status", async () => {
      const fake = await fakeProvider(provider);
      const store = new MemoryCredentialStore();
      const harness = OAuthValidationHarness({ protocol: fake.protocol, store });
      const status = await login(harness);

      expect(status).toMatchObject({ provider, connected: true });
      expect(JSON.stringify(status)).not.toContain("secret");
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
      expect(await harness.disconnect()).toEqual({ provider, connected: false, expiresAt: null });
    });

    test("streams text and one tool call with provider headers", async () => {
      const fake = await fakeProvider(provider);
      const harness = OAuthValidationHarness({
        protocol: fake.protocol,
        store: new MemoryCredentialStore(),
      });
      await login(harness);
      const events = [];
      for await (const event of harness.stream('{"model":"test","stream":true}'))
        events.push(event);

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
        expect(fake.modelHeaders[0]?.["anthropic-dangerous-direct-browser-access"]).toBe("true");
        expect(fake.modelBodies[0]).toContain("x-anthropic-billing-header");
        expect(fake.modelBodies[0]).toContain("Claude Agent SDK");
        expect(fake.modelBodies[0]).toContain('\\"account_uuid\\":\\"unknown-account\\"');
        expect(fake.modelBodies[0]).toContain('"metadata":{"user_id":');
        expect(fake.modelBodies[0]).not.toContain("access-secret");
      }
    });

    test("fetches the fixed catalog, paginates, and returns no credentials", async () => {
      const fake = await fakeProvider(provider);
      const harness = OAuthValidationHarness({
        protocol: fake.protocol,
        store: new MemoryCredentialStore(),
      });
      await login(harness);
      const pages = await harness.modelCatalog();

      expect(pages).toHaveLength(provider === "anthropic" ? 2 : 1);
      expect(JSON.stringify(pages)).not.toContain("secret");
      expect(fake.catalogHeaders[0]?.authorization).toBe("Bearer access-secret-1");
      expect(fake.catalogHeaders[0]?.accept).toBe("application/json");
      expect(fake.catalogHeaders[0]?.["content-type"]).toBeUndefined();
      if (provider === "anthropic") {
        expect(fake.catalogUrls[0]).toContain("limit=1000");
        expect(fake.catalogUrls[1]).toContain("after_id=page-1");
      }
    });

    test("refreshes once when the fixed catalog rejects the current token", async () => {
      const fake = await fakeProvider(provider);
      const harness = OAuthValidationHarness({
        protocol: fake.protocol,
        store: new MemoryCredentialStore(),
      });
      await login(harness);
      fake.requireRefresh();
      await harness.modelCatalog();

      expect(fake.counts().refreshRequests).toBe(1);
      expect(fake.catalogHeaders.at(-1)?.authorization).toBe("Bearer access-secret-2");
    });

    test("rotates refresh tokens once for concurrent 401/403 retries", async () => {
      const fake = await fakeProvider(provider);
      const store = new MemoryCredentialStore();
      const harness = OAuthValidationHarness({ protocol: fake.protocol, store });
      await login(harness);
      fake.requireRefresh();

      const collect = async () => {
        const events = [];
        for await (const event of harness.stream('{"stream":true}')) events.push(event);
        return events;
      };
      const [first, second] = await Promise.all([collect(), collect()]);

      expect(first).toHaveLength(provider === "openai" ? 2 : 4);
      expect(second).toHaveLength(provider === "openai" ? 2 : 4);
      expect(fake.counts().refreshRequests).toBe(1);
      expect(store.values.get(provider)?.refreshToken).toBe("refresh-secret-2");
      expect(fake.modelHeaders.at(-1)?.authorization).toBe("Bearer access-secret-2");
    });

    test("refreshes an expiring credential while checking connection status", async () => {
      const fake = await fakeProvider(provider);
      const store = new MemoryCredentialStore();
      const harness = OAuthValidationHarness({ protocol: fake.protocol, store });
      await login(harness);
      const credential = store.values.get(provider)!;
      store.values.set(provider, { ...credential, expiresAt: Date.now() + 20_000 });

      await expect(harness.status()).resolves.toMatchObject({ provider, connected: true });
      expect(fake.counts().refreshRequests).toBe(1);
      expect(store.values.get(provider)?.accessToken).toBe("access-secret-2");
    });

    test("signs out after the provider permanently rejects an expired credential", async () => {
      const fake = await fakeProvider(provider);
      const store = new MemoryCredentialStore();
      const harness = OAuthValidationHarness({ protocol: fake.protocol, store });
      await login(harness);
      const credential = store.values.get(provider)!;
      store.values.set(provider, { ...credential, expiresAt: Date.now() - 1 });
      fake.rejectRefresh();

      await expect(harness.status()).resolves.toEqual({
        provider,
        connected: false,
        expiresAt: null,
      });
      expect(fake.counts().refreshRequests).toBe(1);
      expect(store.values.has(provider)).toBe(false);
    });
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

  test("classifies only Anthropic cache-feature HTTP rejection for safe fallback", async () => {
    const store = new MemoryCredentialStore();
    store.values.set("anthropic", {
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      expiresAt: Date.now() + 60_000,
    });
    const cacheRejected = OAuthValidationHarness({
      protocol: providerProtocols.anthropic,
      store,
      fetch: async () =>
        new Response('{"error":{"message":"cache_control is unsupported"}}', { status: 400 }),
    });
    const unrelated = OAuthValidationHarness({
      protocol: providerProtocols.anthropic,
      store,
      fetch: async () => new Response('{"error":{"message":"invalid model"}}', { status: 400 }),
    });
    const drain = async (harness: OAuthValidationHarness) => {
      for await (const _event of harness.stream('{"model":"test","stream":true}')) {
        // Drain the deterministic mock response.
      }
    };

    await expect(drain(cacheRejected)).rejects.toBeInstanceOf(ProviderFeatureRejectedError);
    await expect(drain(unrelated)).rejects.toMatchObject({
      message:
        "oauth_provider_rejected [provider=Anthropic, operation=model_stream, status=400]: The provider rejected the request. invalid model",
    });
  });
});

describe("OAuth callback safety", () => {
  test("rejects a mismatched state without including code, state, or tokens in the error", async () => {
    const fake = await fakeProvider("openai");
    const harness = OAuthValidationHarness({
      protocol: fake.protocol,
      store: new MemoryCredentialStore(),
    });
    const attempt = await harness.startLogin({ timeoutMs: 1_000 });
    const authorization = new URL(attempt.authorizationUrl);
    const callback = new URL(authorization.searchParams.get("redirect_uri") ?? "");
    callback.searchParams.set("code", "authorization-code-secret");
    callback.searchParams.set("state", "attacker-state-secret");
    await fetch(callback);

    let thrown: OAuthHarnessError | null = null;
    try {
      await attempt.completed;
    } catch (error) {
      if (error instanceof OAuthHarnessError) thrown = error;
    }
    expect(thrown).toBeInstanceOf(OAuthHarnessError);
    expect(String(thrown)).toContain("state_mismatch");
    expect(String(thrown)).not.toContain("authorization-code-secret");
    expect(String(thrown)).not.toContain("attacker-state-secret");
  });

  test("supports timeout and explicit cancellation with sanitized errors", async () => {
    const fake = await fakeProvider("openai");
    const timeoutHarness = OAuthValidationHarness({
      protocol: fake.protocol,
      store: new MemoryCredentialStore(),
    });
    const timed = await timeoutHarness.startLogin({ timeoutMs: 10 });
    await expect(timed.completed).rejects.toMatchObject({ code: "callback_timeout" });

    const cancelHarness = OAuthValidationHarness({
      protocol: fake.protocol,
      store: new MemoryCredentialStore(),
    });
    const cancelled = await cancelHarness.startLogin({ timeoutMs: 1_000 });
    cancelled.cancel();
    await expect(cancelled.completed).rejects.toMatchObject({ code: "cancelled" });
  });

  test("uses separate OS-keychain namespaces and has no file fallback contract", () => {
    expect(providerKeychainService("openai")).toBe("com.context-agent.oauth.openai");
    expect(providerKeychainService("anthropic")).toBe("com.context-agent.oauth.anthropic");
    expect(providerKeychainService("openai")).not.toBe(providerKeychainService("anthropic"));
  });
});
