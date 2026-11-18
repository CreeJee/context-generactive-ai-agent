import { Array as EffectArray, Effect, Function as EffectFunction, Option, Schema } from "effect";
import type { ProviderModel } from "./contracts.ts";

/** Used when the server never reports the model's real context window. */
export const OPENAI_COMPATIBLE_DEFAULT_CONTEXT_WINDOW = 32_000;

/**
 * The `max_tokens` a request sends; `null` sends none, so the server's own limit applies. Reasoning
 * models count their reasoning against it.
 */
export const CompatibleOutputBudget = Schema.NullOr(Schema.Int);

/** Tokens a request keeps free for the reply; none when the output is unlimited. */
export const reservedOutput = (outputBudget: number | null) => outputBudget ?? 0;

/** The request's `max_tokens`, absent when the output is unlimited. */
export const maxTokensOf = (outputBudget: number | null) =>
  outputBudget === null ? {} : { max_tokens: outputBudget };

// Optional in the encoded payload, but always present after decoding: the key-default
// keeps `Type` required so consumers never have to re-guard a value that cannot be absent.
export const OpenAICompatibleContextWindow = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(100_000_000),
).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(OPENAI_COMPATIBLE_DEFAULT_CONTEXT_WINDOW)));

export const CompatibleReasoning = Schema.Struct({
  source: Schema.Literal("models"),
  model: Schema.NonEmptyString,
  options: Schema.Array(Schema.NonEmptyString),
  default: Schema.optional(Schema.NonEmptyString),
});

/**
 * Reasoning efforts the user wrote for a model: the `reasoning_effort` values the picker offers as
 * written, and the one a new conversation starts on. `default` absent starts on the server's own.
 */
export const CompatibleReasoningLevels = Schema.Struct({
  options: Schema.Array(Schema.NonEmptyString),
  default: Schema.optional(Schema.NonEmptyString),
});
export type CompatibleReasoningLevels = typeof CompatibleReasoningLevels.Type;

/** The efforts a model offers when neither the user nor the server named any (decisions.md 2026-11-18). */
export const standardReasoningEfforts = ["none", "low", "medium", "high"] as const;

/** Where a model's offered efforts come from: the user's list, the server's, or the standard one. */
export type ReasoningEffortsSource = NonNullable<ProviderModel["reasoningEffortsSource"]>;

/** The efforts a model offers, the one a conversation starts on, and where they come from. */
export interface OfferedReasoning extends CompatibleReasoningLevels {
  readonly source: ReasoningEffortsSource;
}

/** A model's published and user-written reasoning efforts, as accounts store them. */
interface ReasoningSettings {
  readonly reasoning?: typeof CompatibleReasoning.Type | undefined;
  readonly userReasoning?: CompatibleReasoningLevels | undefined;
}

/**
 * The efforts a model offers: the user's list, else the server's non-empty one, else the standard
 * efforts, which no one said the server accepts.
 */
export const offeredReasoning: {
  (modelId: string): (model: ReasoningSettings) => OfferedReasoning;
} & typeof offeredReasoningBody = EffectFunction.dual(2, offeredReasoningBody);
function offeredReasoningBody(model: ReasoningSettings, modelId: string): OfferedReasoning {
  return Option.fromUndefinedOr(model.userReasoning).pipe(
    Option.map((levels): OfferedReasoning => ({ source: "user", ...levels })),
    Option.orElse(() =>
      Option.fromUndefinedOr(model.reasoning).pipe(
        Option.filter((published) => published.model === modelId && published.options.length > 0),
        Option.map(({ source: _source, model: _model, ...levels }): OfferedReasoning => ({
          source: "server",
          ...levels,
        })),
      ),
    ),
    Option.getOrElse((): OfferedReasoning => ({
      source: "standard",
      options: standardReasoningEfforts,
    })),
  );
}

const connectionFields = {
  baseUrl: Schema.NonEmptyString,
  model: Schema.NonEmptyString,
  contextWindow: OpenAICompatibleContextWindow,
  outputBudget: CompatibleOutputBudget,
  toolCalling: Schema.Boolean,
};

/** How a model's image input setting was set: the server's model list, or the user. */
export const CompatibleImageInputSource = Schema.Literals(["models", "user"]);
const imageInputFields = {
  /** The model accepts image parts. The server's model list suggested it or the user turned it on. */
  imageInput: Schema.optionalKey(Schema.Boolean),
  /** Where the stored `imageInput` came from; a list-derived one is updated by the next list read. */
  imageInputSource: Schema.optionalKey(CompatibleImageInputSource),
};
const reasoningFields = {
  /** Reasoning efforts the endpoint's model list published, or its known server accepts, for this model. */
  reasoning: Schema.optional(CompatibleReasoning),
  /** Reasoning efforts the user wrote; they replace the published ones, and model list reads keep them. */
  userReasoning: Schema.optionalKey(CompatibleReasoningLevels),
};
/**
 * One endpoint and one of its models, as a run or test uses them. Also the shape of
 * the single endpoint stored before compatible accounts.
 */
export const OpenAICompatibleConfiguration = Schema.Struct({
  ...connectionFields,
  ...imageInputFields,
  ...reasoningFields,
});
export type OpenAICompatibleConfiguration = typeof OpenAICompatibleConfiguration.Type;

/** A model the user registered on an endpoint. The server may not report any of these limits. */
export const CompatibleModel = Schema.Struct({
  id: Schema.NonEmptyString,
  contextWindow: OpenAICompatibleContextWindow,
  outputBudget: CompatibleOutputBudget,
  toolCalling: Schema.Boolean,
  ...imageInputFields,
  ...reasoningFields,
});
export type CompatibleModel = typeof CompatibleModel.Type;
export const CompatibleModelInput = Schema.Struct({
  id: Schema.String,
  contextWindow: Schema.Int,
  outputBudget: CompatibleOutputBudget,
  toolCalling: Schema.Boolean,
  // Absent leaves the choice unset, so the model list may still suggest it; the UI always
  // sends it when the user touched the setting.
  imageInput: Schema.optionalKey(Schema.Boolean),
  // Absent keeps the user's list; null removes it, so the published or standard efforts apply.
  userReasoning: Schema.optionalKey(Schema.NullOr(CompatibleReasoningLevels)),
});
export type CompatibleModelInput = typeof CompatibleModelInput.Type;

/** Where an endpoint is and how to authenticate. `apiKey` absent keeps the stored key. */
export const CompatibleConnectionInput = Schema.Struct({
  baseUrl: Schema.String,
  apiKey: Schema.optional(Schema.NullOr(Schema.String)),
});
export type CompatibleConnectionInput = typeof CompatibleConnectionInput.Type;

/** The endpoint read from the single pre-account configuration keeps this ID and keychain entry. */
export const LEGACY_COMPATIBLE_ACCOUNT_ID = "default";
export const LEGACY_COMPATIBLE_CREDENTIAL_ENTRY = "openai-compatible-api-key";

/**
 * One compatible endpoint registered like a subscription account: a name and a credential. Its
 * models are a catalog under it, the way a subscription account has a vendor catalog.
 */
export const CompatibleAccount = Schema.Struct({
  id: Schema.NonEmptyString,
  label: Schema.NonEmptyString,
  baseUrl: Schema.NonEmptyString,
  /** Keychain entry holding the key; secrets never go in the config file. */
  credentialEntry: Schema.NonEmptyString,
  models: Schema.Array(CompatibleModel),
});
export type CompatibleAccount = typeof CompatibleAccount.Type;
export const CompatibleAccounts = Schema.Struct({
  /** The endpoint new compatible runs use; absent until an endpoint is added. */
  selected: Schema.optional(Schema.NonEmptyString),
  accounts: Schema.Array(CompatibleAccount),
});
export type CompatibleAccounts = typeof CompatibleAccounts.Type;

export const compatibleHostLabel = (baseUrl: string) =>
  URL.canParse(baseUrl) ? new URL(baseUrl).host : baseUrl;

/**
 * Registered endpoints. A config written before accounts holds one `openaiCompatible` endpoint,
 * read here as the selected account with its one model until the next account write replaces it.
 */
export function compatibleAccountsOf(settings: {
  readonly openaiCompatible?: OpenAICompatibleConfiguration | undefined;
  readonly compatibleAccounts?: CompatibleAccounts | undefined;
}): CompatibleAccounts {
  if (settings.compatibleAccounts !== undefined) return settings.compatibleAccounts;
  const legacy = settings.openaiCompatible;
  if (legacy === undefined) return { accounts: [] };
  const { baseUrl, model, ...limits } = legacy;
  return {
    selected: LEGACY_COMPATIBLE_ACCOUNT_ID,
    accounts: [
      {
        id: LEGACY_COMPATIBLE_ACCOUNT_ID,
        label: compatibleHostLabel(baseUrl),
        baseUrl,
        credentialEntry: LEGACY_COMPATIBLE_CREDENTIAL_ENTRY,
        models: [{ id: model, ...limits }],
      },
    ],
  };
}
export const selectedCompatibleAccount = (accounts: CompatibleAccounts) =>
  accounts.accounts.find((account) => account.id === accounts.selected) ?? null;

/** The account and model a compatible choice names. */
export interface CompatibleChoice {
  readonly account: string;
  readonly model: string;
}

/** Whether the chosen endpoint registered the chosen model with tool calling on. */
export const compatibleToolCalling: {
  (choice: CompatibleChoice): (settings: Parameters<typeof compatibleAccountsOf>[0]) => boolean;
} & typeof compatibleToolCallingBody = EffectFunction.dual(2, compatibleToolCallingBody);
function compatibleToolCallingBody(
  settings: Parameters<typeof compatibleAccountsOf>[0],
  choice: CompatibleChoice,
) {
  return (
    compatibleAccountsOf(settings)
      .accounts.find((account) => account.id === choice.account)
      ?.models.find((model) => model.id === choice.model)?.toolCalling === true
  );
}

/** An endpoint's model joined with its connection, or null when it is not registered there. */
export const compatibleEndpointModel: {
  (modelId: string): (account: CompatibleAccount) => OpenAICompatibleConfiguration | null;
} & typeof compatibleEndpointModelBody = EffectFunction.dual(2, compatibleEndpointModelBody);
function compatibleEndpointModelBody(
  account: CompatibleAccount,
  modelId: string,
): OpenAICompatibleConfiguration | null {
  return Option.getOrNull(
    Option.map(
      EffectArray.findFirst(account.models, (model) => model.id === modelId),
      ({ id, imageInputSource: _source, ...limits }) => ({
        ...limits,
        baseUrl: account.baseUrl,
        model: id,
      }),
    ),
  );
}

export const CompatibleAccountStatus = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  baseUrl: Schema.String,
  models: Schema.Array(CompatibleModel),
  hasApiKey: Schema.Boolean,
  selected: Schema.Boolean,
});
export type CompatibleAccountStatus = typeof CompatibleAccountStatus.Type;
export const OpenAICompatibleStatus = Schema.Struct({
  accounts: Schema.Array(CompatibleAccountStatus),
});
export type OpenAICompatibleStatus = typeof OpenAICompatibleStatus.Type;

/** `/api/accounts` for the compatible provider: its endpoints, tagged by connection kind. */
export const CompatibleAccountsView = Schema.TaggedStruct(
  "compatible-endpoint",
  OpenAICompatibleStatus.fields,
);
export type CompatibleAccountsView = typeof CompatibleAccountsView.Type;
