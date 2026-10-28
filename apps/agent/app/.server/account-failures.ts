import type { Cause } from "effect";
import { Effect, Match } from "effect";
import type {
  OAuthHarnessError,
  OAuthProfileRejected,
  OAuthProfileStoreFailed,
} from "memory-agent";

/** Every expected failure the subscription account routes answer. */
export type AccountRouteFailure =
  | OAuthProfileRejected
  | OAuthProfileStoreFailed
  | OAuthHarnessError
  /** The only other promise these routes await is reading the request body. */
  | Cause.UnknownError;

const reply = (status: number, error: string) =>
  Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });

/**
 * The response for an expected account failure, chosen by tag and reason. Keychain, database and
 * provider causes never leave the server.
 */
/** The status for each reason an OAuth profile is rejected; the reason itself is the error. */
const oauthProfileStatus: Record<OAuthProfileRejected["reason"], number> = {
  invalid_oauth_profile: 400,
  oauth_profile_not_found: 404,
  oauth_profile_missing_credential: 409,
  oauth_profile_removing: 409,
  oauth_profile_in_use: 409,
  oauth_profile_conflicting_credential: 409,
  oauth_profile_copy_unverified: 409,
};

export const accountFailureResponse = (failure: AccountRouteFailure): Response =>
  Match.valueTags(failure, {
    OAuthProfileRejected: ({ reason }) => reply(oauthProfileStatus[reason], reason),
    OAuthProfileStoreFailed: () => reply(503, "account_store_unavailable"),
    OAuthHarnessError: ({ code }) =>
      code === "login_in_progress" ? reply(409, code) : reply(502, "account_login_failed"),
    UnknownError: () => reply(400, "invalid_json"),
  });

/** Answers each expected failure of an account route; a failure outside the table fails to type. */
export const answerAccountFailures = <A, E extends AccountRouteFailure, R>(
  effect: Effect.Effect<A, E, R>,
) => Effect.catch(effect, (failure) => Effect.succeed(accountFailureResponse(failure)));
