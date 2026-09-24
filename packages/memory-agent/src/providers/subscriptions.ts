import { Effect, Layer } from "effect";
import { GlobalConfig } from "../config/global-config.ts";
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
      createSubscriptionRuntime("openai", openaiClient),
      createSubscriptionRuntime("anthropic", anthropicClient),
    ],
  );
});

/** Product subscription auth, catalogs, and native model runtimes for both providers. */
export const SubscriptionProviderRegistry = Layer.effect(ProviderRegistry, make);
