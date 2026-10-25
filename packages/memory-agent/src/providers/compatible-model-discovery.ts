import { Function as EffectFunction } from "effect";
import { Array as EffectArray, Option, Schema } from "effect";
import { optionalProperty } from "../optional-property.ts";
import { CompatibleReasoning } from "./openai-compatible-config.ts";

const ReasoningMetadata = Schema.Struct({
  allowed_options: Schema.Array(Schema.NonEmptyString),
  default: Schema.optional(Schema.NonEmptyString),
});
export const CompatibleModelPage = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.NonEmptyString,
      owned_by: Schema.optional(Schema.Unknown),
      supported_parameters: Schema.optional(Schema.Unknown),
      capabilities: Schema.optional(Schema.Unknown),
    }),
  ),
});
type CompatibleModelEntry = (typeof CompatibleModelPage.Type)["data"][number];
type ReasoningLevels = Omit<typeof CompatibleReasoning.Type, "source" | "model">;

const ChatReasoningEffort = Schema.Literals(["none", "minimal", "low", "medium", "high", "xhigh"]);
const isChatReasoningEffort = Schema.is(ChatReasoningEffort);

/**
 * Servers that name themselves in `owned_by` without publishing levels, and the levels their own
 * source accepts for every model they run (decisions.md 2026-10-25). Strata: `serve/frontend.py`
 * `EFFORT` of Niko1221/Strata.
 */
const KnownServer = Schema.Literals(["strata"]);
const knownServerEfforts = {
  strata: ["none", "low", "medium", "high"],
} satisfies Record<typeof KnownServer.Type, readonly (typeof ChatReasoningEffort.Type)[]>;

const decodeCapabilities = Schema.decodeUnknownOption(
  Schema.Struct({ reasoning: ReasoningMetadata }),
);
const decodeKnownServer = Schema.decodeUnknownOption(KnownServer);
const decodeParameters = Schema.decodeUnknownOption(Schema.Array(Schema.String));

/** The levels the model list publishes for the model. */
const publishedLevels = (entry: CompatibleModelEntry): Option.Option<ReasoningLevels> =>
  Option.map(decodeCapabilities(entry.capabilities), ({ reasoning }) => ({
    options: EffectArray.dedupe(reasoning.allowed_options.filter(isChatReasoningEffort)),
    ...optionalProperty("default", reasoning.default),
  }));

/** The levels a known server's own source fixes, when the model list names that server. */
const knownServerLevels = (entry: CompatibleModelEntry): Option.Option<ReasoningLevels> =>
  Option.map(decodeKnownServer(entry.owned_by), (server) => ({
    options: knownServerEfforts[server],
  }));

/** Parameter support does not enumerate valid levels or establish their wire mapping. */
const parameterSupport = (entry: CompatibleModelEntry): Option.Option<ReasoningLevels> =>
  decodeParameters(entry.supported_parameters).pipe(
    Option.filter((parameters) =>
      parameters.some((parameter) => parameter === "reasoning" || parameter === "reasoning_effort"),
    ),
    Option.as({ options: [] }),
  );

/** Only explicit model-list extensions or a known server's levels establish reasoning controls. */
export const readCompatibleReasoning: {
  (
    page: typeof CompatibleModelPage.Type,
  ): (model: string) => ReturnType<typeof readCompatibleReasoningBody>;
} & typeof readCompatibleReasoningBody = EffectFunction.dual(2, readCompatibleReasoningBody);
function readCompatibleReasoningBody(
  model: string,
  page: typeof CompatibleModelPage.Type,
): typeof CompatibleReasoning.Type | undefined {
  return Option.fromNullishOr(page.data.find((candidate) => candidate.id === model)).pipe(
    Option.flatMap((entry) =>
      publishedLevels(entry).pipe(
        Option.orElse(() => knownServerLevels(entry)),
        Option.orElse(() => parameterSupport(entry)),
      ),
    ),
    Option.map((levels) => ({ source: "models" as const, model, ...levels })),
    Option.getOrUndefined,
  );
}
