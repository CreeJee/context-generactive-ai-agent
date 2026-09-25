import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
  async read() {
    return credential;
  },
  async write(_provider, value) {
    credential = value;
  },
  async remove() {
    credential = null;
  },
};

const client = createSubscriptionOAuthClient({ protocol: providerProtocols.openai, store });
const openBrowser = promisify(execFile);
let attempt: Awaited<ReturnType<typeof client.startLogin>> | null = null;
const cancel = () => attempt?.cancel();
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);

try {
  attempt = await client.startLogin({ timeoutMs: 10 * 60_000 });
  // Register a rejection handler before opening the browser (which can itself fail).
  void attempt.completed.catch(() => {});
  console.log("OPENAI_LOGIN_CHECK waiting_for_browser");
  try {
    await openBrowser("open", [attempt.authorizationUrl]);
  } catch {
    attempt.cancel();
    throw new Error("browser_open_failed");
  }
  const result = await attempt.completed;
  if (!result.connected) throw new Error("login_not_connected");
  console.log("OPENAI_LOGIN_CHECK passed");
} catch (error) {
  if (error instanceof OAuthHarnessError)
    console.error(
      `OPENAI_LOGIN_CHECK failed code=${error.code} operation=${error.operation ?? "none"} status=${error.status ?? "none"}`,
    );
  else
    console.error(
      `OPENAI_LOGIN_CHECK failed ${error instanceof Error ? error.message : "unexpected_error"}`,
    );
  process.exitCode = 1;
} finally {
  attempt?.cancel();
  credential = null;
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
}
