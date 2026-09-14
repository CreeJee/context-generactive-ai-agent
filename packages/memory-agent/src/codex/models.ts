import { Context, Data, Effect, Layer, Option, Schema } from "effect";
import { GlobalConfig } from "../config/global-config.ts";
import { CodexAppServer } from "./app-server.ts";

export const CodexModel = Schema.Struct({
  id: Schema.String,
  model: Schema.String,
  displayName: Schema.String,
  hidden: Schema.Boolean,
  isDefault: Schema.Boolean,
  defaultReasoningEffort: Schema.String,
  supportedReasoningEfforts: Schema.Array(Schema.Struct({ reasoningEffort: Schema.String })),
  /** What the model accepts in user turns. Codex treats a missing list as text and image. */
  inputModalities: Schema.optionalWith(Schema.Array(Schema.String), {
    default: () => ["text", "image"],
  }),
});
export type CodexModel = typeof CodexModel.Type;

const ModelPage = Schema.Struct({
  data: Schema.Array(CodexModel),
  nextCursor: Schema.optional(Schema.NullOr(Schema.String)),
});
type ModelPage = typeof ModelPage.Type;

export class ModelUnavailable extends Data.TaggedError("ModelUnavailable")<{
  readonly model: string;
  readonly reasoningEffort?: string;
}> {}

export interface ModelSelection {
  readonly model: string;
  readonly reasoningEffort: string;
}

const maxPages = 20;
/** Cheapest first, for background calls that run often (reviews, interpretation). */
const effortOrder = ["minimal", "low", "medium", "high", "xhigh"];

const make = Effect.gen(function* () {
  const codex = yield* CodexAppServer;
  const config = yield* GlobalConfig;
  const cheapest = new Map<string, string>();

  /** Every model the signed-in account can use, hidden ones excluded. */
  const list = Effect.gen(function* () {
    const models: CodexModel[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < maxPages; page++) {
      const result: ModelPage = yield* codex.request(
        "model/list",
        { limit: 100, includeHidden: false, cursor },
        ModelPage,
      );
      models.push(...result.data.filter((model) => !model.hidden));
      cursor = result.nextCursor ?? null;
      if (!cursor) break;
    }
    return models;
  });

  return {
    list,

    /** The saved choice. Null until the user picks one; there is no silent default. */
    selected: Effect.map(config.read, (settings): ModelSelection | null =>
      settings.model && settings.reasoningEffort
        ? { model: settings.model, reasoningEffort: settings.reasoningEffort }
        : null,
    ),

    /** Whether the account's copy of a model accepts images (R06: never pretend it read one). */
    acceptsImages: (model: string) =>
      Effect.map(
        list,
        (models) =>
          models
            .find((candidate) => candidate.model === model)
            ?.inputModalities.includes("image") ?? false,
      ),

    /**
     * The selected model at its lowest reasoning effort, for short background calls. Falls back to
     * the selection's own effort when the model list cannot be read.
     */
    cheapestEffort: (selection: ModelSelection) =>
      Effect.gen(function* () {
        const known = cheapest.get(selection.model);
        if (known) return { model: selection.model, reasoningEffort: known };
        const listed = yield* Effect.option(list);
        const efforts = Option.getOrElse(listed, () => [])
          .find((candidate) => candidate.model === selection.model)
          ?.supportedReasoningEfforts.map((option) => option.reasoningEffort);
        const effort =
          effortOrder.find((candidate) => efforts?.includes(candidate)) ??
          selection.reasoningEffort;
        if (efforts) cheapest.set(selection.model, effort);
        return { model: selection.model, reasoningEffort: effort } satisfies ModelSelection;
      }),

    /** Saves a model only if the account offers it now. Never substitutes another model. */
    select: (model: string, reasoningEffort?: string) =>
      Effect.gen(function* () {
        const found = (yield* list).find((candidate) => candidate.model === model);
        if (!found) return yield* new ModelUnavailable({ model });
        const effort = reasoningEffort ?? found.defaultReasoningEffort;
        if (!found.supportedReasoningEfforts.some((option) => option.reasoningEffort === effort))
          return yield* new ModelUnavailable({ model, reasoningEffort: effort });
        yield* config.update({ model, reasoningEffort: effort });
        return { model, reasoningEffort: effort } satisfies ModelSelection;
      }),
  };
});

/** Models offered to the signed-in ChatGPT account, and the user's saved choice. */
export class CodexModels extends Context.Tag("memory-agent/CodexModels")<
  CodexModels,
  Effect.Effect.Success<typeof make>
>() {
  static readonly layer = Layer.effect(CodexModels, make);
}
