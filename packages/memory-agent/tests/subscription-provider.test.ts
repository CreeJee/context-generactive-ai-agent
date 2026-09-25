import { Effect } from "effect";
import { describe, expect, test } from "vite-plus/test";
import type { Settings } from "../src/config/global-config.ts";
import {
  OAuthHarnessError,
  type LoginAttempt,
  type OAuthConnectionStatus,
} from "../src/oauth/validation-harness.ts";
import { providerProtocols } from "../src/oauth/protocol.ts";
import {
  createSubscriptionProvider,
  parseSubscriptionCatalog,
} from "../src/providers/subscription-provider.ts";

const settingsStore = () => {
  let settings: Settings = {};
  return {
    get value() {
      return settings;
    },
    read: Effect.sync(() => settings),
    update: (patch: Partial<Settings>) =>
      Effect.sync(() => {
        settings = { ...settings, ...patch };
        return settings;
      }),
  };
};

const fakeClient = (provider: "openai" | "anthropic", pages: ReadonlyArray<unknown>) => {
  let connected = false;
  let cancelled = false;
  let catalogRequests = 0;
  let finish!: (status: OAuthConnectionStatus) => void;
  const completed = new Promise<OAuthConnectionStatus>((resolve) => {
    finish = resolve;
  });
  const attempt: LoginAttempt = {
    provider,
    authorizationUrl: `https://example.test/${provider}/authorize`,
    completed,
    cancel: () => {
      cancelled = true;
    },
  };
  return {
    client: {
      status: async () => ({ provider, connected, expiresAt: null }),
      startLogin: async () => attempt,
      disconnect: async () => {
        connected = false;
        return { provider, connected, expiresAt: null };
      },
      modelCatalog: async () => {
        catalogRequests += 1;
        return pages;
      },
    },
    complete: () => {
      connected = true;
      finish({ provider, connected: true, expiresAt: Date.now() + 60_000 });
    },
    get cancelled() {
      return cancelled;
    },
    get catalogRequests() {
      return catalogRequests;
    },
  };
};

describe("subscription provider product services", () => {
  test("parses OpenAI catalog metadata without exposing transport fields", () => {
    const models = parseSubscriptionCatalog("openai", [
      {
        models: [
          {
            slug: "gpt-6-astra",
            display_name: "GPT-6 Astra",
            default_reasoning_level: "high",
            supported_reasoning_levels: ["low", { reasoning_effort: "high" }, { value: "xhigh" }],
            input_modalities: ["text", "image"],
            context_window: 400_000,
          },
        ],
      },
    ]);

    expect(models).toEqual([
      {
        provider: "openai",
        id: "gpt-6-astra",
        displayName: "GPT-6 Astra",
        isDefault: true,
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: ["low", "high", "xhigh"],
        capabilities: {
          inputModalities: ["text", "image"],
          toolCalling: true,
          reasoning: true,
        },
      },
    ]);
    expect(JSON.stringify(models)).not.toContain("context_window");
    expect(JSON.stringify(models)).not.toContain("Authorization");
  });

  test("merges Anthropic pages, removes duplicates, and derives reasoning capabilities", () => {
    const models = parseSubscriptionCatalog("anthropic", [
      {
        data: [
          { id: "claude-opus-5", display_name: "Claude Opus 5" },
          { id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5" },
        ],
      },
      {
        data: [
          { id: "claude-opus-5", display_name: "duplicate" },
          { id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" },
        ],
      },
    ]);

    expect(models.map((model) => model.id)).toEqual([
      "claude-opus-5",
      "claude-haiku-4-5",
      "claude-sonnet-4-6",
    ]);
    expect(models[0]?.supportedReasoningEfforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(models[1]?.supportedReasoningEfforts).toEqual(["none"]);
    expect(models[2]?.supportedReasoningEfforts).toEqual(["low", "medium", "high", "max"]);
  });

  test("uses installed Anthropic metadata without requesting the API-key-only model endpoint", async () => {
    const fake = fakeClient("anthropic", []);
    const provider = createSubscriptionProvider({
      protocol: providerProtocols.anthropic,
      config: settingsStore(),
      client: fake.client,
    });

    const models = await Effect.runPromise(provider.models.list);

    expect(models.map((model) => model.id)).toContain("claude-sonnet-4-6");
    expect(models.map((model) => model.id)).toContain("claude-opus-5");
    expect(fake.catalogRequests).toBe(0);
  });

  test("returns pending immediately and keeps credentials out of the auth contract", async () => {
    const fake = fakeClient("anthropic", []);
    const provider = createSubscriptionProvider({
      protocol: providerProtocols.anthropic,
      config: settingsStore(),
      client: fake.client,
    });

    expect(await Effect.runPromise(provider.auth.connect)).toEqual({
      provider: "anthropic",
      status: "pending",
      authorizationUrl: "https://example.test/anthropic/authorize",
    });
    expect("token" in provider.auth).toBe(false);
    expect("credential" in provider.auth).toBe(false);

    fake.complete();
    await Promise.resolve();
    expect(await Effect.runPromise(provider.auth.status)).toEqual({
      provider: "anthropic",
      status: "signed-in",
    });
  });

  test("reports safe login diagnostics and does not surface raw provider text", async () => {
    let rejectLogin!: (error: OAuthHarnessError) => void;
    const completed = new Promise<OAuthConnectionStatus>((_resolve, reject) => {
      rejectLogin = reject;
    });
    const client = {
      status: async () => ({ provider: "openai" as const, connected: false, expiresAt: null }),
      startLogin: async (): Promise<LoginAttempt> => ({
        provider: "openai",
        authorizationUrl: "https://example.test/authorize",
        completed,
        cancel: () => {},
      }),
      disconnect: async () => ({ provider: "openai" as const, connected: false, expiresAt: null }),
      modelCatalog: async () => [],
    };
    const provider = createSubscriptionProvider({
      protocol: providerProtocols.openai,
      config: settingsStore(),
      client,
    });
    expect((await Effect.runPromise(provider.auth.connect)).status).toBe("pending");
    rejectLogin(
      new OAuthHarnessError("provider_rejected", 403, {
        provider: "openai",
        operation: "token_exchange",
        providerCode: "access_denied",
        reason: "secret-from-provider",
      }),
    );
    await Promise.resolve();
    const state = await Effect.runPromise(provider.auth.status);
    expect(state).toMatchObject({
      provider: "openai",
      status: "error",
      code: "provider_rejected",
      operation: "token_exchange",
      httpStatus: 403,
      providerCode: "access_denied",
    });
    expect(JSON.stringify(state)).not.toContain("secret-from-provider");
  });

  test("shows a safe credential-store stage even when status reads also fail", async () => {
    let rejectLogin!: (error: OAuthHarnessError) => void;
    const completed = new Promise<OAuthConnectionStatus>((_resolve, reject) => {
      rejectLogin = reject;
    });
    const provider = createSubscriptionProvider({
      protocol: providerProtocols.openai,
      config: settingsStore(),
      client: {
        status: async () => {
          throw new OAuthHarnessError("credential_store_unavailable", null, {
            provider: "openai",
            operation: "credential_store",
            credentialStage: "read",
          });
        },
        startLogin: async (): Promise<LoginAttempt> => ({
          provider: "openai",
          authorizationUrl: "https://example.test/authorize",
          completed,
          cancel: () => {},
        }),
        disconnect: async () => ({ provider: "openai", connected: false, expiresAt: null }),
        modelCatalog: async () => [],
      },
    });
    expect(await Effect.runPromise(provider.auth.status)).toMatchObject({
      status: "error",
      credentialStage: "read",
    });
    expect((await Effect.runPromise(provider.auth.connect)).status).toBe("pending");
    rejectLogin(
      new OAuthHarnessError("credential_store_unavailable", null, {
        provider: "openai",
        operation: "credential_store",
        credentialStage: "write",
      }),
    );
    await Promise.resolve();
    expect(await Effect.runPromise(provider.auth.status)).toMatchObject({
      status: "error",
      code: "credential_store_unavailable",
      credentialStage: "write",
    });
  });

  test("cancels an in-flight login and validates provider/model/effort together", async () => {
    const config = settingsStore();
    const fake = fakeClient("openai", [
      {
        models: [
          {
            slug: "gpt-6-astra",
            supported_reasoning_levels: ["low", "high"],
            default_reasoning_level: "high",
          },
        ],
      },
    ]);
    const provider = createSubscriptionProvider({
      protocol: providerProtocols.openai,
      config,
      client: fake.client,
    });

    await Effect.runPromise(provider.auth.connect);
    expect(await Effect.runPromise(provider.auth.cancel)).toEqual({
      provider: "openai",
      status: "signed-out",
    });
    expect(fake.cancelled).toBe(true);

    expect(await Effect.runPromise(provider.models.select("gpt-6-astra"))).toEqual({
      provider: "openai",
      model: "gpt-6-astra",
      reasoningEffort: "high",
    });
    expect(config.value).toMatchObject({
      provider: "openai",
      model: "gpt-6-astra",
      reasoningEffort: "high",
    });

    const invalid = await Effect.runPromise(
      Effect.result(provider.models.select("gpt-6-astra", "medium")),
    );
    expect(invalid._tag).toBe("Failure");
    if (invalid._tag === "Failure")
      expect(invalid.failure).toMatchObject({
        _tag: "ModelUnavailable",
        provider: "openai",
        model: "gpt-6-astra",
        reasoningEffort: "medium",
      });
  });
});
