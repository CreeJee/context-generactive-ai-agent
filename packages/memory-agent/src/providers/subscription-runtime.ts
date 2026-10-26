import { isTruthy } from "../truthy.ts";
import { Effect, Function as EffectFunction, Predicate, Schema } from "effect";
import type { AgentLoopStrategy, ChatMiddleware } from "@tanstack/ai";
import { subscriptionModel, shownSubscriptionFailure } from "../model/subscription.ts";
import { SubscriptionTextAdapter, type StreamingOAuthClient } from "./subscription-adapter.ts";
import {
  ModelUnavailable,
  SubscriptionModelSelection,
  type AgentModelRuntime,
  type ModelSelection,
  type SubscriptionAccountProvider,
  type RunTextAdapter,
} from "./contracts.ts";

/**
 * Continue until the provider answers instead of ending after an arbitrary number of tool steps.
 * Approval interrupts are durable TanStack runs: a resumed request supplies the saved transcript,
 * so the next adapter iteration sends the resolved tool result without a parked provider turn.
 */
export const subscriptionAgentLoop: AgentLoopStrategy = ({ iterationCount, finishReason }) =>
  iterationCount === 0 || finishReason === "tool_calls";

const runMiddleware = (provider: SubscriptionAccountProvider): ChatMiddleware => ({
  name: `memory-agent/${provider}-subscription-run`,
});

const contextWindows: Readonly<Record<SubscriptionAccountProvider, number>> = {
  openai: 258_400,
  anthropic: 200_000,
};

export function releaseSubscriptionRun(adapter: RunTextAdapter | null): void {
  adapter?.releaseRun?.();
}

export interface SubscriptionRuntimeDependencies {
  readonly client: StreamingOAuthClient | (() => StreamingOAuthClient);
  readonly catalogWindow?: (model: string) => number | null;
}

const ProviderMismatch = Schema.TaggedStruct("ProviderMismatch", {
  expected: Schema.String,
  actual: Schema.String,
  model: Schema.String,
});
export class SubscriptionRuntimeRejected extends Schema.TaggedError<SubscriptionRuntimeRejected>()(
  "SubscriptionRuntimeRejected",
  { reason: ProviderMismatch },
) {
  override get message(): string {
    return `Provider mismatch: ${this.reason.expected} runtime cannot run ${this.reason.actual}/${this.reason.model}.`;
  }
}

/**
 * Retain code, not a runtime bound to an account or run. The central owner supplies dependencies
 * anew at bind time; account selection still happens once per adapter through client.forRun.
 * This SDK boundary owns no auth, broker, active-run registry, or application resources.
 */
export function createSubscriptionRuntimeImplementation(provider: SubscriptionAccountProvider) {
  const Adapter = SubscriptionTextAdapter;
  const agentLoop = subscriptionAgentLoop;
  const middleware = runMiddleware;
  const fallbackWindow = contextWindows[provider];
  return Object.freeze({
    bind({
      client,
      catalogWindow = () => null,
    }: SubscriptionRuntimeDependencies): AgentModelRuntime {
      return {
        provider,
        adapter: (selection: ModelSelection) => {
          if (!Schema.is(SubscriptionModelSelection)(selection) || selection.provider !== provider)
            throw SubscriptionRuntimeRejected.make({
              reason: ProviderMismatch.make({
                expected: provider,
                actual: selection.provider,
                model: selection.model,
              }),
            });
          const pinned = Predicate.isFunction(client) ? client() : client;
          const adapter = new Adapter(pinned, selection);
          const releaseRun = pinned.releaseRun;
          return isTruthy(releaseRun) ? Object.assign(adapter, { releaseRun }) : adapter;
        },
        model: (selection, run) =>
          Effect.gen(function* () {
            const chosen = yield* Effect.filterOrFail(
              Effect.succeed(selection),
              (candidate): candidate is SubscriptionModelSelection =>
                Schema.is(SubscriptionModelSelection)(candidate) && candidate.provider === provider,
              () => ModelUnavailable.make(selection),
            );
            // Pinned for the run, as the adapter pins it, so the account never changes mid-run.
            const pinned = yield* Effect.acquireRelease(
              Effect.sync(() => (Predicate.isFunction(client) ? client() : client)),
              (held) => Effect.sync(() => held.releaseRun?.()),
            );
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
        agentLoop,
        runMiddleware: () => middleware(provider),
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
  client: StreamingOAuthClient | (() => StreamingOAuthClient),
  catalogWindow: (model: string) => number | null = () => null,
): AgentModelRuntime {
  return createSubscriptionRuntimeImplementation(provider).bind({ client, catalogWindow });
}
