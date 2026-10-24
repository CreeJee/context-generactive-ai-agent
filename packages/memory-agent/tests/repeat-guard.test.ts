import { Cause, Effect, Schema } from "effect";
import { expect } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import type { ScriptedResponder } from "../src/testing/scripted-adapter.ts";
import { selectTestModel } from "./support/provider.ts";
import { freshSession, TestEnv, testAgent } from "./support/test-env.ts";

/** A model stuck on one call: it lists the same folder again and again. */
const responder: ScriptedResponder = (invocation) =>
  invocation.index < 10
    ? { toolCalls: [{ id: `call-${invocation.index}`, name: "list_files", arguments: "{}" }] }
    : { text: "the guard did not stop the run" };

const LastRun = Schema.Struct({
  lastRun: Schema.Struct({
    status: Schema.String,
    error: Schema.NullOr(Schema.Struct({ code: Schema.optional(Schema.String) })),
  }),
});

const text = (response: Response) =>
  Effect.tryPromise({
    try: () => response.text(),
    catch: (cause) => new Cause.UnknownError(cause),
  });

testAgent({ testProvider: { responder } })("repeat guard", (it) => {
  it.effect("a call that keeps returning the same result is refused once, then the run stops", () =>
    Effect.gen(function* () {
      const { provider } = yield* TestEnv;
      yield* selectTestModel();
      const session = yield* freshSession;
      const agent = yield* AgentChat;
      const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        threadId: session,
        runId: `${session}:loop`,
        messages: [{ id: `${session}:loop`, role: "user", content: "list the files" }],
        tools: [],
        context: [],
      });
      const events = yield* text(
        yield* agent.handle(
          new Request("http://127.0.0.1/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
          }),
          session,
        ),
      );
      const invocations = (provider?.adapter.invocations ?? []).filter(
        (invocation) => invocation.threadId === session,
      );
      // Three runs of the call, the refusal the model reads, and the repeat that ends the run.
      expect(invocations).toHaveLength(5);
      const results = (invocations.at(-1)?.messages ?? []).filter(
        (message) => message.role === "tool",
      );
      expect(results).toHaveLength(4);
      expect(results.at(-1)?.content).toEqual(expect.stringContaining("repeated_tool_call"));
      expect(events).toContain('"code":"repeated_tool_call"');
      const status = yield* Schema.decodeEffect(Schema.fromJsonString(LastRun))(
        yield* text(yield* agent.status(session, null)),
      );
      expect(status.lastRun).toMatchObject({
        status: "failed",
        error: { code: "repeated_tool_call" },
      });
    }),
  );
});
