import { Option, Schema } from "effect";

const CLAUDE_CODE_BILLING =
  "x-anthropic-billing-header: cc_version=2.1.257; cc_entrypoint=sdk-cli; cch=33f85;";
const CLAUDE_CODE_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

const AnthropicValidationRequestSchema = Schema.Struct({
  model: Schema.optional(Schema.String),
  max_tokens: Schema.optional(Schema.Number),
  stream: Schema.optional(Schema.Boolean),
  system: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.Unknown)])),
  messages: Schema.optional(Schema.Array(Schema.Unknown)),
  tools: Schema.optional(Schema.Array(Schema.Unknown)),
  tool_choice: Schema.optional(Schema.Unknown),
});

const decodeRequest = Schema.decodeUnknownOption(
  Schema.fromJsonString(AnthropicValidationRequestSchema),
);

export const prepareAnthropicValidationBody = (
  serializedBody: string,
  sessionId: string,
): string => {
  const decoded = Option.getOrThrowWith(decodeRequest(serializedBody), () => {
    return new Error("invalid_anthropic_request");
  });

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

  return JSON.stringify({
    ...decoded,
    system: [
      { type: "text", text: CLAUDE_CODE_BILLING },
      { type: "text", text: CLAUDE_CODE_IDENTITY },
      ...originalSystem,
    ],
    metadata: { user_id: userId },
  });
};
