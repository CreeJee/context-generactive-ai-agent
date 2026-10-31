import { Effect } from "effect";
import type { OAuthHarnessError, OAuthProfileRejected } from "memory-agent";

/**
 * The refusal for each expected failure of a subscription account change, by tag; handlers pass
 * the table to `Effect.catchTags`. A rejected profile is refused with its reason. Keychain,
 * database and provider causes never leave the server.
 */
export const accountRefusal = {
  OAuthProfileRejected: ({ reason }: OAuthProfileRejected) => Effect.fail({ error: reason }),
  OAuthProfileStoreFailed: () => Effect.fail({ error: "account_store_unavailable" } as const),
  OAuthHarnessError: ({ code }: OAuthHarnessError) =>
    Effect.fail({
      error: code === "login_in_progress" ? code : "account_login_failed",
    } as const),
};
