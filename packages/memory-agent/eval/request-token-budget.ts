import { Function as EffectFunction } from "effect";
import { Schema } from "effect";
import { encodingForModel, getEncoding, getEncodingNameForModel, type Tiktoken } from "js-tiktoken";

type KnownModel = Parameters<typeof encodingForModel>[0];

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

const estimateRequestTokensBody = (
  serializedRequest: string,
  model: string,
): RequestTokenEstimate => {
  let encoding: Parameters<typeof getEncoding>[0] = "o200k_base";
  let fallback = true;
  try {
    // SAFETY: the library checks this runtime model string against its supported mapping and
    // throws on an unknown catalog id; the catch below selects the explicit fallback.
    encoding = getEncodingNameForModel(model as KnownModel);
    fallback = false;
  } catch {
    // Unknown model: use the o200k_base encoding as an approximation, never as billed usage.
  }
  return {
    estimatedTokens: encoderFor(encoding).encode(serializedRequest).length,
    encoding,
    fallback,
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
