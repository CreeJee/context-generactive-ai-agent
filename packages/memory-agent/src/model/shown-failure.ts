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

export const shownReason = (error: AiError.AiError): ShownFailure => ({
  message: reasonText[error.reason._tag],
});
