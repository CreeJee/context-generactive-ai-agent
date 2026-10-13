import { Function as EffectFunction } from "effect";
import { Option, Schema } from "effect";
import { claudeCodeVersion } from "./protocol.ts";

const CLAUDE_CODE_BILLING = `x-anthropic-billing-header: cc_version=${claudeCodeVersion}; cc_entrypoint=sdk-cli; cch=33f85;`;
const CLAUDE_CODE_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

const AnthropicValidationRequestSchema = Schema.Struct({
  model: Schema.optional(Schema.String),
  max_tokens: Schema.optional(Schema.Finite),
  stream: Schema.optional(Schema.Boolean),
  system: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.Unknown)])),
  messages: Schema.optional(Schema.Array(Schema.Unknown)),
  tools: Schema.optional(Schema.Array(Schema.Unknown)),
  tool_choice: Schema.optional(Schema.Unknown),
  output_config: Schema.optional(Schema.Struct({ effort: Schema.String })),
  thinking: Schema.optional(
    Schema.Struct({
      type: Schema.Literal("adaptive"),
      display: Schema.Literal("summarized"),
      block_binding: Schema.optional(
        Schema.Struct({ prefix_mismatch_behavior: Schema.Literal("drop_block") }),
      ),
    }),
  ),
});

const THINKING_BINDING_BETA = "thinking-binding-controls-2026-08-01";

const decodeRequest = Schema.decodeUnknownOption(
  Schema.fromJsonString(AnthropicValidationRequestSchema),
);

const prepareAnthropicValidationBodyBody = (serializedBody: string, sessionId: string) => {
  const decoded = Option.getOrThrowWith(
    decodeRequest(serializedBody),
    () => new Error("invalid_anthropic_request"),
  );

  const deviceId = sessionId.replaceAll("-", "");
  const userId = JSON.stringify({
    device_id: deviceId,
    account_uuid: "unknown-account",
    session_id: sessionId,
  });
  const originalSystem =
    decoded.system === undefined || decoded.system.length === 0
      ? []
      : Array.isArray(decoded.system)
        ? decoded.system
        : [{ type: "text", text: decoded.system }];

  return {
    body: JSON.stringify({
      ...decoded,
      system: [
        { type: "text", text: CLAUDE_CODE_BILLING },
        { type: "text", text: CLAUDE_CODE_IDENTITY },
        ...originalSystem,
      ],
      metadata: { user_id: userId },
    }),
    betas: decoded.thinking?.block_binding === undefined ? [] : [THINKING_BINDING_BETA],
  };
};
export const prepareAnthropicValidationBody: {
  (
    sessionId: string,
  ): (serializedBody: string) => ReturnType<typeof prepareAnthropicValidationBodyBody>;
} & typeof prepareAnthropicValidationBodyBody = EffectFunction.dual(
  2,
  prepareAnthropicValidationBodyBody,
);
