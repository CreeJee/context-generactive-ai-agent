import { Data, Effect, Option, Schema } from "effect";
import { CompatibleReasoning } from "./openai-compatible-config.ts";

const ReasoningMetadata = Schema.Struct({
  allowed_options: Schema.Array(Schema.NonEmptyString),
  default: Schema.optional(Schema.NonEmptyString),
});
export const CompatibleModelPage = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.NonEmptyString,
      owned_by: Schema.optional(Schema.String),
      supported_parameters: Schema.optional(Schema.Unknown),
      capabilities: Schema.optional(Schema.Unknown),
    }),
  ),
});
const LMStudioModels = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      type: Schema.Literals(["llm", "embedding"]),
      key: Schema.NonEmptyString,
      capabilities: Schema.optional(
        Schema.NullOr(Schema.Struct({ reasoning: Schema.optional(ReasoningMetadata) })),
      ),
    }),
  ),
});
const isChatReasoningEffort = Schema.is(
  Schema.Literals(["none", "minimal", "low", "medium", "high", "xhigh"]),
);
type Discovery =
  | { readonly _tag: "Available"; readonly reasoning: typeof CompatibleReasoning.Type | undefined }
  | { readonly _tag: "Unavailable" };
class MetadataUnavailable extends Data.TaggedError("MetadataUnavailable") {}

/** OpenAI has no standard capability schema; read explicit extensions before server probes. */
export const discoverCompatibleReasoning = Effect.fnUntraced(function* (
  baseUrl: string,
  model: string,
  page: typeof CompatibleModelPage.Type,
  key: string | null,
  fetcher: typeof fetch,
): Effect.fn.Return<Discovery> {
  const entry = page.data.find((candidate) => candidate.id === model);
  const capabilities = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.Struct({ reasoning: Schema.optional(ReasoningMetadata) }))(
      entry?.capabilities,
    ),
  );
  const metadata = capabilities?.reasoning;
  if (metadata) {
    const reasoning = Schema.decodeSync(CompatibleReasoning)({
      source: "models",
      model,
      options: [...new Set(metadata.allowed_options.filter(isChatReasoningEffort))],
      default: metadata.default,
    });
    return { _tag: "Available", reasoning };
  }
  const parameters = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.Array(Schema.String))(entry?.supported_parameters),
  );
  if (parameters !== undefined) {
    const supportsReasoning = parameters.some(
      (parameter) => parameter === "reasoning" || parameter === "reasoning_effort",
    );
    // Parameter support does not enumerate valid levels or establish their wire mapping.
    return {
      _tag: "Available",
      reasoning: supportsReasoning ? { source: "models", model, options: [] } : undefined,
    };
  }
  // A documented server hint avoids unrelated native API probes. owned_by otherwise
  // identifies the model owner, so organization_owner is not an LM Studio fingerprint.
  if (entry?.owned_by === "vllm" || new URL(baseUrl).hostname === "openrouter.ai")
    return { _tag: "Available", reasoning: undefined };
  if (!baseUrl.endsWith("/v1")) return { _tag: "Unavailable" };

  // LM Studio exposes no identity in /v1/models. Identify its extension by a bounded,
  // same-server read-only probe and validate its response contract before using it.
  const result = yield* Effect.tryPromise({
    try: async (signal) => {
      const headers = new Headers();
      if (key) headers.set("Authorization", `Bearer ${key}`);
      const response = await fetcher(`${baseUrl.slice(0, -3)}/api/v1/models`, {
        headers,
        signal,
        redirect: "error",
      });
      if (!response.ok) throw new MetadataUnavailable();
      return Schema.decodeUnknownSync(LMStudioModels)(await response.json());
    },
    catch: () => new MetadataUnavailable(),
  }).pipe(Effect.timeout(2000), Effect.option);
  switch (result._tag) {
    case "None":
      return { _tag: "Unavailable" };
    case "Some": {
      const discovered = result.value.models.find(
        (candidate) => candidate.type === "llm" && candidate.key === model,
      )?.capabilities?.reasoning;
      const reasoning =
        discovered?.default && discovered.allowed_options.includes(discovered.default)
          ? Schema.decodeSync(CompatibleReasoning)({
              source: "lm-studio",
              model,
              options: [
                ...new Set(
                  discovered.allowed_options
                    .map((option) => (option === "off" ? "none" : option))
                    .filter(isChatReasoningEffort),
                ),
              ],
              default: discovered.default,
            })
          : undefined;
      return { _tag: "Available", reasoning };
    }
  }
});
