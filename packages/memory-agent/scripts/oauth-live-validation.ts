import { Config, Console, Effect, Schema } from "effect";
import { OAuthCheckFailed, OAuthCheckReason } from "./oauth-check-failure.ts";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { runProcess } from "../src/runtime/run-process.ts";
import { OAuthHarnessError, OAuthValidationHarness } from "../src/oauth/validation-harness.ts";
import { NormalizedStreamEvent, providerProtocols } from "../src/oauth/protocol.ts";

const openBrowser = (command: string, args: string[]) => runProcess({ command, args });
// Native host/SDK configuration boundary reads or forwards the host environment.
const model = Effect.runSync(
  Config.String("CONTEXT_AGENT_OPENAI_VALIDATION_MODEL").pipe(Config.withDefault("gpt-5.6-sol")),
);

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

const harness = OAuthValidationHarness({ protocol: providerProtocols.openai });
let attempt: Awaited<ReturnType<typeof harness.startLogin>> | null = null;

const cancel = () => attempt?.cancel();
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);

try {
  // Native stdout/stderr or SDK logging boundary preserves the existing output format.
  Effect.runSync(Console.log("OPENAI_VALIDATION login_waiting"));
  attempt = await harness.startLogin({ timeoutMs: 10 * 60_000 });
  await openBrowser("open", [attempt.authorizationUrl]);
  const login = await attempt.completed;
  if (!login.connected)
    throw OAuthCheckFailed.make({ reason: OAuthCheckReason.cases.login_not_connected.make({}) });
  // Native stdout/stderr or SDK logging boundary preserves the existing output format.
  Effect.runSync(Console.log("OPENAI_VALIDATION login_passed"));

  const refreshed = await harness.refreshForValidation();
  if (!refreshed.connected)
    throw OAuthCheckFailed.make({ reason: OAuthCheckReason.cases.refresh_not_connected.make({}) });
  // Native stdout/stderr or SDK logging boundary preserves the existing output format.
  Effect.runSync(Console.log("OPENAI_VALIDATION refresh_passed"));

  let textSeen = false;
  for await (const event of harness.stream(textRequest))
    if (NormalizedStreamEvent.$is("text")(event) && event.text.length > 0) textSeen = true;
  if (!textSeen)
    throw OAuthCheckFailed.make({ reason: OAuthCheckReason.cases.stream_text_missing.make({}) });
  // Native stdout/stderr or SDK logging boundary preserves the existing output format.
  Effect.runSync(Console.log("OPENAI_VALIDATION streaming_passed"));

  let toolSeen = false;
  for await (const event of harness.stream(toolRequest))
    if (NormalizedStreamEvent.$is("tool-call")(event) && event.name === "echo_probe")
      toolSeen = true;
  if (!toolSeen)
    throw OAuthCheckFailed.make({ reason: OAuthCheckReason.cases.tool_call_missing.make({}) });
  // Native stdout/stderr or SDK logging boundary preserves the existing output format.
  Effect.runSync(Console.log("OPENAI_VALIDATION tool_call_passed"));
} catch (error) {
  const code = Schema.is(OAuthHarnessError)(error) ? error.code : "validation_failed";
  // Native stdout/stderr or SDK logging boundary preserves the existing output format.
  Effect.runSync(Console.error(`OPENAI_VALIDATION failed ${code}`));
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
  try {
    await harness.disconnect();
    // Native stdout/stderr or SDK logging boundary preserves the existing output format.
    Effect.runSync(Console.log("OPENAI_VALIDATION credentials_removed"));
  } catch {
    // Native stdout/stderr or SDK logging boundary preserves the existing output format.
    Effect.runSync(Console.error("OPENAI_VALIDATION cleanup_failed"));
    process.exitCode = 1;
  }
}
