import { Context, Data, Effect, Layer, Schema } from "effect";
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

const make = Effect.gen(function* () {
  const codex = yield* CodexAppServer;
  const config = yield* GlobalConfig;

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
