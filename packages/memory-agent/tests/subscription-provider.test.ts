import { Effect } from "effect";
import { describe, expect, test } from "vite-plus/test";
import type { Settings } from "../src/config/global-config.ts";
import type { LoginAttempt, OAuthConnectionStatus } from "../src/oauth/validation-harness.ts";
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
      modelCatalog: async () => pages,
    },
    complete: () => {
      connected = true;
      finish({ provider, connected: true, expiresAt: Date.now() + 60_000 });
    },
    get cancelled() {
      return cancelled;
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
      Effect.either(provider.models.select("gpt-6-astra", "medium")),
    );
    expect(invalid._tag).toBe("Left");
    if (invalid._tag === "Left")
      expect(invalid.left).toMatchObject({
        _tag: "ModelUnavailable",
        provider: "openai",
        model: "gpt-6-astra",
        reasoningEffort: "medium",
      });
  });
});
