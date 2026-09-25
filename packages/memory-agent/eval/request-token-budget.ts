import { encodingForModel, getEncoding, getEncodingNameForModel } from "js-tiktoken";

type KnownModel = Parameters<typeof encodingForModel>[0];

/** A pre-request estimate of the serialized subscription payload, not provider-reported usage. */
export interface RequestTokenEstimate {
  readonly estimatedTokens: number;
  readonly encoding: string;
  readonly fallback: boolean;
}

const encoders = new Map<string, ReturnType<typeof getEncoding>>();
const encoderFor = (name: Parameters<typeof getEncoding>[0]) => {
  let encoder = encoders.get(name);
  if (!encoder) {
    encoder = getEncoding(name);
    encoders.set(name, encoder);
  }
  return encoder;
};

export const estimateRequestTokens = (
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

/** A conservative pilot stop, not a guarantee about server-side tokens or cache hits. */
export const exceedsRequestTokenBudget = (
  estimate: RequestTokenEstimate,
  maxEstimatedTokens: number,
  margin = 1.25,
) => Math.ceil(estimate.estimatedTokens * margin) > maxEstimatedTokens;
