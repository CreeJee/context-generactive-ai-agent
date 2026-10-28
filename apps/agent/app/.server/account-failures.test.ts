import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { OAuthProfileRejected, OAuthProfileStoreFailed } from "memory-agent";
import { answerAccountFailures } from "./account-failures";
import { answerDefect } from "./http";

const answered = (response: Response) =>
  Effect.map(
    Effect.promise(() => response.text()),
    (body) => ({ status: response.status, body }),
  );

describe("account route failures", () => {
  it.effect("answers a typed profile rejection by its reason", () =>
    Effect.gen(function* () {
      const response = yield* Effect.fail(
        OAuthProfileRejected.make({ reason: "oauth_profile_in_use" }),
      ).pipe(Effect.as(Response.json({})), answerAccountFailures);
      expect(yield* answered(response)).toEqual({
        status: 409,
        body: '{"error":"oauth_profile_in_use"}',
      });
    }),
  );

  it.effect("answers a keychain failure and a defect with fixed codes, never their text", () =>
    Effect.gen(function* () {
      const rejected = yield* Effect.fail(
        OAuthProfileStoreFailed.make({
          operation: "keychain",
          cause: new Error("keychain item /Users/someone/token"),
        }),
      ).pipe(Effect.as(Response.json({})), answerAccountFailures);
      expect(yield* answered(rejected)).toEqual({
        status: 503,
        body: '{"error":"account_store_unavailable"}',
      });
      const defect = yield* Effect.die(new Error("SQLITE_CORRUPT /Users/someone/agent.db")).pipe(
        Effect.as(Response.json({})),
        answerDefect,
      );
      expect(yield* answered(defect)).toEqual({ status: 500, body: '{"error":"internal_error"}' });
    }),
  );
});
