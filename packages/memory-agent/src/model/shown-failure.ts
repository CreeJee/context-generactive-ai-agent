import { Array as Arr, Option, Schema } from "effect";
import type { AiError } from "effect/ai";
import type { ShownFailure } from "../providers/contracts.ts";

/**
 * A failed model call that carries no failure of the app's own, as the user sees it: the kind of
 * failure in the app's words. A provider's description can hold its own text and the request URL.
 */
const reasonText = {
  RateLimitError: "The provider is limiting requests. Try again shortly.",
  QuotaExhaustedError: "The provider account has no quota left.",
  AuthenticationError: "The provider did not accept the credentials.",
  ContentPolicyError: "The provider refused the request under its content policy.",
  InvalidRequestError: "The provider rejected the request.",
  InternalProviderError: "The provider failed to answer.",
  NetworkError: "The provider could not be reached.",
  InvalidOutputError: "The provider's answer could not be read.",
  StructuredOutputError: "The provider's answer could not be read.",
  UnsupportedSchemaError: "The provider does not accept a tool's schema.",
  UnknownError: "The model request failed.",
  ToolNotFoundError: "The model request failed.",
  ToolParameterValidationError: "The model request failed.",
  InvalidToolResultError: "The model request failed.",
  ToolResultEncodingError: "The model request failed.",
  ToolConfigurationError: "The model request failed.",
  ToolkitRequiredError: "The model request failed.",
  InvalidUserInputError: "The model request failed.",
} satisfies Record<AiError.AiErrorReason["_tag"], string>;

/** A provider's error type or code, kept only when it is a short identifier and not free text. */
const Identifier = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]{1,64}$/));
const ErrorKind = Schema.Struct({
  errorType: Schema.optionalKey(Schema.NullOr(Schema.String)),
  errorCode: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
/**
 * What of a reason names the failure without the provider's text: the response status, and the
 * error type and code the provider's error body gave. OpenAI-compatible clients keep them in the
 * metadata itself or under `openai`.
 */
const decodeProviderFacts = Schema.decodeUnknownOption(
  Schema.Struct({
    http: Schema.optionalKey(
      Schema.Struct({ response: Schema.optionalKey(Schema.Struct({ status: Schema.Int })) }),
    ),
    metadata: Schema.optionalKey(
      Schema.Struct({ openai: Schema.optionalKey(Schema.NullOr(ErrorKind)), ...ErrorKind.fields }),
    ),
  }),
);
const isIdentifier = Schema.is(Identifier);

/**
 * The facts a report needs to tell apart failures that read the same, such as a 400 for a too
 * long request and a 404 for an unknown model: `HTTP 400, exceed_context_size_error`.
 */
const providerFacts = (reason: AiError.AiErrorReason) =>
  Option.match(decodeProviderFacts(reason), {
    onNone: () => [],
    onSome: ({ http, metadata }) => {
      const kinds = [metadata?.openai, metadata].flatMap((kind) =>
        kind === null || kind === undefined ? [] : [kind.errorType, kind.errorCode],
      );
      const status = http?.response?.status;
      return [
        ...(status === undefined ? [] : [`HTTP ${status}`]),
        // llama.cpp repeats the status as its code.
        ...Arr.dedupe(kinds.filter((kind) => isIdentifier(kind) && kind !== String(status))),
      ];
    },
  });

export const shownReason = (error: AiError.AiError): ShownFailure => {
  const facts = providerFacts(error.reason);
  const text = reasonText[error.reason._tag];
  return { message: facts.length === 0 ? text : `${text} (${facts.join(", ")})` };
};
