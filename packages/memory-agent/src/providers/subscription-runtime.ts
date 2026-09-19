import type { AgentLoopStrategy, ChatMiddleware } from "@tanstack/ai";
import type { SubscriptionOAuthClient } from "../oauth/subscription-oauth.ts";
import { SubscriptionTextAdapter, type StreamingOAuthClient } from "./subscription-adapter.ts";
import type { AgentModelRuntime, ModelSelection, ProviderId } from "./contracts.ts";

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

export function createSubscriptionRuntime(
  provider: ProviderId,
  client: SubscriptionOAuthClient | StreamingOAuthClient,
): AgentModelRuntime {
  return {
    provider,
    adapter: (selection: ModelSelection) => {
      if (selection.provider !== provider)
        throw new Error(
          `Provider mismatch: ${provider} runtime cannot run ${selection.provider}/${selection.model}.`,
        );
      return new SubscriptionTextAdapter(client, selection);
    },
    contextWindow: () => contextWindows[provider],
    agentLoop: subscriptionAgentLoop,
    runMiddleware: () => runMiddleware(provider),
    // Subscription APIs do not expose live-turn steering. Returning no_turn keeps the queued
    // message pending for the provider-neutral transcript middleware instead of pretending it was
    // injected.
    steer: async () => "no_turn",
  };
}
