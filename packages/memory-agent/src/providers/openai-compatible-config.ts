import { Effect, Schema } from "effect";

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
  // Decode previous probe caches so the config remains readable; runtime ignores
  // lm-studio entries and the next successful model-list read removes them.
  source: Schema.Literals(["models", "lm-studio"]),
  model: Schema.NonEmptyString,
  options: Schema.Array(Schema.NonEmptyString),
  default: Schema.optional(Schema.NonEmptyString),
});

const connectionFields = {
  baseUrl: Schema.NonEmptyString,
  model: Schema.NonEmptyString,
  contextWindow: OpenAICompatibleContextWindow,
  outputBudget: CompatibleOutputBudget,
  toolCalling: Schema.Boolean,
};
/**
 * One endpoint and one of its models, as a run, test or RRSI client uses them. Also the shape of
 * the single endpoint stored before compatible accounts.
 */
export const OpenAICompatibleConfiguration = Schema.Struct({
  ...connectionFields,
  reasoning: Schema.optional(CompatibleReasoning),
});
export type OpenAICompatibleConfiguration = typeof OpenAICompatibleConfiguration.Type;

/** A model the user registered on an endpoint. The server may not report any of these limits. */
export const CompatibleModel = Schema.Struct({
  id: Schema.NonEmptyString,
  contextWindow: OpenAICompatibleContextWindow,
  outputBudget: CompatibleOutputBudget,
  toolCalling: Schema.Boolean,
  /** Reasoning efforts the endpoint's model list published for this model, when it did. */
  reasoning: Schema.optional(CompatibleReasoning),
});
export type CompatibleModel = typeof CompatibleModel.Type;
export const CompatibleModelInput = Schema.Struct({
  id: Schema.String,
  contextWindow: Schema.Int,
  outputBudget: CompatibleOutputBudget,
  toolCalling: Schema.Boolean,
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

/** Whether the selected endpoint registered this model with tool calling on. */
export const compatibleToolCalling = (
  settings: Parameters<typeof compatibleAccountsOf>[0],
  modelId: string,
) =>
  selectedCompatibleAccount(compatibleAccountsOf(settings))?.models.find(
    (model) => model.id === modelId,
  )?.toolCalling === true;

/** An endpoint's model joined with its connection, or null when it is not registered there. */
export const compatibleEndpointModel = (
  account: CompatibleAccount,
  modelId: string,
): OpenAICompatibleConfiguration | null => {
  const found = account.models.find((model) => model.id === modelId);
  if (found === undefined) return null;
  const { id, ...limits } = found;
  return { ...limits, baseUrl: account.baseUrl, model: id };
};

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
