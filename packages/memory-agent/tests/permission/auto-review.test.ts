import { DateTime, Effect, Path } from "effect";
import { expect } from "vite-plus/test";
import { workspaceInstructions } from "../../src/agent/chat.ts";
import { Nodes } from "../../src/memory/nodes.ts";
import { PermissionReviews } from "../../src/permissions/reviews.ts";
import { Projects } from "../../src/projects/projects.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import { ApprovedTools } from "../../src/tools/approved.ts";
import { permissionReviewInterrupt } from "../../src/tools/definitions.ts";
import { selectTestModel } from "../support/provider.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";
import { chatClient, scopedCallId, sessionScopedResponder } from "./chat-client.ts";

/** A fresh session in a project set to `auto`, with the test model selected. */
const autoSession = Effect.gen(function* () {
  const { project } = yield* TestEnv;
  yield* (yield* Projects).setPermissionMode(project.id, "auto");
  yield* selectTestModel();
  return (yield* (yield* Sessions).create(project.id)).id;
});

/** A session whose tab asked the model to run `command` through the shell. */
const shellRequest = Effect.fnUntraced(function* (command: string) {
  const sessionId = yield* autoSession;
  const tab = yield* chatClient(sessionId, "send");
  yield* tab.send(`shell: ${command}`);
  const nodes = yield* Nodes;
  const reviews = yield* PermissionReviews;
  return {
    sessionId,
    tab,
    shellResult: () => nodes.session(sessionId).find((node) => node.kind === "tool_result"),
    review: () => reviews.latest(sessionId, scopedCallId("call-shell", sessionId)),
  };
});

testAgent({ testProvider: { responder: sessionScopedResponder } })("auto permission mode", (it) => {
  it.effect("workspace instructions say what the permission mode allows, with date and shell", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { project, storage, home } = yield* TestEnv;
      const places = { storageRoot: storage, globalSkills: path.join(home, ".agents", "skills") };
      const auto = yield* workspaceInstructions(
        { ...project, permissionMode: "auto" },
        places,
        DateTime.toDateUtc(DateTime.makeUnsafe("2026-09-15T12:00:00Z")),
      );
      expect(auto).toContain("reviewed before each call: routine requested work runs");
      expect(auto).toMatch(/Today is 2026-09-1[56] \(.+\)\. run_shell runs commands with \S+ on /);
      expect(auto).not.toContain("read-only");
      expect(yield* workspaceInstructions({ ...project, permissionMode: "ask" }, places)).toContain(
        "wait for the user's approval of each call",
      );
      expect(
        yield* workspaceInstructions({ ...project, permissionMode: "full" }, places),
      ).toContain("run without per-call approval");
      // Where the app keeps its own settings, and that its storage is not for the file tools.
      expect(auto).toContain(
        `MCP servers: ${path.join(storage, "mcp.json")}, ${path.join(project.root, ".mcp.json")}`,
      );
      expect(auto).toContain(
        `${path.join(storage, "agents.json")}, ${path.join(project.root, ".agents", "agents.json")}`,
      );
      expect(auto).toContain("the file tools never open it");
    }),
  );

  it.effect("full mode removes static approval while ask mode keeps it", () =>
    Effect.gen(function* () {
      const { project } = yield* TestEnv;
      const approved = yield* ApprovedTools;
      expect(approved.forProject({ ...project, permissionMode: "ask" })[0].needsApproval).toBe(
        true,
      );
      expect(approved.forProject({ ...project, permissionMode: "full" })[0].needsApproval).toBe(
        false,
      );
    }),
  );

  it.effect("runs a call the review allows without asking, and records why", () =>
    Effect.gen(function* () {
      const { tab, review, shellResult } = yield* shellRequest("printf reviewed-ok");
      yield* tab.answered("Shell said", "the answer");
      expect(tab.client.getInterrupts()).toHaveLength(0);
      expect(tab.text()).toContain("reviewed-ok");
      expect(review()).toMatchObject({
        decision: "allow",
        decidedBy: "classifier",
        reason: "검토 결과: allow",
      });
      expect(shellResult()?.detail).toMatchObject({
        ok: true,
        permission: { decision: "allow", decidedBy: "classifier" },
      });
    }),
  );

  it.effect("never runs a blocked call and tells the model why", () =>
    Effect.gen(function* () {
      const { tab, shellResult } = yield* shellRequest("printf block-me-output");
      yield* tab.answered("Shell said", "the answer");
      expect(tab.client.getInterrupts()).toHaveLength(0);
      expect(tab.text()).toContain("blocked_by_permission_review");
      expect(tab.text()).not.toContain("block-me-output\\n");
      expect(shellResult()?.detail).toMatchObject({
        ok: false,
        permission: { decision: "block" },
      });
    }),
  );

  it.effect("asks the user when the review is unsure, then runs only after approval", () =>
    Effect.gen(function* () {
      const { tab, review, shellResult } = yield* shellRequest("printf ask-me-approved");
      yield* tab.pendingInterrupt;
      expect(tab.client.getInterrupts()[0]).toMatchObject({
        kind: "generic",
        definitionId: "permission-review",
        payload: { toolName: "run_shell", reason: "검토 결과: ask" },
      });
      expect(shellResult()).toBeUndefined();
      tab.client.resolveInterrupts((item) => {
        if (item.kind === "generic" && item.binding.definitionId === permissionReviewInterrupt.id)
          item.resolveInterrupt({ approved: true });
      });
      yield* tab.answered("Shell said", "the answer");
      expect(tab.text()).toContain("ask-me-approved");
      expect(review()).toMatchObject({ decision: "approved", decidedBy: "user" });
      expect(shellResult()?.detail).toMatchObject({
        ok: true,
        permission: { decision: "approved" },
      });
    }),
  );

  it.effect("a declined review never runs the call", () =>
    Effect.gen(function* () {
      const { tab, shellResult } = yield* shellRequest("printf ask-me-declined");
      yield* tab.pendingInterrupt;
      tab.client.resolveInterrupts((item) => {
        if (item.kind === "generic") item.resolveInterrupt({ approved: false });
      });
      yield* tab.answered("Shell said", "the answer");
      expect(tab.text()).toContain('"approved":false');
      expect(shellResult()?.detail).toMatchObject({
        ok: false,
        permission: { decision: "denied", decidedBy: "user" },
      });
    }),
  );

  it.effect("a broken verdict falls back to asking the user", () =>
    Effect.gen(function* () {
      const { tab, review, shellResult } = yield* shellRequest("printf broken-review");
      yield* tab.pendingInterrupt;
      expect(review()).toMatchObject({ decision: "ask", decidedBy: "fallback" });
      expect(shellResult()).toBeUndefined();
    }),
  );

  it.effect("a restored permission review resolves once after leaving the conversation", () =>
    Effect.gen(function* () {
      const { sessionId, tab, shellResult } = yield* shellRequest("printf ask-me-restored");
      yield* tab.pendingInterrupt;
      tab.client.dispose();
      const reloaded = yield* chatClient(sessionId, "restore");
      yield* reloaded.pendingInterrupt;
      reloaded.client.resolveInterrupts((item) => {
        if (item.kind === "generic") item.resolveInterrupt({ approved: true });
      });
      yield* reloaded.until(() => shellResult() !== undefined, "approved call to execute");
      yield* reloaded.until(() => !reloaded.client.getIsLoading(), "resumed run to finish");
      expect(reloaded.client.getInterrupts()).toHaveLength(0);
      expect(shellResult()?.detail).toMatchObject({ ok: true });
    }),
  );
});
