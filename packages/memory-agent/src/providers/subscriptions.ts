import { Effect, Layer } from "effect";
import { GlobalConfig } from "../config/global-config.ts";
import { OAuthProfiles } from "../oauth/accounts.ts";
import { createAccountBoundSubscriptionClients } from "../oauth/account-bound.ts";
import { providerProtocols } from "../oauth/protocol.ts";
import { createSubscriptionOAuthClient, OAuthKeychain } from "../oauth/subscription-oauth.ts";
import { createSubscriptionProvider } from "./subscription-provider.ts";
import { ProviderRegistry, providerRegistryFrom } from "./registry.ts";
import { createSubscriptionRuntime } from "./subscription-runtime.ts";

const make = Effect.gen(function* () {
  const config = yield* GlobalConfig;
  const vault = yield* OAuthKeychain;
  const openaiClient = yield* createSubscriptionOAuthClient({
    protocol: providerProtocols.openai,
    store: vault.store,
  });
  const anthropicClient = yield* createSubscriptionOAuthClient({
    protocol: providerProtocols.anthropic,
    store: vault.store,
  });
  const openai = yield* createSubscriptionProvider({
    protocol: providerProtocols.openai,
    config,
    client: { ...openaiClient, startLogin: openaiClient.startLogin() },
  });
  const anthropic = yield* createSubscriptionProvider({
    protocol: providerProtocols.anthropic,
    config,
    client: { ...anthropicClient, startLogin: anthropicClient.startLogin() },
  });

  return providerRegistryFrom({
    configurations: [openai, anthropic],
    runtimes: [
      createSubscriptionRuntime("openai", openaiClient, openai.contextWindow),
      createSubscriptionRuntime("anthropic", anthropicClient, anthropic.contextWindow),
    ],
    subscriptionDependencies: (provider) =>
      Effect.succeed(
        provider === "openai"
          ? { client: openaiClient, catalogWindow: openai.contextWindow }
          : { client: anthropicClient, catalogWindow: anthropic.contextWindow },
      ),
  });
});

/** Product subscription auth, catalogs, and native model runtimes for both providers. */
export const SubscriptionProviderRegistry = Layer.effect(ProviderRegistry, make);

/** App runtime: dynamically select only for NEW calls and pin the selected client per run. */
const makeForAccounts = Effect.gen(function* () {
  const config = yield* GlobalConfig;
  const profiles = yield* OAuthProfiles;
  const openaiClient = yield* createAccountBoundSubscriptionClients({
    profiles,
    provider: "openai",
  });
  const anthropicClient = yield* createAccountBoundSubscriptionClients({
    profiles,
    provider: "anthropic",
  });
  const openai = yield* createSubscriptionProvider({
    protocol: providerProtocols.openai,
    config,
    client: openaiClient.client,
    catalogKey: openaiClient.catalogKey,
  });
  const anthropic = yield* createSubscriptionProvider({
    protocol: providerProtocols.anthropic,
    config,
    client: anthropicClient.client,
    catalogKey: anthropicClient.catalogKey,
  });
  return providerRegistryFrom({
    configurations: [openai, anthropic],
    runtimes: [
      createSubscriptionRuntime("openai", openaiClient.forRun, openai.contextWindow),
      createSubscriptionRuntime("anthropic", anthropicClient.forRun, anthropic.contextWindow),
    ],
    subscriptionDependencies: (provider) =>
      Effect.succeed(
        provider === "openai"
          ? { client: openaiClient.forRun, catalogWindow: openai.contextWindow }
          : { client: anthropicClient.forRun, catalogWindow: anthropic.contextWindow },
      ),
  });
});

export const AccountSubscriptionProviderRegistry = Layer.effect(ProviderRegistry, makeForAccounts);
