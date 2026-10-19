import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { OAuthProfileRejected } from "memory-agent";
import { accountLogin, answerAccountFailures } from "./account-failures";
import { answerDefect } from "./http";

const answered = (response: Response) =>
  Effect.map(
    Effect.promise(() => response.text()),
    (body) => ({ status: response.status, body }),
  );

describe("account route failures", () => {
  it.effect("answers the login manager's typed rejection by its reason", () =>
    Effect.gen(function* () {
      const response = yield* accountLogin("start", () =>
        Promise.reject(OAuthProfileRejected.make({ reason: "oauth_profile_in_use" })),
      ).pipe(Effect.as(Response.json({})), answerAccountFailures);
      expect(yield* answered(response)).toEqual({
        status: 409,
        body: '{"error":"oauth_profile_in_use"}',
      });
    }),
  );

  it.effect("answers an unknown rejection and a defect with fixed codes, never their text", () =>
    Effect.gen(function* () {
      const rejected = yield* accountLogin("cancel", () =>
        Promise.reject(new Error("keychain item /Users/someone/token")),
      ).pipe(Effect.as(Response.json({})), answerAccountFailures);
      expect(yield* answered(rejected)).toEqual({
        status: 500,
        body: '{"error":"account_action_failed"}',
      });
      const defect = yield* Effect.die(new Error("SQLITE_CORRUPT /Users/someone/agent.db")).pipe(
        Effect.as(Response.json({})),
        answerDefect,
      );
      expect(yield* answered(defect)).toEqual({ status: 500, body: '{"error":"internal_error"}' });
    }),
  );
});
