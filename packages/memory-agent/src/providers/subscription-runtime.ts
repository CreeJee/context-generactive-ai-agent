import { Predicate } from "effect";
import type { AgentLoopStrategy, ChatMiddleware } from "@tanstack/ai";
import { SubscriptionTextAdapter, type StreamingOAuthClient } from "./subscription-adapter.ts";
import type { AgentModelRuntime, ModelSelection, ProviderId, RunTextAdapter } from "./contracts.ts";

/**
 * Continue until the provider answers instead of ending after an arbitrary number of tool steps.
 * Approval interrupts are durable TanStack runs: a resumed request supplies the saved transcript,
 * so the next adapter iteration sends the resolved tool result without a parked provider turn.
 */
export const subscriptionAgentLoop: AgentLoopStrategy = ({ iterationCount, finishReason }) =>
  iterationCount === 0 || finishReason === "tool_calls";

const runMiddleware = (provider: ProviderId): ChatMiddleware => ({
  name: `memory-agent/${provider}-subscription-run`,
});

const contextWindows: Readonly<Record<ProviderId, number>> = {
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

/**
 * Retain code, not a runtime bound to an account or run. The central owner supplies dependencies
 * anew at bind time; account selection still happens once per adapter through client.forRun.
 * This SDK boundary owns no auth, broker, active-run registry, or application resources.
 */
export function createSubscriptionRuntimeImplementation(provider: ProviderId) {
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
          if (selection.provider !== provider)
            throw new Error(
              `Provider mismatch: ${provider} runtime cannot run ${selection.provider}/${selection.model}.`,
            );
          const pinned = Predicate.isFunction(client) ? client() : client;
          const adapter = new Adapter(pinned, selection);
          const releaseRun = pinned.releaseRun;
          return releaseRun ? Object.assign(adapter, { releaseRun }) : adapter;
        },
        contextWindow: (model) => catalogWindow(model) ?? fallbackWindow,
        contextWindowKnown: (model) => catalogWindow(model) !== null,
        agentLoop,
        runMiddleware: () => middleware(provider),
        // Subscription APIs do not expose live-turn steering. The central transcript middleware
        // retains queued messages; do not create a per-Goal steering registry here.
        steer: async () => "no_turn",
      };
    },
  });
}

export function createSubscriptionRuntime(
  provider: ProviderId,
  client: StreamingOAuthClient | (() => StreamingOAuthClient),
  catalogWindow: (model: string) => number | null = () => null,
): AgentModelRuntime {
  return createSubscriptionRuntimeImplementation(provider).bind({ client, catalogWindow });
}
