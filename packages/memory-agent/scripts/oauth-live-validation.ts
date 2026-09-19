import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { OAuthHarnessError, OAuthValidationHarness } from "../src/oauth/validation-harness.ts";
import { providerProtocols } from "../src/oauth/protocol.ts";

const openBrowser = promisify(execFile);
const model = process.env["CONTEXT_AGENT_OPENAI_VALIDATION_MODEL"] ?? "gpt-5.6-sol";

const textRequest = JSON.stringify({
  model,
  instructions: "Return exactly the word OK and nothing else.",
  input: [{ role: "user", content: [{ type: "input_text", text: "Protocol check." }] }],
  tools: [],
  parallel_tool_calls: false,
  stream: true,
  store: false,
});

const toolRequest = JSON.stringify({
  model,
  instructions: "Call echo_probe exactly once. Do not produce conversational text.",
  input: [
    {
      role: "user",
      content: [{ type: "input_text", text: "Call echo_probe with value set to ok." }],
    },
  ],
  tools: [
    {
      type: "function",
      name: "echo_probe",
      description: "Protocol validation tool.",
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      strict: true,
    },
  ],
  tool_choice: "required",
  parallel_tool_calls: false,
  stream: true,
  store: false,
});

const harness = new OAuthValidationHarness({ protocol: providerProtocols.openai });
let attempt: Awaited<ReturnType<typeof harness.startLogin>> | null = null;

const cancel = () => attempt?.cancel();
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);

try {
  console.log("OPENAI_VALIDATION login_waiting");
  attempt = await harness.startLogin({ timeoutMs: 10 * 60_000 });
  await openBrowser("open", [attempt.authorizationUrl]);
  const login = await attempt.completed;
  if (!login.connected) throw new Error("login_not_connected");
  console.log("OPENAI_VALIDATION login_passed");

  const refreshed = await harness.refreshForValidation();
  if (!refreshed.connected) throw new Error("refresh_not_connected");
  console.log("OPENAI_VALIDATION refresh_passed");

  let textSeen = false;
  for await (const event of harness.stream(textRequest))
    if (event.type === "text" && event.text.length > 0) textSeen = true;
  if (!textSeen) throw new Error("stream_text_missing");
  console.log("OPENAI_VALIDATION streaming_passed");

  let toolSeen = false;
  for await (const event of harness.stream(toolRequest))
    if (event.type === "tool-call" && event.name === "echo_probe") toolSeen = true;
  if (!toolSeen) throw new Error("tool_call_missing");
  console.log("OPENAI_VALIDATION tool_call_passed");
} catch (error) {
  const code = error instanceof OAuthHarnessError ? error.code : "validation_failed";
  console.error(`OPENAI_VALIDATION failed ${code}`);
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
  try {
    await harness.disconnect();
    console.log("OPENAI_VALIDATION credentials_removed");
  } catch {
    console.error("OPENAI_VALIDATION cleanup_failed");
    process.exitCode = 1;
  }
}
