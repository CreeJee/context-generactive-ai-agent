import { Effect, Schema } from "effect";

/** Used when the server never reports the model's real context window. */
export const OPENAI_COMPATIBLE_DEFAULT_CONTEXT_WINDOW = 32_000;

// Optional in the encoded payload, but always present after decoding: the key-default
// keeps `Type` required so consumers never have to re-guard a value that cannot be absent.
export const OpenAICompatibleContextWindow = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(100_000_000),
).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(OPENAI_COMPATIBLE_DEFAULT_CONTEXT_WINDOW)));

export const CompatibleReasoning = Schema.Struct({
  source: Schema.Literal("lm-studio"),
  model: Schema.NonEmptyString,
  options: Schema.Array(Schema.NonEmptyString),
  default: Schema.NonEmptyString,
});

const connectionFields = {
  baseUrl: Schema.NonEmptyString,
  model: Schema.NonEmptyString,
  contextWindow: OpenAICompatibleContextWindow,
  outputBudget: Schema.Int,
  toolCalling: Schema.Boolean,
};
export const OpenAICompatibleConfiguration = Schema.Struct({
  ...connectionFields,
  reasoning: Schema.optional(CompatibleReasoning),
});
export type OpenAICompatibleConfiguration = typeof OpenAICompatibleConfiguration.Type;
export const OpenAICompatibleUpdate = Schema.Struct({
  ...connectionFields,
  apiKey: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
});
export type OpenAICompatibleUpdate = typeof OpenAICompatibleUpdate.Type;
export interface OpenAICompatibleStatus {
  readonly configuration: OpenAICompatibleConfiguration | null;
  readonly configured: boolean;
  readonly hasApiKey: boolean;
}
