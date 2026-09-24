import { createHash, randomBytes } from "node:crypto";
import { optionalProperty } from "../optional-property.ts";
import { Data, Option, Schema } from "effect";
import { JsonValue } from "../json.ts";

export { JsonValue } from "../json.ts";

export type OAuthProvider = "openai" | "anthropic";

export class ProviderFeatureRejectedError extends Data.TaggedError("ProviderFeatureRejectedError")<{
  readonly provider: OAuthProvider;
  readonly feature: "prompt-cache";
  readonly status: number | null;
  readonly message: string;
}> {
  constructor(provider: OAuthProvider, feature: "prompt-cache", status: number | null = null) {
    super({
      provider,
      feature,
      status,
      message: `${provider} rejected the ${feature} request feature.`,
    });
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
    callbackRedirectHost: "localhost",
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
      "User-Agent": "claude-cli/2.1.257 (external, sdk-cli)",
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

export function createPkce(): Pkce {
  const verifier = base64Url(randomBytes(48));
  return {
    verifier,
    challenge: createHash("sha256").update(verifier, "ascii").digest("base64url"),
  };
}

export const createOAuthState = () => base64Url(randomBytes(32));

export const ToolArguments = Schema.Record(Schema.String, JsonValue);
export type ToolArguments = typeof ToolArguments.Type;

export interface StreamTextEvent {
  readonly type: "text";
  readonly text: string;
}

export interface StreamToolCallEvent {
  readonly type: "tool-call";
  readonly id: string;
  readonly name: string;
  readonly arguments: ToolArguments;
}

export interface StreamToolCallStartEvent {
  readonly type: "tool-call-start";
  readonly index: number;
  readonly id: string;
  readonly name: string;
}

export interface StreamToolCallArgumentsEvent {
  readonly type: "tool-call-arguments";
  readonly index: number;
  readonly delta: string;
}

export interface StreamContentBlockEndEvent {
  readonly type: "content-block-end";
  readonly index: number;
}

export interface StreamReasoningStartEvent {
  readonly type: "reasoning-start";
  readonly index: number;
}

export interface StreamReasoningDeltaEvent {
  readonly type: "reasoning-delta";
  readonly index: number;
  readonly delta: string;
}

export interface StreamReasoningSignatureEvent {
  readonly type: "reasoning-signature";
  readonly index: number;
  readonly signature: string;
}

export interface StreamReasoningEvent {
  readonly type: "reasoning";
  readonly id: string;
  readonly encryptedContent: string;
}

export interface StreamUsageEvent {
  readonly type: "usage";
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly cachedPromptTokens?: number;
}

export interface StreamErrorEvent {
  readonly type: "error";
  readonly code: string;
  readonly message: string;
}

export type NormalizedStreamEvent =
  | StreamTextEvent
  | StreamToolCallEvent
  | StreamToolCallStartEvent
  | StreamToolCallArgumentsEvent
  | StreamContentBlockEndEvent
  | StreamReasoningStartEvent
  | StreamReasoningDeltaEvent
  | StreamReasoningSignatureEvent
  | StreamReasoningEvent
  | StreamUsageEvent
  | StreamErrorEvent;

const OpenAiWireEvent = Schema.Union([
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
export function decodeProviderEvent(
  provider: OAuthProvider,
  data: string,
): NormalizedStreamEvent | null {
  try {
    const json = JSON.parse(data);
    if (provider === "openai") {
      return Option.match(Schema.decodeUnknownOption(OpenAiWireEvent)(json), {
        onNone: () => null,
        onSome: (event): NormalizedStreamEvent | null => {
          if (event.type === "response.output_text.delta")
            return { type: "text", text: event.delta };
          if (event.type === "response.completed")
            return {
              type: "usage",
              promptTokens: event.response.usage.input_tokens,
              completionTokens: event.response.usage.output_tokens,
              ...optionalProperty(
                "cachedPromptTokens",
                event.response.usage.input_tokens_details?.cached_tokens,
              ),
            };
          if (event.type === "response.failed")
            return {
              type: "error",
              code: event.response.error.code ?? "response_failed",
              message: event.response.error.message,
            };
          if (event.type === "error")
            return {
              type: "error",
              code: event.code ?? "provider_error",
              message: event.message,
            };
          if (event.item.type === "reasoning")
            return {
              type: "reasoning",
              id: event.item.id,
              encryptedContent: event.item.encrypted_content,
            };
          const item = event.item;
          return Option.match(decodeToolArguments(item.arguments), {
            onNone: () => null,
            onSome: (argumentsValue) => ({
              type: "tool-call",
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
          return { type: "text", text: event.delta.text };
        if (event.type === "message_start")
          return {
            type: "usage",
            promptTokens: event.message.usage.input_tokens,
            ...optionalProperty("cachedPromptTokens", event.message.usage.cache_read_input_tokens),
          };
        if (event.type === "message_delta")
          return { type: "usage", completionTokens: event.usage.output_tokens };
        if (event.type === "error")
          return {
            type: "error",
            code: event.error.type,
            message: event.error.message,
          };
        if (event.type === "content_block_start" && event.content_block.type === "tool_use")
          return {
            type: "tool-call-start",
            index: event.index,
            id: event.content_block.id,
            name: event.content_block.name,
          };
        if (event.type === "content_block_start" && event.content_block.type === "thinking")
          return { type: "reasoning-start", index: event.index };
        if (event.type === "content_block_delta" && event.delta.type === "input_json_delta")
          return {
            type: "tool-call-arguments",
            index: event.index,
            delta: event.delta.partial_json,
          };
        if (event.type === "content_block_delta" && event.delta.type === "thinking_delta")
          return {
            type: "reasoning-delta",
            index: event.index,
            delta: event.delta.thinking,
          };
        if (event.type === "content_block_delta" && event.delta.type === "signature_delta")
          return {
            type: "reasoning-signature",
            index: event.index,
            signature: event.delta.signature,
          };
        if (event.type === "content_block_stop")
          return { type: "content-block-end", index: event.index };
        return null;
      },
    });
  } catch {
    return null;
  }
}
