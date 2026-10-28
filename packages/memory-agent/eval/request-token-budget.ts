import { Function as EffectFunction, Struct } from "effect";
import { Option, Schema } from "effect";
import {
  getEncoding,
  getEncodingNameForModel,
  type Tiktoken,
  type TiktokenModel,
} from "js-tiktoken";

/**
 * Every model id js-tiktoken maps to an encoding. The library exports the list only as a type,
 * so it is spelled out here; `satisfies` fails the build when an upgrade adds or drops an id.
 */
const tiktokenModels = {
  "davinci-002": true,
  "babbage-002": true,
  "text-davinci-003": true,
  "text-davinci-002": true,
  "text-davinci-001": true,
  "text-curie-001": true,
  "text-babbage-001": true,
  "text-ada-001": true,
  davinci: true,
  curie: true,
  babbage: true,
  ada: true,
  "code-davinci-002": true,
  "code-davinci-001": true,
  "code-cushman-002": true,
  "code-cushman-001": true,
  "davinci-codex": true,
  "cushman-codex": true,
  "text-davinci-edit-001": true,
  "code-davinci-edit-001": true,
  "text-embedding-ada-002": true,
  "text-embedding-3-small": true,
  "text-embedding-3-large": true,
  "text-similarity-davinci-001": true,
  "text-similarity-curie-001": true,
  "text-similarity-babbage-001": true,
  "text-similarity-ada-001": true,
  "text-search-davinci-doc-001": true,
  "text-search-curie-doc-001": true,
  "text-search-babbage-doc-001": true,
  "text-search-ada-doc-001": true,
  "code-search-babbage-code-001": true,
  "code-search-ada-code-001": true,
  gpt2: true,
  "gpt-3.5-turbo": true,
  "gpt-35-turbo": true,
  "gpt-3.5-turbo-0301": true,
  "gpt-3.5-turbo-0613": true,
  "gpt-3.5-turbo-1106": true,
  "gpt-3.5-turbo-0125": true,
  "gpt-3.5-turbo-16k": true,
  "gpt-3.5-turbo-16k-0613": true,
  "gpt-3.5-turbo-instruct": true,
  "gpt-3.5-turbo-instruct-0914": true,
  "gpt-4": true,
  "gpt-4-0314": true,
  "gpt-4-0613": true,
  "gpt-4-32k": true,
  "gpt-4-32k-0314": true,
  "gpt-4-32k-0613": true,
  "gpt-4-turbo": true,
  "gpt-4-turbo-2024-04-09": true,
  "gpt-4-turbo-preview": true,
  "gpt-4-1106-preview": true,
  "gpt-4-0125-preview": true,
  "gpt-4-vision-preview": true,
  "gpt-4o": true,
  "gpt-4o-2024-05-13": true,
  "gpt-4o-2024-08-06": true,
  "gpt-4o-2024-11-20": true,
  "gpt-4o-mini-2024-07-18": true,
  "gpt-4o-mini": true,
  "gpt-4o-search-preview": true,
  "gpt-4o-search-preview-2025-03-11": true,
  "gpt-4o-mini-search-preview": true,
  "gpt-4o-mini-search-preview-2025-03-11": true,
  "gpt-4o-audio-preview": true,
  "gpt-4o-audio-preview-2024-12-17": true,
  "gpt-4o-audio-preview-2024-10-01": true,
  "gpt-4o-mini-audio-preview": true,
  "gpt-4o-mini-audio-preview-2024-12-17": true,
  o1: true,
  "o1-2024-12-17": true,
  "o1-mini": true,
  "o1-mini-2024-09-12": true,
  "o1-preview": true,
  "o1-preview-2024-09-12": true,
  "o1-pro": true,
  "o1-pro-2025-03-19": true,
  o3: true,
  "o3-2025-04-16": true,
  "o3-mini": true,
  "o3-mini-2025-01-31": true,
  "o4-mini": true,
  "o4-mini-2025-04-16": true,
  "chatgpt-4o-latest": true,
  "gpt-4o-realtime": true,
  "gpt-4o-realtime-preview-2024-10-01": true,
  "gpt-4o-realtime-preview-2024-12-17": true,
  "gpt-4o-mini-realtime-preview": true,
  "gpt-4o-mini-realtime-preview-2024-12-17": true,
  "gpt-4.1": true,
  "gpt-4.1-2025-04-14": true,
  "gpt-4.1-mini": true,
  "gpt-4.1-mini-2025-04-14": true,
  "gpt-4.1-nano": true,
  "gpt-4.1-nano-2025-04-14": true,
  "gpt-4.5-preview": true,
  "gpt-4.5-preview-2025-02-27": true,
  "gpt-5": true,
  "gpt-5-2025-08-07": true,
  "gpt-5-nano": true,
  "gpt-5-nano-2025-08-07": true,
  "gpt-5-mini": true,
  "gpt-5-mini-2025-08-07": true,
  "gpt-5-chat-latest": true,
} satisfies Record<TiktokenModel, true>;
const KnownModel = Schema.Literals(Struct.keys(tiktokenModels));

/** A pre-request estimate of the serialized subscription payload, not provider-reported usage. */
export interface RequestTokenEstimate {
  readonly estimatedTokens: number;
  readonly encoding: string;
  readonly fallback: boolean;
}

type EncodingName = Parameters<typeof getEncoding>[0];
/** Each encoding is built once, on first use: building one reads its whole rank table. */
const encoders: Partial<Record<EncodingName, Tiktoken>> = {};
const encoderFor = (name: EncodingName) => (encoders[name] ??= getEncoding(name));

/** The encoding js-tiktoken maps a catalog model id to; none for an id it does not know. */
const knownEncoding = (model: string): Option.Option<EncodingName> =>
  Option.map(Option.liftPredicate(model, Schema.is(KnownModel)), getEncodingNameForModel);

const estimateRequestTokensBody = (
  serializedRequest: string,
  model: string,
): RequestTokenEstimate => {
  const known = knownEncoding(model);
  // Unknown model: use the o200k_base encoding as an approximation, never as billed usage.
  const encoding = Option.getOrElse(known, (): EncodingName => "o200k_base");
  return {
    estimatedTokens: encoderFor(encoding).encode(serializedRequest).length,
    encoding,
    fallback: Option.isNone(known),
  };
};
export const estimateRequestTokens: {
  (model: string): (serializedRequest: string) => ReturnType<typeof estimateRequestTokensBody>;
} & typeof estimateRequestTokensBody = EffectFunction.dual(2, estimateRequestTokensBody);

/** A conservative pilot stop, not a guarantee about server-side tokens or cache hits. */
const exceedsRequestTokenBudgetBody = (
  estimate: RequestTokenEstimate,
  maxEstimatedTokens: number,
  margin = 1.25,
) => Math.ceil(estimate.estimatedTokens * margin) > maxEstimatedTokens;

export const exceedsRequestTokenBudget: {
  (estimate: RequestTokenEstimate, maxEstimatedTokens: number): boolean;
  (estimate: RequestTokenEstimate, maxEstimatedTokens: number, margin: number): boolean;
  (maxEstimatedTokens: number): (estimate: RequestTokenEstimate) => boolean;
  (maxEstimatedTokens: number, margin: number): (estimate: RequestTokenEstimate) => boolean;
} = EffectFunction.dual(
  (args) => !Schema.is(Schema.Finite)(args[0]),
  exceedsRequestTokenBudgetBody,
);
