import { optionalProperty } from "../optional-property.ts";
import type { ModelMessage } from "@tanstack/ai";
import { Predicate, Effect, Schema } from "effect";
import { GlobalConfig } from "../config/global-config.ts";
import { ProviderId, type ModelSelection } from "../providers/contracts.ts";
import { ProviderRegistry } from "../providers/registry.ts";
import { OpenAICompatibleSettings } from "../providers/openai-compatible.ts";
import {
  subscriptionRequest,
  type StreamingOAuthClient,
} from "../providers/subscription-adapter.ts";
import { ToolArguments, type NormalizedStreamEvent } from "../oauth/protocol.ts";

const count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const SubscriptionResult = Schema.Struct({
  events: Schema.Array(
    Schema.Union([
      Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
      Schema.Struct({
        type: Schema.Literal("tool-call"),
        id: Schema.String,
        name: Schema.String,
        arguments: ToolArguments,
      }),
      Schema.Struct({
        type: Schema.Literal("tool-call-start"),
        index: count,
        id: Schema.String,
        name: Schema.String,
      }),
      Schema.Struct({
        type: Schema.Literal("tool-call-arguments"),
        index: count,
        delta: Schema.String,
      }),
      Schema.Struct({ type: Schema.Literal("content-block-end"), index: count }),
      Schema.Struct({ type: Schema.Literal("reasoning-start"), index: count }),
      Schema.Struct({
        type: Schema.Literal("reasoning-delta"),
        index: count,
        delta: Schema.String,
      }),
      Schema.Struct({
        type: Schema.Literal("reasoning-signature"),
        index: count,
        signature: Schema.String,
      }),
      Schema.Struct({
        type: Schema.Literal("reasoning"),
        id: Schema.String,
        encryptedContent: Schema.String,
      }),
      Schema.Struct({
        type: Schema.Literal("usage"),
        promptTokens: Schema.optionalKey(count),
        completionTokens: Schema.optionalKey(count),
        cachedPromptTokens: Schema.optionalKey(count),
      }),
      Schema.Struct({ type: Schema.Literal("error"), code: Schema.String, message: Schema.String }),
    ]),
  ),
  usage: Schema.optionalKey(Schema.Struct({ prompt_tokens: count, completion_tokens: count })),
});
export interface CompletionGateway {
  readonly configuration: {
    readonly provider: typeof ProviderId.Type;
    readonly model: string;
    readonly baseUrl: string;
    readonly reasoningEffort: string;
  };
  readonly complete: (body: string, signal: AbortSignal) => Promise<string>;
  readonly release: () => void;
}
export type ModelGateway =
  | (CompletionGateway & { readonly protocol: "chat-completions" })
  | (CompletionGateway & {
      readonly protocol: "subscription";
      readonly subscription: (body: string, signal: AbortSignal) => Promise<string>;
    });

const ProposalRequest = Schema.Struct({
  messages: Schema.Array(
    Schema.Struct({
      role: Schema.Literals(["system", "user", "assistant"]),
      content: Schema.String,
    }),
  ),
});

/** Keep account/model credentials in the host; preserve native reasoning/tool events in worker replies. */
export function subscriptionGateway(
  selection: ModelSelection,
  client: StreamingOAuthClient,
): ModelGateway {
  const subscription = async (body: string, signal: AbortSignal) => {
    const payload = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
    )(body);
    const events: NormalizedStreamEvent[] = [];
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    for await (const event of client.stream(
      JSON.stringify({ ...payload, model: selection.model }),
      signal,
    )) {
      if (signal.aborted) throw new Error("experiment_stopped");
      if (event.type === "error") throw new Error("provider_request_failed");
      events.push(event);
      if (event.type === "usage") {
        promptTokens = event.promptTokens ?? promptTokens;
        completionTokens = event.completionTokens ?? completionTokens;
      }
    }
    if (signal.aborted) throw new Error("experiment_stopped");
    const usage =
      promptTokens !== undefined && completionTokens !== undefined
        ? { prompt_tokens: promptTokens, completion_tokens: completionTokens }
        : undefined;
    return JSON.stringify({ events, ...optionalProperty("usage", usage) });
  };
  return {
    protocol: "subscription",
    configuration: {
      provider: selection.provider,
      model: selection.model,
      baseUrl: selection.provider,
      reasoningEffort: selection.reasoningEffort,
    },
    release: () => client.releaseRun?.(),
    subscription,
    complete: async (body, signal) => {
      const request = Schema.decodeUnknownSync(Schema.fromJsonString(ProposalRequest))(body);
      if (selection.provider === "openai-compatible")
        throw new Error("invalid_subscription_provider");
      const raw = await subscription(
        subscriptionRequest(selection.provider, selection, {
          systemPrompts: request.messages
            .filter((message) => message.role === "system")
            .map((message) => message.content),
          messages: request.messages.flatMap<ModelMessage>((message) => {
            switch (message.role) {
              case "system":
                return [];
              case "user":
                return [{ role: "user" as const, content: message.content }];
              case "assistant":
                return [{ role: "assistant" as const, content: message.content }];
            }
          }),
        }),
        signal,
      );
      const result = Schema.decodeUnknownSync(Schema.fromJsonString(SubscriptionResult))(raw);
      return JSON.stringify({
        choices: [
          {
            message: {
              content: result.events
                .flatMap((event) => (event.type === "text" ? [event.text] : []))
                .join(""),
            },
          },
        ],
        ...optionalProperty("usage", result.usage),
      });
    },
  };
}

export class GatewayUnavailable extends Schema.TaggedError<GatewayUnavailable>()(
  "GatewayUnavailable",
  {},
) {}
export const pinModelGateway = Effect.fn("Rrsi.pinModelGateway")(function* () {
  const settings = yield* (yield* GlobalConfig).read;
  const registry = yield* ProviderRegistry;
  const provider = settings.provider ?? "openai";
  const configuration = yield* registry
    .get(provider)
    .pipe(Effect.mapError(() => new GatewayUnavailable()));
  const selection = yield* configuration.models.selected;
  if (!selection) return yield* new GatewayUnavailable();
  const auth = yield* configuration.auth.status.pipe(
    Effect.mapError(() => new GatewayUnavailable()),
  );
  if (auth.status !== "signed-in") return yield* new GatewayUnavailable();
  switch (selection.provider) {
    case "openai-compatible": {
      const client = yield* (yield* OpenAICompatibleSettings).pinRrsiClient.pipe(
        Effect.mapError(() => new GatewayUnavailable()),
      );
      return {
        ...client,
        protocol: "chat-completions" as const,
        configuration: {
          ...client.configuration,
          provider: selection.provider,
          reasoningEffort: selection.reasoningEffort,
        },
        release: () => {},
      } satisfies ModelGateway;
    }
    case "openai":
    case "anthropic": {
      if (!registry.subscriptionDependencies) return yield* new GatewayUnavailable();
      const dependencies = yield* registry
        .subscriptionDependencies(selection.provider)
        .pipe(Effect.mapError(() => new GatewayUnavailable()));
      return yield* Effect.try({
        try: () =>
          subscriptionGateway(
            selection,
            Predicate.isFunction(dependencies.client) ? dependencies.client() : dependencies.client,
          ),
        catch: () => new GatewayUnavailable(),
      });
    }
  }
});
