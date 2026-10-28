import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Config, Console, Effect, Layer, Ref, Schema, Stream } from "effect";
import { OAuthCheckFailed, OAuthCheckReason } from "./oauth-check-failure.ts";
import { nodePlatformLayer } from "../src/runtime/node-platform.ts";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { runProcess } from "../src/runtime/run-process.ts";
import {
  createSubscriptionOAuthClient,
  OAuthHarnessError,
  OAuthKeychain,
  type SubscriptionOAuthClient,
} from "../src/oauth/validation-harness.ts";
import { NormalizedStreamEvent, providerProtocols } from "../src/oauth/protocol.ts";

const textRequest = (model: string) =>
  JSON.stringify({
    model,
    instructions: "Return exactly the word OK and nothing else.",
    input: [{ role: "user", content: [{ type: "input_text", text: "Protocol check." }] }],
    tools: [],
    parallel_tool_calls: false,
    stream: true,
    store: false,
  });

const toolRequest = (model: string) =>
  JSON.stringify({
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

const checkFailed = (reason: OAuthCheckFailed["reason"]) =>
  Effect.fail(OAuthCheckFailed.make({ reason }));

/** Whether the whole stream for `body` held an event that `seen` matches. */
const streamed = (
  client: SubscriptionOAuthClient,
  body: string,
  seen: (event: NormalizedStreamEvent) => boolean,
) =>
  client.stream(body).pipe(
    Stream.filter(seen),
    Stream.runCount,
    Effect.map((count) => count > 0),
  );

const validate = Effect.fnUntraced(function* (client: SubscriptionOAuthClient) {
  // Native host/SDK configuration boundary reads or forwards the host environment.
  const model = yield* Config.String("CONTEXT_AGENT_OPENAI_VALIDATION_MODEL").pipe(
    Config.withDefault("gpt-5.6-sol"),
  );
  yield* Console.log("OPENAI_VALIDATION login_waiting");
  const attempt = yield* Effect.acquireRelease(
    client.startLogin({ timeoutMs: 10 * 60_000 }),
    (started) => started.cancel,
  );
  yield* runProcess({ command: "open", args: [attempt.authorizationUrl] }).pipe(
    Effect.catch(() => checkFailed(OAuthCheckReason.cases.browser_open_failed.make({}))),
  );
  const login = yield* attempt.completed;
  yield* Effect.when(
    checkFailed(OAuthCheckReason.cases.login_not_connected.make({})),
    Effect.succeed(!login.connected),
  );
  yield* Console.log("OPENAI_VALIDATION login_passed");

  const refreshed = yield* client.refreshForValidation;
  yield* Effect.when(
    checkFailed(OAuthCheckReason.cases.refresh_not_connected.make({})),
    Effect.succeed(!refreshed.connected),
  );
  yield* Console.log("OPENAI_VALIDATION refresh_passed");

  yield* Effect.when(
    checkFailed(OAuthCheckReason.cases.stream_text_missing.make({})),
    Effect.map(
      streamed(
        client,
        textRequest(model),
        (event) => NormalizedStreamEvent.$is("text")(event) && event.text.length > 0,
      ),
      (seen) => !seen,
    ),
  );
  yield* Console.log("OPENAI_VALIDATION streaming_passed");

  yield* Effect.when(
    checkFailed(OAuthCheckReason.cases.tool_call_missing.make({})),
    Effect.map(
      streamed(
        client,
        toolRequest(model),
        (event) => NormalizedStreamEvent.$is("tool-call")(event) && event.name === "echo_probe",
      ),
      (seen) => !seen,
    ),
  );
  yield* Console.log("OPENAI_VALIDATION tool_call_passed");
}, Effect.scoped);

const program = Effect.gen(function* () {
  const client = yield* createSubscriptionOAuthClient({
    protocol: providerProtocols.openai,
    store: (yield* OAuthKeychain).store,
  });
  const cleanupFailed = yield* Ref.make(false);
  yield* validate(client).pipe(
    Effect.tapError((error) =>
      Console.error(
        `OPENAI_VALIDATION failed ${Schema.is(OAuthHarnessError)(error) ? error.code : "validation_failed"}`,
      ),
    ),
    // The validation credentials are removed on every exit, Ctrl+C included.
    Effect.ensuring(
      client.disconnect.pipe(
        Effect.andThen(Console.log("OPENAI_VALIDATION credentials_removed")),
        Effect.catch(() =>
          Console.error("OPENAI_VALIDATION cleanup_failed").pipe(
            Effect.andThen(Ref.set(cleanupFailed, true)),
          ),
        ),
      ),
    ),
  );
  yield* Effect.when(
    checkFailed(OAuthCheckReason.cases.cleanup_failed.make({})),
    Ref.get(cleanupFailed),
  );
});

// Every failure is already printed in the check's own format; the exit code reports it.
Layer.build(OAuthKeychain.keychain.pipe(Layer.provideMerge(nodePlatformLayer))).pipe(
  Effect.flatMap((services) => Effect.provideContext(program, services)),
  Effect.scoped,
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
