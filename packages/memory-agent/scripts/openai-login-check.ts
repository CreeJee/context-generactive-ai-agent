import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Console, Effect, Layer, Ref, Schema } from "effect";
import { OAuthCheckFailed, OAuthCheckReason } from "./oauth-check-failure.ts";
import { nodePlatformLayer } from "../src/runtime/node-platform.ts";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { runProcess } from "../src/runtime/run-process.ts";
import {
  createSubscriptionOAuthClient,
  OAuthHarnessError,
  type CredentialStore,
  type StoredCredential,
} from "../src/oauth/validation-harness.ts";
import { providerProtocols } from "../src/oauth/protocol.ts";

const program = Effect.gen(function* () {
  // Never touch the app's keychain credential during a one-off login diagnosis.
  const credential = yield* Ref.make<StoredCredential | null>(null);
  const store: CredentialStore = {
    read: () => Ref.get(credential),
    write: (_provider, value) => Ref.set(credential, value),
    remove: () => Ref.set(credential, null),
  };
  const client = yield* createSubscriptionOAuthClient({
    protocol: providerProtocols.openai,
    store,
  });
  // Every exit cancels the login, Ctrl+C included, which closes its callback listener.
  const attempt = yield* Effect.acquireRelease(
    client.startLogin({ timeoutMs: 10 * 60_000 }),
    (started) => started.cancel,
  );
  yield* Console.log("OPENAI_LOGIN_CHECK waiting_for_browser");
  yield* runProcess({ command: "open", args: [attempt.authorizationUrl] }).pipe(
    Effect.mapError(() =>
      OAuthCheckFailed.make({ reason: OAuthCheckReason.cases.browser_open_failed.make({}) }),
    ),
  );
  const result = yield* attempt.completed;
  yield* Effect.when(
    Effect.fail(
      OAuthCheckFailed.make({ reason: OAuthCheckReason.cases.login_not_connected.make({}) }),
    ),
    Effect.succeed(!result.connected),
  );
  yield* Console.log("OPENAI_LOGIN_CHECK passed");
}).pipe(
  Effect.scoped,
  Effect.tapError((error) =>
    Console.error(
      Schema.is(OAuthHarnessError)(error)
        ? `OPENAI_LOGIN_CHECK failed code=${error.code} operation=${error.operation ?? "none"} status=${error.status ?? "none"}`
        : `OPENAI_LOGIN_CHECK failed ${error.message}`,
    ),
  ),
);

// The failure is already printed in the check's own format; the exit code reports it.
Layer.build(nodePlatformLayer).pipe(
  Effect.flatMap((platform) => Effect.provideContext(program, platform)),
  Effect.scoped,
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
