import { Console, Data, Effect, Schema } from "effect";
import { storedOAuthProfiles } from "./stored-profiles.ts";
import { runOAuthNodeEffect } from "../src/oauth/node-runtime.ts";
import { anthropicSubscriptionUsageProbe } from "../src/oauth/subscription-usage-probe.ts";
import {
  createKeychainProfileCredentialStore,
  OAuthHarnessError,
} from "../src/oauth/validation-harness.ts";

// V1 evidence probe (docs/subscription-quota-research.md). Opens the user's app DB read-only, picks
// the single stored Anthropic profile and sends exactly one usage request through app code. Prints
// only secret-free names and statuses: never tokens, emails, response values or the DB path.

class ProbeDatabaseError extends Data.TaggedError("ProbeDatabaseError")<{
  readonly cause: unknown;
}> {}

const emailLike = /[^\s@]+@[^\s@]+/;
const safeLabel = (label: string) => (emailLike.test(label) ? "[email-like label]" : label);

const program = Effect.gen(function* () {
  const profiles = yield* storedOAuthProfiles("anthropic").pipe(
    Effect.mapError((cause) => new ProbeDatabaseError({ cause })),
  );
  const candidates = profiles.map((profile) => ({
    id: profile.id,
    label: safeLabel(profile.label),
    selected: profile.selected,
  }));
  const [profile] = candidates;
  if (candidates.length !== 1 || profile === undefined)
    return yield* Console.log({ outcome: "not_called", reason: "candidate_count", candidates });
  const probe = yield* anthropicSubscriptionUsageProbe({
    store: createKeychainProfileCredentialStore(profile.id),
  }).pipe(
    Effect.map((result) => ({ outcome: "response", ...result })),
    Effect.catch((failure) => {
      const error = Schema.is(OAuthHarnessError)(failure) ? failure : failure.cause;
      return Schema.is(OAuthHarnessError)(error)
        ? Effect.succeed({
            outcome: "error",
            code: error.code,
            status: error.status,
            operation: error.operation,
            credentialStage: error.credentialStage,
            transportCode: error.transportCode,
          })
        : Effect.fail(failure);
    }),
  );
  yield* Console.log({ profile, ...probe });
});

await runOAuthNodeEffect(program);
