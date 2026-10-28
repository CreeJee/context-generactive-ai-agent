import { Console, Data, Effect, Layer, ManagedRuntime } from "effect";
import { storedOAuthProfiles } from "./stored-profiles.ts";
import { nodePlatformLayer } from "../src/runtime/node-platform.ts";
import { anthropicSubscriptionUsageProbe } from "../src/oauth/subscription-usage-probe.ts";
import { OAuthKeychain } from "../src/oauth/validation-harness.ts";

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
  // A stored profile id is always a valid keychain slot id.
  const store = yield* Effect.orDie((yield* OAuthKeychain).profileStore(profile.id));
  const probe = yield* anthropicSubscriptionUsageProbe({ store }).pipe(
    Effect.map((result) => ({ outcome: "response", ...result })),
    Effect.catchTag("OAuthHarnessError", (error) =>
      Effect.succeed({
        outcome: "error",
        code: error.code,
        status: error.status,
        operation: error.operation,
        credentialStage: error.credentialStage,
        transportCode: error.transportCode,
      }),
    ),
  );
  yield* Console.log({ profile, ...probe });
});

const runtime = ManagedRuntime.make(
  OAuthKeychain.keychain.pipe(Layer.provideMerge(nodePlatformLayer)),
);
await runtime.runPromise(program).finally(() => runtime.dispose());
