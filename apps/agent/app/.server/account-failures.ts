import type { Cause } from "effect";
import { Effect, Schema } from "effect";
import { OAuthHarnessError, OAuthProfileRejected, OAuthProfileStoreFailed } from "memory-agent";

/**
 * The account login manager's Promise rejected with something other than its own typed failures.
 * Only the operation is kept; the rejection can hold keychain or provider text.
 */
export class AccountLoginFailed extends Schema.TaggedError<AccountLoginFailed>()(
  "AccountLoginFailed",
  { operation: Schema.Literals(["start", "cancel", "settle"]) },
) {}

const isManagerFailure = Schema.is(
  Schema.Union([OAuthProfileRejected, OAuthProfileStoreFailed, OAuthHarnessError]),
);

/**
 * Runs one of the account login manager's Promise operations. The manager rejects with its typed
 * failure, which is recovered here so the route can answer it by tag.
 */
export const accountLogin = <A>(
  operation: AccountLoginFailed["operation"],
  run: () => Promise<A>,
) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => (isManagerFailure(cause) ? cause : AccountLoginFailed.make({ operation })),
  });

/** Every expected failure the subscription account routes answer. */
export type AccountRouteFailure =
  | OAuthProfileRejected
  | OAuthProfileStoreFailed
  | OAuthHarnessError
  | AccountLoginFailed
  /** The only other promise these routes await is reading the request body. */
  | Cause.UnknownError;

const reply = (status: number, error: string) =>
  Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });

/**
 * The response for an expected account failure, chosen by tag and reason. Keychain, database and
 * provider causes never leave the server.
 */
export const accountFailureResponse = (failure: AccountRouteFailure): Response => {
  switch (failure._tag) {
    case "OAuthProfileRejected":
      switch (failure.reason) {
        case "invalid_oauth_profile":
          return reply(400, failure.reason);
        case "oauth_profile_not_found":
          return reply(404, failure.reason);
        case "oauth_profile_missing_credential":
        case "oauth_profile_removing":
        case "oauth_profile_in_use":
        case "oauth_profile_conflicting_credential":
        case "oauth_profile_copy_unverified":
          return reply(409, failure.reason);
      }
    case "OAuthProfileStoreFailed":
      return reply(503, "account_store_unavailable");
    case "OAuthHarnessError":
      switch (failure.code) {
        case "login_in_progress":
          return reply(409, failure.code);
        default:
          return reply(502, "account_login_failed");
      }
    case "AccountLoginFailed":
      return reply(500, "account_action_failed");
    case "UnknownError":
      return reply(400, "invalid_json");
  }
};

/** Answers each expected failure of an account route; a failure outside the table fails to type. */
export const answerAccountFailures = <A, E extends AccountRouteFailure, R>(
  effect: Effect.Effect<A, E, R>,
) => Effect.catch(effect, (failure) => Effect.succeed(accountFailureResponse(failure)));
