import { Effect } from "effect";
import { expect } from "vite-plus/test";
import { AgentChat } from "../../src/agent/chat.ts";
import { ChatState } from "../../src/chat-state/chat-state.ts";
import { Nodes } from "../../src/memory/nodes.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import { Workflows } from "../../src/workflow/workflow.ts";
import { selectTestModel } from "../support/provider.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";
import { chatClient, json, sdk, sessionScopedResponder } from "./chat-client.ts";

/** A fresh session in the shared `ask`-mode agent, with the test model selected. */
const freshSession = Effect.gen(function* () {
  const { project } = yield* TestEnv;
  yield* selectTestModel();
  return (yield* (yield* Sessions).create(project.id)).id;
});

/** A session whose tab asked for the shell and now shows the approval request. */
const pendingApproval = Effect.fnUntraced(function* () {
  const sessionId = yield* freshSession;
  const tab = yield* chatClient(sessionId, "send");
  yield* tab.send("please use the shell");
  yield* tab.pendingInterrupt;
  return { sessionId, tab };
});

const kinds = (nodes: Nodes["Service"], sessionId: string) =>
  nodes.session(sessionId).map((node) => node.kind);

testAgent({ testProvider: { responder: sessionScopedResponder } })("approval-gated tools", (it) => {
  it.effect("run_shell waits for approval, then resumes the durable app run", () =>
    Effect.gen(function* () {
      const { provider } = yield* TestEnv;
      const invocations = provider!.adapter.invocations;
      const before = invocations.length;
      const nodes = yield* Nodes;
      const { sessionId, tab } = yield* pendingApproval();
      expect(tab.client.getInterrupts()[0]).toMatchObject({
        kind: "tool-approval",
        toolName: "run_shell",
        originalArgs: { command: "printf approved-output", reason: "check the shell" },
      });
      // Nothing has run yet: the call is recorded, its result is not.
      expect(kinds(nodes, sessionId)).toEqual(["user", "assistant", "tool_call"]);

      tab.client.resolveInterrupts(true);
      yield* tab.answered("Shell said", "the answer after approval");
      expect(tab.text()).toContain("approved-output");
      expect(kinds(nodes, sessionId)).toEqual([
        "user",
        "assistant",
        "tool_call",
        "tool_result",
        "assistant",
      ]);
      const [, , call, result] = nodes.session(sessionId);
      expect(result!.runId).toBe(call!.runId);
      expect(result!.detail).toMatchObject({ toolName: "run_shell", ok: true });

      // The durable app run resumes with the approved tool result in a fresh model invocation.
      expect(invocations.length - before).toBe(2);
      expect(invocations[before + 1]?.messages.some((message) => message.role === "tool")).toBe(
        true,
      );
    }),
  );

  it.effect("a declined approval never runs the command and tells the model", () =>
    Effect.gen(function* () {
      const { sessionId, tab } = yield* pendingApproval();
      tab.client.resolveInterrupts(false);
      yield* tab.answered("Shell said", "the answer after declining");
      expect(tab.text()).toContain('"approved":false');
      expect(tab.text()).not.toContain("approved-output");
      const result = (yield* Nodes).session(sessionId).find((node) => node.kind === "tool_result");
      expect(result?.detail).toMatchObject({ toolName: "run_shell", ok: false });
    }),
  );

  it.effect("Verify can run an approval-gated shell check", () =>
    Effect.gen(function* () {
      const sessionId = yield* freshSession;
      const workflows = yield* Workflows;
      yield* workflows.updateGoal(sessionId, {
        statement: "Verify the implementation",
        outcomes: ["Checks pass"],
        constraints: [],
        nonGoals: [],
        assumptions: [],
        openQuestions: [],
        status: "active",
      });
      yield* workflows.updatePlan(sessionId, {
        summary: "Implement and verify",
        steps: [
          {
            id: "implementation",
            title: "Implement",
            description: "Make the change",
            dependsOn: [],
            acceptanceCriteria: ["The check passes"],
            ruleRefs: [],
          },
        ],
        risks: [],
        openQuestions: [],
        status: "ready",
      });
      yield* workflows.setPhase(sessionId, "execute");
      yield* workflows.updateProgress(sessionId, {
        steps: [{ id: "implementation", status: "completed", evidence: ["change made"] }],
        goalEvidence: [],
        planEvidence: [],
        detail: "Implementation complete",
      });
      yield* workflows.finishRun(sessionId, "execute");

      const tab = yield* chatClient(sessionId, "send");
      yield* tab.send("please use the shell");
      yield* tab.pendingInterrupt;
      expect(tab.client.getInterrupts()[0]).toMatchObject({ toolName: "run_shell" });
      tab.client.resolveInterrupts(true);
      yield* tab.answered("Shell said", "the Verify shell result");
      expect(tab.text()).toContain("approved-output");
    }),
  );

  it.effect(
    "a reloaded page gets the pending approval back from the server and can answer it",
    () =>
      Effect.gen(function* () {
        const { sessionId, tab } = yield* pendingApproval();
        // The tab closes; nothing of the first client survives.
        tab.client.dispose();

        const reloaded = yield* chatClient(sessionId, "restore");
        yield* reloaded.pendingInterrupt;
        expect(reloaded.client.getMessages().map((message) => message.role)).toEqual([
          "user",
          "assistant",
        ]);
        expect(reloaded.client.getInterrupts()[0]).toMatchObject({
          kind: "tool-approval",
          toolName: "run_shell",
        });
        reloaded.client.resolveInterrupts(true);
        yield* reloaded.answered("Shell said", "the answer after the reload");
        expect(reloaded.text()).toContain("approved-output");
      }),
  );

  it.effect("a broken approval continuation can be discarded without running the tool", () =>
    Effect.gen(function* () {
      const { sessionId, tab } = yield* pendingApproval();
      tab.client.dispose();
      const agent = yield* AgentChat;
      expect(yield* json(yield* agent.discardInterrupts(sessionId, null))).toEqual({
        discarded: 1,
      });
      const { interrupts } = (yield* ChatState).persistence.stores;
      expect(yield* sdk(() => interrupts.listPending(sessionId))).toEqual([]);
      expect(yield* json(yield* agent.status(sessionId, null))).toMatchObject({
        running: null,
        lastRun: { status: "failed", error: { code: "interrupt_continuation_lost" } },
      });
      expect(kinds(yield* Nodes, sessionId)).not.toContain("tool_result");
    }),
  );
});

// Restarting replaces the agent, so this block has its own and reads services through `env.use`.
testAgent({ testProvider: { responder: sessionScopedResponder } })(
  "approval across a server restart",
  (it) => {
    it.effect("a server restart retires an approval whose continuation no longer exists", () =>
      Effect.gen(function* () {
        const env = yield* TestEnv;
        const { sessionId, tab } = yield* pendingApproval();
        tab.client.dispose();

        yield* env.reopen;
        const restarted = yield* env.use(chatClient(sessionId, "restore"));
        yield* restarted.until(
          () => restarted.client.getMessages().length > 0,
          "the restored transcript",
        );
        expect(restarted.client.getInterrupts()).toEqual([]);
        expect(restarted.client.getError()).toBeUndefined();
        const status = yield* env.use(
          Effect.flatMap(AgentChat, (agent) => agent.status(sessionId, null)),
        );
        expect(yield* json(status)).toMatchObject({
          running: null,
          lastRun: { status: "failed", error: { code: "server_restarted" } },
        });
      }),
    );
  },
);
