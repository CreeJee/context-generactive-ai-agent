import { Function as EffectFunction } from "effect";
import { Option, Schema } from "effect";
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

const knownEncoding = Option.liftThrowable((model: string): EncodingName =>
  // SAFETY: the library checks this runtime model string against its supported mapping and
  // throws on an unknown catalog id; liftThrowable turns that throw into the explicit fallback.
  getEncodingNameForModel(model as KnownModel),
);

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
