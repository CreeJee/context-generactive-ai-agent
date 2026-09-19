import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { OAuthHarnessError, OAuthValidationHarness } from "../src/oauth/validation-harness.ts";
import { providerProtocols } from "../src/oauth/protocol.ts";

const openBrowser = promisify(execFile);
const model = process.env["CONTEXT_AGENT_ANTHROPIC_VALIDATION_MODEL"] ?? "claude-sonnet-4-6";

const textRequest = JSON.stringify({
  model,
  max_tokens: 64,
  stream: true,
  system: "Return exactly the word OK and nothing else.",
  messages: [{ role: "user", content: "Protocol check." }],
});

const toolRequest = JSON.stringify({
  model,
  max_tokens: 128,
  stream: true,
  system: "Call echo_probe exactly once. Do not produce conversational text.",
  messages: [{ role: "user", content: "Call echo_probe with value set to ok." }],
  tools: [
    {
      name: "echo_probe",
      description: "Protocol validation tool.",
      input_schema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
    },
  ],
  tool_choice: { type: "tool", name: "echo_probe" },
});

const harness = new OAuthValidationHarness({ protocol: providerProtocols.anthropic });
let attempt: Awaited<ReturnType<typeof harness.startLogin>> | null = null;

const cancel = () => attempt?.cancel();
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);

try {
  console.log("ANTHROPIC_VALIDATION login_waiting");
  attempt = await harness.startLogin({ timeoutMs: 10 * 60_000 });
  await openBrowser("open", [attempt.authorizationUrl]);
  const login = await attempt.completed;
  if (!login.connected) throw new Error("login_not_connected");
  console.log("ANTHROPIC_VALIDATION login_passed");

  const refreshed = await harness.refreshForValidation();
  if (!refreshed.connected) throw new Error("refresh_not_connected");
  console.log("ANTHROPIC_VALIDATION refresh_passed");

  let textSeen = false;
  for await (const event of harness.stream(textRequest))
    if (event.type === "text" && event.text.length > 0) textSeen = true;
  if (!textSeen) throw new Error("stream_text_missing");
  console.log("ANTHROPIC_VALIDATION streaming_passed");

  let toolSeen = false;
  for await (const event of harness.stream(toolRequest))
    if (event.type === "tool-call" && event.name === "echo_probe") toolSeen = true;
  if (!toolSeen) throw new Error("tool_call_missing");
  console.log("ANTHROPIC_VALIDATION tool_call_passed");
} catch (error) {
  const code = error instanceof OAuthHarnessError ? error.code : "validation_failed";
  const status = error instanceof OAuthHarnessError ? error.status : null;
  console.error(`ANTHROPIC_VALIDATION failed ${code}${status === null ? "" : ` status=${status}`}`);
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
  try {
    await harness.disconnect();
    console.log("ANTHROPIC_VALIDATION credentials_removed");
  } catch {
    console.error("ANTHROPIC_VALIDATION cleanup_failed");
    process.exitCode = 1;
  }
}
