import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { OAuthProfileRejected, OAuthProfileStoreFailed } from "memory-agent";
import { accountRefusal } from "./account-failures";

describe("account failures", () => {
  it.effect("refuses a typed profile rejection with its reason", () =>
    Effect.gen(function* () {
      const refused = yield* Effect.fail(
        OAuthProfileRejected.make({ reason: "oauth_profile_in_use" }),
      ).pipe(
        Effect.catchTags({ OAuthProfileRejected: accountRefusal.OAuthProfileRejected }),
        Effect.flip,
      );
      expect(refused).toStrictEqual({ error: "oauth_profile_in_use" });
    }),
  );

  it.effect("refuses a keychain failure with a fixed code, never its text", () =>
    Effect.gen(function* () {
      const refused = yield* Effect.fail(
        OAuthProfileStoreFailed.make({
          operation: "keychain",
          cause: new Error("keychain item /Users/someone/token"),
        }),
      ).pipe(
        Effect.catchTags({ OAuthProfileStoreFailed: accountRefusal.OAuthProfileStoreFailed }),
        Effect.flip,
      );
      expect(refused).toStrictEqual({ error: "account_store_unavailable" });
    }),
  );
});
