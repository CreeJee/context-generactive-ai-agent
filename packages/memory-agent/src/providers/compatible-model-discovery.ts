import { Result, Function as EffectFunction } from "effect";
import { isTruthy } from "../truthy.ts";
import { Option, Schema } from "effect";
import { CompatibleReasoning } from "./openai-compatible-config.ts";

const ReasoningMetadata = Schema.Struct({
  allowed_options: Schema.Array(Schema.NonEmptyString),
  default: Schema.optional(Schema.NonEmptyString),
});
export const CompatibleModelPage = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.NonEmptyString,
      supported_parameters: Schema.optional(Schema.Unknown),
      capabilities: Schema.optional(Schema.Unknown),
    }),
  ),
});
const isChatReasoningEffort = Schema.is(
  Schema.Literals(["none", "minimal", "low", "medium", "high", "xhigh"]),
);
/** Only explicit model-list extensions establish reasoning controls. */
export const readCompatibleReasoning: {
  (
    page: typeof CompatibleModelPage.Type,
  ): (model: string) => ReturnType<typeof readCompatibleReasoningBody>;
} & typeof readCompatibleReasoningBody = EffectFunction.dual(2, readCompatibleReasoningBody);
function readCompatibleReasoningBody(
  model: string,
  page: typeof CompatibleModelPage.Type,
): typeof CompatibleReasoning.Type | undefined {
  const entry = page.data.find((candidate) => candidate.id === model);
  const capabilities = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.Struct({ reasoning: Schema.optional(ReasoningMetadata) }))(
      entry?.capabilities,
    ),
  );
  const metadata = capabilities?.reasoning;
  if (isTruthy(metadata)) {
    // Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
    const reasoning = EffectFunction.flow(
      Schema.decodeResult(CompatibleReasoning),
      Result.getOrThrow,
    )({
      source: "models",
      model,
      options: [...new Set(metadata.allowed_options.filter(isChatReasoningEffort))],
      default: metadata.default,
    });
    return reasoning;
  }
  const parameters = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.Array(Schema.String))(entry?.supported_parameters),
  );
  if (parameters !== undefined) {
    const supportsReasoning = parameters.some(
      (parameter) => parameter === "reasoning" || parameter === "reasoning_effort",
    );
    // Parameter support does not enumerate valid levels or establish their wire mapping.
    return supportsReasoning ? { source: "models", model, options: [] } : undefined;
  }
  return undefined;
}
