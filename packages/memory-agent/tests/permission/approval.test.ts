import { Effect } from "effect";
import { expect } from "vite-plus/test";
import { AgentChat } from "../../src/agent/chat.ts";
import { RunStore } from "../../src/loop/store.ts";
import { Nodes } from "../../src/memory/nodes.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import { Workflows } from "../../src/workflow/workflow.ts";
import { selectTestModel } from "../support/provider.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";
import { json, openPage, sessionScopedResponder } from "../support/chat-client.ts";

/** A fresh session in the shared `ask`-mode agent, with the test model selected. */
const freshSession = Effect.gen(function* () {
  const { project } = yield* TestEnv;
  yield* selectTestModel();
  return (yield* (yield* Sessions).create(project.id)).id;
});

/** A session whose page asked for the shell and now shows the approval request. */
const pendingApproval = Effect.fnUntraced(function* () {
  const sessionId = yield* freshSession;
  const page = yield* openPage(sessionId);
  yield* page.send("please use the shell");
  expect(page.pending()).toHaveLength(1);
  return { sessionId, page };
});

const kinds = (nodes: Nodes["Service"], sessionId: string) =>
  Effect.map(nodes.session(sessionId), (session) => session.map((node) => node.kind));

testAgent({ testProvider: { responder: sessionScopedResponder } })("approval-gated tools", (it) => {
  it.effect("saving a code skill waits for approval, then resumes the durable app run", () =>
    Effect.gen(function* () {
      const { provider } = yield* TestEnv;
      const invocations = provider!.adapter.invocations;
      const before = invocations.length;
      const nodes = yield* Nodes;
      const { sessionId, page } = yield* pendingApproval();
      expect(page.pending()[0]).toMatchObject({
        reason: "tool_call",
        metadata: {
          kind: "approval",
          toolName: "save_code_skill",
          input: {
            name: "approved-output",
            description: "Print the approved output",
            program: { runtime: "sh", script: "printf approved-output" },
            reason: "check the shell",
          },
        },
      });
      // Nothing has run yet: the call is recorded, its result is not.
      expect(yield* kinds(nodes, sessionId)).toEqual(["user", "assistant", "tool_call"]);

      yield* page.resolve(() => true);
      expect(page.answer()).toContain("Shell said");
      expect(page.answer()).toContain("approved-output");
      expect(yield* kinds(nodes, sessionId)).toEqual([
        "user",
        "assistant",
        "tool_call",
        "tool_result",
        "assistant",
      ]);
      const [, , call, result] = yield* nodes.session(sessionId);
      expect(result!.runId).toBe(call!.runId);
      expect(result!.detail).toMatchObject({ toolName: "save_code_skill", ok: true });

      // The model asks for save_code_skill; the run that resumes it sends the approved tool result
      // in a new model invocation.
      expect(invocations.length - before).toBe(2);
      expect(invocations.at(-1)?.messages.at(-1)?.role).toBe("tool");
    }),
  );

  it.effect("a declined approval never runs the command and tells the model", () =>
    Effect.gen(function* () {
      const { sessionId, page } = yield* pendingApproval();
      yield* page.resolve(() => false);
      expect(page.answer()).toContain("User declined tool execution");
      expect(page.answer()).not.toContain("approved-output");
      const result = (yield* (yield* Nodes).session(sessionId)).find(
        (node) => node.kind === "tool_result",
      );
      expect(result?.detail).toMatchObject({ toolName: "save_code_skill", ok: false });
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

      const page = yield* openPage(sessionId);
      yield* page.send("please use the shell");
      expect(page.pending()).toMatchObject([
        { reason: "tool_call", metadata: { toolName: "save_code_skill" } },
      ]);
      yield* page.resolve(() => true);
      expect(page.answer()).toContain("Shell said");
      expect(page.answer()).toContain("approved-output");
    }),
  );

  it.effect(
    "a reloaded page gets the pending approval back from the server and can answer it",
    () =>
      Effect.gen(function* () {
        const { sessionId } = yield* pendingApproval();
        // The page reloads; nothing of the first one survives.
        const reloaded = yield* openPage(sessionId);
        // The turn that asked for save_code_skill, and the one that called it.
        expect(reloaded.view().messages.map((message) => message.role)).toEqual([
          "user",
          "assistant",
          "assistant",
        ]);
        expect(reloaded.pending()[0]).toMatchObject({
          reason: "tool_call",
          metadata: { toolName: "save_code_skill" },
        });
        yield* reloaded.resolve(() => true);
        expect(reloaded.answer()).toContain("approved-output");
      }),
  );

  it.effect("a broken approval continuation can be discarded without running the tool", () =>
    Effect.gen(function* () {
      const { sessionId } = yield* pendingApproval();
      const agent = yield* AgentChat;
      expect(yield* json(yield* agent.discardInterrupts(sessionId, null))).toEqual({
        discarded: 1,
      });
      expect(yield* (yield* RunStore).pendingInterrupts(sessionId)).toEqual([]);
      expect(yield* json(yield* agent.status(sessionId, null))).toMatchObject({
        running: null,
        lastRun: { status: "failed", error: { code: "interrupt_continuation_lost" } },
      });
      expect(yield* kinds(yield* Nodes, sessionId)).not.toContain("tool_result");
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
        const { sessionId } = yield* pendingApproval();

        yield* env.reopen;
        const restarted = yield* openPage(sessionId);
        expect(restarted.view().messages.length).toBeGreaterThan(0);
        expect(restarted.pending()).toEqual([]);
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
