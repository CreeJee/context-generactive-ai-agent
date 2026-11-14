import { Effect } from "effect";
import { expect } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { AgUiEvent } from "../src/loop/chunks.ts";
import type { ScriptedResponder } from "../src/testing/scripted-model.ts";
import { runTurn } from "./support/chat-client.ts";
import { selectTestModel } from "./support/provider.ts";
import { freshSession, TestEnv, testAgent } from "./support/test-env.ts";

/** A model stuck on one call: it lists the same folder again and again. */
const responder: ScriptedResponder = (invocation) =>
  invocation.index < 10
    ? { toolCalls: [{ id: `call-${invocation.index}`, name: "list_files", arguments: "{}" }] }
    : { text: "the guard did not stop the run" };

testAgent({ testProvider: { responder } })("repeat guard", (it) => {
  it.effect("a call that keeps returning the same result is refused once, then the run stops", () =>
    Effect.gen(function* () {
      const { provider } = yield* TestEnv;
      yield* selectTestModel();
      const session = yield* freshSession;
      const events = yield* runTurn(session, `${session}:loop`, "list the files");
      const invocations = (provider?.invocations ?? []).filter(
        (invocation) => invocation.run.threadId === session,
      );
      // Three runs of the call, the refusal the model reads, and the repeat that ends the run.
      expect(invocations).toHaveLength(5);
      const results = (invocations.at(-1)?.history ?? []).filter(
        (message) => message.role === "tool",
      );
      expect(results).toHaveLength(4);
      expect(results.at(-1)?.content).toEqual(expect.stringContaining("repeated_tool_call"));
      expect(events.find(AgUiEvent.guards.RUN_ERROR)?.code).toBe("repeated_tool_call");
      const status = yield* (yield* AgentChat).status(session, null);
      expect(status.lastRun).toMatchObject({
        status: "failed",
        error: { code: "repeated_tool_call" },
      });
    }),
  );
});

/** A model guessing arguments: each call reads another missing file and fails the same way. */
const guessing: ScriptedResponder = (invocation) =>
  invocation.index < 30
    ? {
        toolCalls: [
          {
            id: `call-${invocation.index}`,
            name: "read_file",
            arguments: JSON.stringify({ path: `missing-${invocation.index}.txt` }),
          },
        ],
      }
    : { text: "the guard did not stop the run" };

testAgent({ testProvider: { responder: guessing } })("repeat guard on failures", (it) => {
  it.effect("a tool that keeps failing the same way is refused once, then the run stops", () =>
    Effect.gen(function* () {
      const { provider } = yield* TestEnv;
      yield* selectTestModel();
      const session = yield* freshSession;
      const events = yield* runTurn(session, `${session}:guess`, "read the file");
      const invocations = (provider?.invocations ?? []).filter(
        (invocation) => invocation.run.threadId === session,
      );
      // Twenty failed reads, the refusal the model reads, and the call that ends the run.
      expect(invocations).toHaveLength(22);
      const results = (invocations.at(-1)?.history ?? []).filter(
        (message) => message.role === "tool",
      );
      expect(results).toHaveLength(21);
      expect(results.at(-1)?.content).toEqual(expect.stringContaining("failed the same way"));
      expect(events.find(AgUiEvent.guards.RUN_ERROR)?.code).toBe("repeated_tool_call");
    }),
  );
});
