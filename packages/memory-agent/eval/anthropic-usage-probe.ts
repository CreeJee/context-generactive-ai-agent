import { DatabaseSync } from "node:sqlite";
import { Console, Data, Effect } from "effect";
import { defaultStorageRoot } from "../src/config/storage-root.ts";
import { listOAuthProfiles } from "../src/oauth/accounts.ts";
import { runOAuthNodeEffect } from "../src/oauth/node-runtime.ts";
import { anthropicSubscriptionUsageProbe } from "../src/oauth/subscription-usage-probe.ts";
import {
  createKeychainProfileCredentialStore,
  OAuthHarnessError,
} from "../src/oauth/validation-harness.ts";
import { path } from "../src/runtime/synchronous-path.ts";

// V1 evidence probe (docs/subscription-quota-research.md). Opens the user's app DB read-only, picks
// the single stored Anthropic profile and sends exactly one usage request through app code. Prints
// only secret-free names and statuses: never tokens, emails, response values or the DB path.

class ProbeDatabaseError extends Data.TaggedError("ProbeDatabaseError")<{
  readonly cause: unknown;
}> {}

const emailLike = /[^\s@]+@[^\s@]+/;
const safeLabel = (label: string) => (emailLike.test(label) ? "[email-like label]" : label);

const program = Effect.gen(function* () {
  const profiles = yield* Effect.acquireUseRelease(
    Effect.try({
      try: () => new DatabaseSync(path.join(defaultStorageRoot, "agent.db"), { readOnly: true }),
      catch: (cause) => new ProbeDatabaseError({ cause }),
    }),
    (sqlite) =>
      Effect.try({
        try: () => listOAuthProfiles({ sqlite, provider: "anthropic" }),
        catch: (cause) => new ProbeDatabaseError({ cause }),
      }),
    (sqlite) => Effect.sync(() => sqlite.close()),
  );
  const candidates = profiles.map((profile) => ({
    id: profile.id,
    label: safeLabel(profile.label),
    selected: profile.selected,
  }));
  const [profile] = candidates;
  if (candidates.length !== 1 || profile === undefined)
    return yield* Console.log(
      JSON.stringify({ outcome: "not_called", reason: "candidate_count", candidates }, null, 2),
    );
  const probe = yield* anthropicSubscriptionUsageProbe({
    store: createKeychainProfileCredentialStore(profile.id),
  }).pipe(
    Effect.map((result) => ({ outcome: "response", ...result })),
    Effect.catch((failure) => {
      const error = failure instanceof OAuthHarnessError ? failure : failure.cause;
      return error instanceof OAuthHarnessError
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
  yield* Console.log(JSON.stringify({ profile, ...probe }, null, 2));
});

await runOAuthNodeEffect(program);
