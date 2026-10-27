import { Crypto, Data, Effect, Function as EffectFunction } from "effect";
import { optionalProperty } from "../optional-property.ts";
import { Option, Schema } from "effect";
import { JsonValue } from "../json.ts";
import { SubscriptionAccountProvider } from "../providers/contracts.ts";

export { JsonValue } from "../json.ts";

export type OAuthProvider = SubscriptionAccountProvider;

export class ProviderFeatureRejectedError extends Schema.TaggedError<ProviderFeatureRejectedError>()(
  "ProviderFeatureRejectedError",
  {
    provider: SubscriptionAccountProvider,
    feature: Schema.Literal("prompt-cache"),
    status: Schema.NullOr(Schema.Int),
  },
) {
  override get message() {
    return `${this.provider} rejected the ${this.feature} request feature.`;
  }
}

export const ProviderStreamFailedReason = Schema.TaggedUnion({
  /** Only this reason proves the request never reached the provider (connection, DNS or TLS setup). */
  RequestNotSent: { stage: Schema.Literals(["dns", "connect", "tls"]) },
  /** The provider answered with an error status; only the status class is kept, never the body. */
  ProviderStatusRejected: { statusClass: Schema.Literals(["client_error", "server_error"]) },
  /** The response or its event stream had started when the connection broke. */
  ResponseInterrupted: {},
  /** The request may have reached the provider; treated as sent. */
  RequestOutcomeUnknown: {},
});
export const RequestNotSent = ProviderStreamFailedReason.cases.RequestNotSent;
export const ProviderStatusRejected = ProviderStreamFailedReason.cases.ProviderStatusRejected;
export const ResponseInterrupted = ProviderStreamFailedReason.cases.ResponseInterrupted;
export const RequestOutcomeUnknown = ProviderStreamFailedReason.cases.RequestOutcomeUnknown;

export class ProviderStreamFailed extends Schema.TaggedError<ProviderStreamFailed>()(
  "ProviderStreamFailed",
  {
    provider: Schema.Literals(["openai", "anthropic"]),
    reason: ProviderStreamFailedReason,
  },
) {
  override get message() {
    return "Provider model stream failed.";
  }
}

export interface ProviderProtocol {
  readonly provider: OAuthProvider;
  readonly clientId: string;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly scopes: string;
  readonly modelUrl: string;
  readonly catalogUrl: string;
  readonly callbackPath: string;
  readonly callbackPort: number | null;
  readonly callbackRedirectHost: string;
  readonly tokenEncoding: "form" | "json";
  readonly refreshStatuses: readonly number[];
  readonly modelHeaders: Readonly<Record<string, string>>;
  readonly authorizeParameters?: Readonly<Record<string, string>>;
}

/** Claude Code release the subscription requests identify as; models gate on its minimum version. */
export const claudeCodeVersion = "2.1.296";

export const providerProtocols: Readonly<Record<OAuthProvider, ProviderProtocol>> = {
  openai: {
    provider: "openai",
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    authorizeUrl: "https://auth.openai.com/oauth/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    scopes: "openid profile email offline_access api.connectors.read api.connectors.invoke",
    modelUrl: "https://chatgpt.com/backend-api/codex/responses",
    catalogUrl: "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0",
    callbackPath: "/auth/callback",
    callbackPort: 1455,
    // Match Codex's registered IPv4 loopback redirect; localhost may resolve to ::1 on Windows.
    callbackRedirectHost: "127.0.0.1",
    tokenEncoding: "form",
    refreshStatuses: [401],
    modelHeaders: {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      originator: "codex_cli_rs",
    },
    authorizeParameters: {
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      originator: "codex_cli_rs",
      prompt: "login",
    },
  },
  anthropic: {
    provider: "anthropic",
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    authorizeUrl: "https://claude.com/cai/oauth/authorize",
    tokenUrl: "https://platform.claude.com/v1/oauth/token",
    scopes:
      "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
    modelUrl: "https://api.anthropic.com/v1/messages?beta=true",
    catalogUrl: "https://api.anthropic.com/v1/models",
    callbackPath: "/callback",
    callbackPort: null,
    callbackRedirectHost: "localhost",
    tokenEncoding: "json",
    refreshStatuses: [401, 403],
    modelHeaders: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": `claude-cli/${claudeCodeVersion} (external, sdk-cli)`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta":
        "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,advisor-tool-2026-03-01,advanced-tool-use-2025-11-20,effort-2025-11-24",
      "anthropic-dangerous-direct-browser-access": "true",
      "x-app": "cli",
      "X-Stainless-Lang": "js",
      "X-Stainless-Package-Version": "0.81.0",
      "X-Stainless-Retry-Count": "0",
      "X-Stainless-Runtime": "node",
      "X-Stainless-Runtime-Version": "v24.3.0",
      "X-Stainless-Timeout": "600",
    },
    authorizeParameters: { code: "true" },
  },
};

export interface Pkce {
  readonly verifier: string;
  readonly challenge: string;
}

const base64Url = (value: Uint8Array) => Buffer.from(value).toString("base64url");

export const createPkce = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const verifier = base64Url(yield* crypto.randomBytes(48));
  const pkce: Pkce = {
    verifier,
    challenge: base64Url(yield* crypto.digest("SHA-256", new TextEncoder().encode(verifier))),
  };
  return pkce;
});

export const createOAuthState = Effect.map(
  Effect.flatMap(Effect.service(Crypto.Crypto), (crypto) => crypto.randomBytes(32)),
  base64Url,
);

export const ToolArguments = Schema.Record(Schema.String, JsonValue);
export type ToolArguments = typeof ToolArguments.Type;

/** The provider-neutral stream contract that both providers' SSE events are decoded into. */
export type NormalizedStreamEvent = Data.TaggedEnum<{
  text: { readonly text: string };
  "tool-call": {
    readonly id: string;
    readonly name: string;
    readonly arguments: ToolArguments;
  };
  "tool-call-start": {
    readonly index: number;
    readonly id: string;
    readonly name: string;
  };
  "tool-call-arguments": {
    readonly index: number;
    readonly delta: string;
  };
  "content-block-end": { readonly index: number };
  "reasoning-start": { readonly index: number };
  "reasoning-delta": {
    readonly index: number;
    readonly delta: string;
  };
  "reasoning-signature": {
    readonly index: number;
    readonly signature: string;
  };
  reasoning: {
    readonly id: string;
    readonly encryptedContent: string;
  };
  "reasoning-summary-start": {
    readonly id: string;
    readonly summaryIndex: number;
    readonly text: string;
  };
  "reasoning-summary-delta": {
    readonly id: string;
    readonly summaryIndex: number;
    readonly delta: string;
  };
  "reasoning-summary-end": {
    readonly id: string;
    readonly summaryIndex: number;
    readonly text: string;
  };
  usage: {
    /** The whole input, cache reads and writes included. */
    readonly promptTokens?: number;
    readonly completionTokens?: number;
    readonly cachedPromptTokens?: number;
    readonly cacheWriteTokens?: number;
  };
  error: {
    readonly code: string;
    readonly message: string;
  };
}>;
export const NormalizedStreamEvent = Data.taggedEnum<NormalizedStreamEvent>();

export type StreamTextEvent = Data.TaggedEnum.Value<NormalizedStreamEvent, "text">;
export type StreamToolCallEvent = Data.TaggedEnum.Value<NormalizedStreamEvent, "tool-call">;
export type StreamToolCallStartEvent = Data.TaggedEnum.Value<
  NormalizedStreamEvent,
  "tool-call-start"
>;
export type StreamToolCallArgumentsEvent = Data.TaggedEnum.Value<
  NormalizedStreamEvent,
  "tool-call-arguments"
>;
export type StreamContentBlockEndEvent = Data.TaggedEnum.Value<
  NormalizedStreamEvent,
  "content-block-end"
>;
export type StreamReasoningStartEvent = Data.TaggedEnum.Value<
  NormalizedStreamEvent,
  "reasoning-start"
>;
export type StreamReasoningDeltaEvent = Data.TaggedEnum.Value<
  NormalizedStreamEvent,
  "reasoning-delta"
>;
export type StreamReasoningSignatureEvent = Data.TaggedEnum.Value<
  NormalizedStreamEvent,
  "reasoning-signature"
>;
export type StreamReasoningSummaryStartEvent = Data.TaggedEnum.Value<
  NormalizedStreamEvent,
  "reasoning-summary-start"
>;
export type StreamReasoningSummaryDeltaEvent = Data.TaggedEnum.Value<
  NormalizedStreamEvent,
  "reasoning-summary-delta"
>;
export type StreamReasoningSummaryEndEvent = Data.TaggedEnum.Value<
  NormalizedStreamEvent,
  "reasoning-summary-end"
>;
export type StreamReasoningEvent = Data.TaggedEnum.Value<NormalizedStreamEvent, "reasoning">;
export type StreamUsageEvent = Data.TaggedEnum.Value<NormalizedStreamEvent, "usage">;
export type StreamErrorEvent = Data.TaggedEnum.Value<NormalizedStreamEvent, "error">;

export const ReasoningSummaryProtocolFailedReason = Schema.TaggedUnion({
  InterleavedItems: {},
  ConflictingSummary: {},
  AlreadyEnded: {},
  ResourceLimit: {},
  IncompleteSummary: {},
});

export class ReasoningSummaryProtocolFailed extends Schema.TaggedError<ReasoningSummaryProtocolFailed>()(
  "ReasoningSummaryProtocolFailed",
  { reason: ReasoningSummaryProtocolFailedReason },
) {
  override get message() {
    return "Public reasoning summary protocol failed.";
  }
}

export interface StreamReasoningItemEndEvent {
  readonly type: "reasoning-item-end";
  readonly id: string;
}

const SummaryIndex = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const OpenAiWireEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("response.reasoning_summary_part.added"),
    item_id: Schema.NonEmptyString,
    output_index: SummaryIndex,
    summary_index: SummaryIndex,
    part: Schema.Struct({ type: Schema.Literal("summary_text"), text: Schema.String }),
  }),
  Schema.Struct({
    type: Schema.Literal("response.reasoning_summary_text.delta"),
    item_id: Schema.NonEmptyString,
    output_index: SummaryIndex,
    summary_index: SummaryIndex,
    delta: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("response.reasoning_summary_part.done"),
    item_id: Schema.NonEmptyString,
    output_index: SummaryIndex,
    summary_index: SummaryIndex,
    part: Schema.Struct({ type: Schema.Literal("summary_text"), text: Schema.String }),
  }),
  Schema.Struct({
    type: Schema.Literal("response.output_text.delta"),
    delta: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("response.output_item.done"),
    item: Schema.Struct({
      type: Schema.Literal("function_call"),
      call_id: Schema.String,
      name: Schema.String,
      arguments: Schema.String,
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("response.output_item.done"),
    item: Schema.Struct({
      type: Schema.Literal("reasoning"),
      id: Schema.String,
      encrypted_content: Schema.String,
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("response.completed"),
    response: Schema.Struct({
      usage: Schema.Struct({
        input_tokens: Schema.Finite,
        output_tokens: Schema.Finite,
        input_tokens_details: Schema.optional(
          Schema.Struct({ cached_tokens: Schema.optional(Schema.Finite) }),
        ),
      }),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("response.failed"),
    response: Schema.Struct({
      error: Schema.Struct({
        code: Schema.optional(Schema.String),
        message: Schema.String,
      }),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("error"),
    code: Schema.optional(Schema.String),
    message: Schema.String,
  }),
]);

const AnthropicWireEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("content_block_delta"),
    index: Schema.Finite,
    delta: Schema.Struct({ type: Schema.Literal("text_delta"), text: Schema.String }),
  }),
  Schema.Struct({
    type: Schema.Literal("content_block_start"),
    index: Schema.Finite,
    content_block: Schema.Struct({
      type: Schema.Literal("tool_use"),
      id: Schema.String,
      name: Schema.String,
      input: ToolArguments,
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("content_block_start"),
    index: Schema.Finite,
    content_block: Schema.Struct({
      type: Schema.Literal("thinking"),
      thinking: Schema.String,
      signature: Schema.optional(Schema.String),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("content_block_delta"),
    index: Schema.Finite,
    delta: Schema.Struct({
      type: Schema.Literal("input_json_delta"),
      partial_json: Schema.String,
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("content_block_delta"),
    index: Schema.Finite,
    delta: Schema.Struct({
      type: Schema.Literal("thinking_delta"),
      thinking: Schema.String,
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("content_block_delta"),
    index: Schema.Finite,
    delta: Schema.Struct({
      type: Schema.Literal("signature_delta"),
      signature: Schema.String,
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("content_block_stop"),
    index: Schema.Finite,
  }),
  Schema.Struct({
    type: Schema.Literal("message_start"),
    message: Schema.Struct({
      usage: Schema.Struct({
        input_tokens: Schema.Finite,
        cache_read_input_tokens: Schema.optional(Schema.Finite),
        cache_creation_input_tokens: Schema.optional(Schema.Finite),
      }),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("message_delta"),
    usage: Schema.Struct({ output_tokens: Schema.Finite }),
  }),
  Schema.Struct({
    type: Schema.Literal("error"),
    error: Schema.Struct({ type: Schema.String, message: Schema.String }),
  }),
]);

const decodeToolArguments = Schema.decodeUnknownOption(Schema.fromJsonString(ToolArguments));

/** Parses one provider SSE data value into the provider-neutral stream contract. */
export const decodeProviderEvent: {
  (data: string): (provider: OAuthProvider) => ReturnType<typeof decodeProviderEventBody>;
} & typeof decodeProviderEventBody = EffectFunction.dual(2, decodeProviderEventBody);
function decodeProviderEventBody(
  provider: OAuthProvider,
  data: string,
): NormalizedStreamEvent | null {
  try {
    const json = JSON.parse(data);
    if (provider === "openai") {
      return Option.match(Schema.decodeUnknownOption(OpenAiWireEvent)(json), {
        onNone: () => null,
        onSome: (event): NormalizedStreamEvent | null => {
          switch (event.type) {
            case "response.reasoning_summary_part.added":
              return NormalizedStreamEvent["reasoning-summary-start"]({
                id: event.item_id,
                summaryIndex: event.summary_index,
                text: event.part.text,
              });
            case "response.reasoning_summary_text.delta":
              return NormalizedStreamEvent["reasoning-summary-delta"]({
                id: event.item_id,
                summaryIndex: event.summary_index,
                delta: event.delta,
              });
            case "response.reasoning_summary_part.done":
              return NormalizedStreamEvent["reasoning-summary-end"]({
                id: event.item_id,
                summaryIndex: event.summary_index,
                text: event.part.text,
              });
            default:
              break;
          }
          if (event.type === "response.output_text.delta")
            return NormalizedStreamEvent.text({ text: event.delta });
          if (event.type === "response.completed")
            return NormalizedStreamEvent.usage({
              promptTokens: event.response.usage.input_tokens,
              completionTokens: event.response.usage.output_tokens,
              ...optionalProperty(
                "cachedPromptTokens",
                event.response.usage.input_tokens_details?.cached_tokens,
              ),
            });
          if (event.type === "response.failed")
            return NormalizedStreamEvent.error({
              code: event.response.error.code ?? "response_failed",
              message: event.response.error.message,
            });
          if (event.type === "error")
            return NormalizedStreamEvent.error({
              code: event.code ?? "provider_error",
              message: event.message,
            });
          if (event.item.type === "reasoning")
            return NormalizedStreamEvent.reasoning({
              id: event.item.id,
              encryptedContent: event.item.encrypted_content,
            });
          const item = event.item;
          return Option.match(decodeToolArguments(item.arguments), {
            onNone: () => null,
            onSome: (argumentsValue) =>
              NormalizedStreamEvent["tool-call"]({
                id: item.call_id,
                name: item.name,
                arguments: argumentsValue,
              }),
          });
        },
      });
    }
    return Option.match(Schema.decodeUnknownOption(AnthropicWireEvent)(json), {
      onNone: () => null,
      onSome: (event): NormalizedStreamEvent | null => {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta")
          return NormalizedStreamEvent.text({ text: event.delta.text });
        if (event.type === "message_start") {
          const usage = event.message.usage;
          // Anthropic's `input_tokens` counts only the uncached part of the input.
          return NormalizedStreamEvent.usage({
            promptTokens:
              usage.input_tokens +
              (usage.cache_read_input_tokens ?? 0) +
              (usage.cache_creation_input_tokens ?? 0),
            ...optionalProperty("cachedPromptTokens", usage.cache_read_input_tokens),
            ...optionalProperty("cacheWriteTokens", usage.cache_creation_input_tokens),
          });
        }
        if (event.type === "message_delta")
          return NormalizedStreamEvent.usage({ completionTokens: event.usage.output_tokens });
        if (event.type === "error")
          return NormalizedStreamEvent.error({
            code: event.error.type,
            message: event.error.message,
          });
        if (event.type === "content_block_start" && event.content_block.type === "tool_use")
          return NormalizedStreamEvent["tool-call-start"]({
            index: event.index,
            id: event.content_block.id,
            name: event.content_block.name,
          });
        if (event.type === "content_block_start" && event.content_block.type === "thinking")
          return NormalizedStreamEvent["reasoning-start"]({ index: event.index });
        if (event.type === "content_block_delta" && event.delta.type === "input_json_delta")
          return NormalizedStreamEvent["tool-call-arguments"]({
            index: event.index,
            delta: event.delta.partial_json,
          });
        if (event.type === "content_block_delta" && event.delta.type === "thinking_delta")
          return NormalizedStreamEvent["reasoning-delta"]({
            index: event.index,
            delta: event.delta.thinking,
          });
        if (event.type === "content_block_delta" && event.delta.type === "signature_delta")
          return NormalizedStreamEvent["reasoning-signature"]({
            index: event.index,
            signature: event.delta.signature,
          });
        if (event.type === "content_block_stop")
          return NormalizedStreamEvent["content-block-end"]({ index: event.index });
        return null;
      },
    });
  } catch {
    return null;
  }
}
