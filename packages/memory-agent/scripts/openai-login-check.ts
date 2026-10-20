import { Console, Effect } from "effect";
import { OAuthCheckFailed } from "./oauth-check-failure.ts";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { runProcess } from "../src/runtime/run-process.ts";
import {
  createSubscriptionOAuthClient,
  OAuthHarnessError,
  type CredentialStore,
  type StoredCredential,
} from "../src/oauth/validation-harness.ts";
import { providerProtocols } from "../src/oauth/protocol.ts";

// Never touch the app's keychain credential during a one-off login diagnosis.
let credential: StoredCredential | null = null;
const store: CredentialStore = {
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  read() {
    return Promise.resolve(credential);
  },
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  write(_provider, value) {
    credential = value;
    return Promise.resolve();
  },
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  remove() {
    credential = null;
    return Promise.resolve();
  },
};

const client = createSubscriptionOAuthClient({ protocol: providerProtocols.openai, store });
const openBrowser = (command: string, args: string[]) => runProcess({ command, args });
let attempt: Awaited<ReturnType<typeof client.startLogin>> | null = null;
const cancel = () => attempt?.cancel();
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);

try {
  attempt = await client.startLogin({ timeoutMs: 10 * 60_000 });
  // Register a rejection handler before opening the browser (which can itself fail).
  void attempt.completed.catch(() => {});
  // Native stdout/stderr or SDK logging boundary preserves the existing output format.
  Effect.runSync(Console.log("OPENAI_LOGIN_CHECK waiting_for_browser"));
  try {
    await openBrowser("open", [attempt.authorizationUrl]);
  } catch {
    attempt.cancel();
    throw OAuthCheckFailed.make({ reason: { _tag: "browser_open_failed" } });
  }
  const result = await attempt.completed;
  if (!result.connected) throw OAuthCheckFailed.make({ reason: { _tag: "login_not_connected" } });
  // Native stdout/stderr or SDK logging boundary preserves the existing output format.
  Effect.runSync(Console.log("OPENAI_LOGIN_CHECK passed"));
} catch (error) {
  if (error instanceof OAuthHarnessError)
    // Native stdout/stderr or SDK logging boundary preserves the existing output format.
    Effect.runSync(
      Console.error(
        `OPENAI_LOGIN_CHECK failed code=${error.code} operation=${error.operation ?? "none"} status=${error.status ?? "none"}`,
      ),
    );
  else
    // Native stdout/stderr or SDK logging boundary preserves the existing output format.
    Effect.runSync(
      Console.error(
        `OPENAI_LOGIN_CHECK failed ${error instanceof Error ? error.message : "unexpected_error"}`,
      ),
    );
  process.exitCode = 1;
} finally {
  attempt?.cancel();
  credential = null;
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
}
