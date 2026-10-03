import { Effect, Layer } from "effect";
import { GlobalConfig } from "../config/global-config.ts";
import { Database } from "../db/database.ts";
import { createAccountBoundSubscriptionClients } from "../oauth/account-bound.ts";
import { providerProtocols } from "../oauth/protocol.ts";
import { createSubscriptionOAuthClient } from "../oauth/subscription-oauth.ts";
import { createSubscriptionProvider } from "./subscription-provider.ts";
import { ProviderRegistry, providerRegistryFrom } from "./registry.ts";
import { createSubscriptionRuntime } from "./subscription-runtime.ts";

const make = Effect.gen(function* () {
  const config = yield* GlobalConfig;
  const openaiClient = createSubscriptionOAuthClient({
    protocol: providerProtocols.openai,
  });
  const anthropicClient = createSubscriptionOAuthClient({
    protocol: providerProtocols.anthropic,
  });
  const openai = createSubscriptionProvider({
    protocol: providerProtocols.openai,
    config,
    client: openaiClient,
  });
  const anthropic = createSubscriptionProvider({
    protocol: providerProtocols.anthropic,
    config,
    client: anthropicClient,
  });

  return providerRegistryFrom(
    [openai, anthropic],
    [
      createSubscriptionRuntime("openai", openaiClient, openai.contextWindow),
      createSubscriptionRuntime("anthropic", anthropicClient, anthropic.contextWindow),
    ],
    (provider) =>
      Effect.succeed(
        provider === "openai"
          ? { client: openaiClient, catalogWindow: openai.contextWindow }
          : { client: anthropicClient, catalogWindow: anthropic.contextWindow },
      ),
  );
});

/** Product subscription auth, catalogs, and native model runtimes for both providers. */
export const SubscriptionProviderRegistry = Layer.effect(ProviderRegistry, make);

/** App runtime: dynamically select only for NEW calls and pin the selected client per run. */
const makeForAccounts = Effect.gen(function* () {
  const config = yield* GlobalConfig;
  const { sqlite } = yield* Database;
  const openaiClient = createAccountBoundSubscriptionClients(sqlite, "openai");
  const anthropicClient = createAccountBoundSubscriptionClients(sqlite, "anthropic");
  const openai = createSubscriptionProvider({
    protocol: providerProtocols.openai,
    config,
    client: openaiClient.client,
    catalogKey: openaiClient.catalogKey,
  });
  const anthropic = createSubscriptionProvider({
    protocol: providerProtocols.anthropic,
    config,
    client: anthropicClient.client,
    catalogKey: anthropicClient.catalogKey,
  });
  return providerRegistryFrom(
    [openai, anthropic],
    [
      createSubscriptionRuntime("openai", openaiClient.forRun, openai.contextWindow),
      createSubscriptionRuntime("anthropic", anthropicClient.forRun, anthropic.contextWindow),
    ],
    (provider) =>
      Effect.succeed(
        provider === "openai"
          ? { client: openaiClient.forRun, catalogWindow: openai.contextWindow }
          : { client: anthropicClient.forRun, catalogWindow: anthropic.contextWindow },
      ),
  );
});

export const AccountSubscriptionProviderRegistry = Layer.effect(ProviderRegistry, makeForAccounts);
