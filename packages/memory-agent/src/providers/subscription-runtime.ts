import { Effect, Function as EffectFunction, Schema, type Scope } from "effect";
import {
  subscriptionModel,
  shownSubscriptionFailure,
  type StreamingOAuthClient,
} from "../model/subscription.ts";
import type { OAuthProfileRejected } from "../oauth/accounts.ts";
import type { OAuthHarnessError } from "../oauth/validation-harness.ts";
import {
  ModelUnavailable,
  SubscriptionModelSelection,
  type AgentModelRuntime,
  type SubscriptionAccountProvider,
} from "./contracts.ts";

const contextWindows: Readonly<Record<SubscriptionAccountProvider, number>> = {
  openai: 258_400,
  anthropic: 200_000,
};

export interface SubscriptionRuntimeDependencies {
  /** The client, or the run's account client, held until the run's scope closes. */
  readonly client:
    | StreamingOAuthClient
    | Effect.Effect<StreamingOAuthClient, OAuthHarnessError | OAuthProfileRejected, Scope.Scope>;
  readonly catalogWindow?: (model: string) => number | null;
}

/**
 * Retain code, not a runtime bound to an account or run. The central owner supplies dependencies
 * anew at bind time; account selection still happens once per run's model through client.forRun.
 * This SDK boundary owns no auth, broker, active-run registry, or application resources.
 */
export function createSubscriptionRuntimeImplementation(provider: SubscriptionAccountProvider) {
  const fallbackWindow = contextWindows[provider];
  return Object.freeze({
    bind({
      client,
      catalogWindow = () => null,
    }: SubscriptionRuntimeDependencies): AgentModelRuntime {
      return {
        provider,
        model: (selection, run) =>
          Effect.gen(function* () {
            const chosen = yield* Effect.filterOrFail(
              Effect.succeed(selection),
              (candidate): candidate is SubscriptionModelSelection =>
                Schema.is(SubscriptionModelSelection)(candidate) && candidate.provider === provider,
              () => ModelUnavailable.make(selection),
            );
            // Pinned for the run, so the account never changes mid-run. A run without a usable
            // account is a defect, as the client factory's throw was.
            const pinned = yield* Effect.isEffect(client)
              ? Effect.orDie(client)
              : Effect.succeed(client);
            return {
              model: yield* subscriptionModel({
                client: pinned,
                selection: chosen,
                promptCache: { retention: run.cacheRetention, key: run.threadId },
              }),
              // As TanStack wrote it: the adapter's name and kind.
              source: { provider, api: "text", model: chosen.model },
              shownFailure: shownSubscriptionFailure,
            };
          }),
        contextWindow: (model) => catalogWindow(model) ?? fallbackWindow,
        contextWindowKnown: (model) => catalogWindow(model) !== null,
      };
    },
  });
}

type SubscriptionClient = SubscriptionRuntimeDependencies["client"];
type CatalogWindow = NonNullable<SubscriptionRuntimeDependencies["catalogWindow"]>;
export const createSubscriptionRuntime: {
  (client: SubscriptionClient): (provider: SubscriptionAccountProvider) => AgentModelRuntime;
  (
    client: SubscriptionClient,
    catalogWindow: CatalogWindow | undefined,
  ): (provider: SubscriptionAccountProvider) => AgentModelRuntime;
  (provider: SubscriptionAccountProvider, client: SubscriptionClient): AgentModelRuntime;
  (
    provider: SubscriptionAccountProvider,
    client: SubscriptionClient,
    catalogWindow: CatalogWindow | undefined,
  ): AgentModelRuntime;
} = EffectFunction.dual(
  (args) => Schema.is(Schema.Literals(["openai", "anthropic"]))(args[0]),
  createSubscriptionRuntimeBody,
);
function createSubscriptionRuntimeBody(
  provider: SubscriptionAccountProvider,
  client: SubscriptionClient,
  catalogWindow: (model: string) => number | null = () => null,
): AgentModelRuntime {
  return createSubscriptionRuntimeImplementation(provider).bind({ client, catalogWindow });
}
