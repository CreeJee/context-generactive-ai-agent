import { DateTime, Effect } from "effect";
import { expect } from "vite-plus/test";
import { workspaceInstructions } from "../../src/agent/chat.ts";
import { Nodes } from "../../src/memory/nodes.ts";
import { PermissionReviews } from "../../src/permissions/reviews.ts";
import { Projects } from "../../src/projects/projects.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import { ApprovedTools } from "../../src/tools/approved.ts";
import { selectTestModel } from "../support/provider.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";
import { openPage, scopedCallId, sessionScopedResponder } from "../support/chat-client.ts";

/** A fresh session in a project set to `auto`, with the test model selected. */
const autoSession = Effect.gen(function* () {
  const { project } = yield* TestEnv;
  yield* (yield* Projects).setPermissionMode(project.id, "auto");
  yield* selectTestModel();
  return (yield* (yield* Sessions).create(project.id)).id;
});

/** A session whose page asked the model to run `command` through the shell. */
const shellRequest = Effect.fnUntraced(function* (command: string) {
  const sessionId = yield* autoSession;
  const page = yield* openPage(sessionId);
  yield* page.send(`shell: ${command}`);
  const nodes = yield* Nodes;
  const reviews = yield* PermissionReviews;
  return {
    sessionId,
    page,
    shellResult: () =>
      Effect.map(nodes.session(sessionId), (session) =>
        session.find((node) => node.kind === "tool_result"),
      ),
    review: reviews.latest(sessionId, scopedCallId("call-shell", sessionId)),
  };
});

testAgent({ testProvider: { responder: sessionScopedResponder } })("auto permission mode", (it) => {
  it.effect("workspace instructions say what the permission mode allows, with date and shell", () =>
    Effect.gen(function* () {
      const { project, storage } = yield* TestEnv;
      const places = { storageRoot: storage };
      const auto = yield* workspaceInstructions(
        { ...project, permissionMode: "auto" },
        places,
        DateTime.toDateUtc(DateTime.makeUnsafe("2026-09-15T12:00:00Z")),
      );
      expect(auto).toContain("reviewed before each call: routine requested work runs");
      expect(auto).toMatch(
        /Today is 2026-09-1[56] \(.+\)\. Scripts of sh skills run with \/bin\/sh on /,
      );
      expect(auto).not.toContain("read-only");
      expect(yield* workspaceInstructions({ ...project, permissionMode: "ask" }, places)).toContain(
        "wait for the user's approval of each call",
      );
      expect(
        yield* workspaceInstructions({ ...project, permissionMode: "full" }, places),
      ).toContain("run without approval");
      // Where the app keeps its own settings, and that its storage is not for the file tools.
      expect(auto).toContain(`the memory database in ${storage}.`);
      expect(auto).toContain("Neither the file tools nor sh skill scripts open that folder");
    }),
  );

  it.effect("full mode removes static approval while ask mode keeps it", () =>
    Effect.gen(function* () {
      const { project } = yield* TestEnv;
      const approved = yield* ApprovedTools;
      const [ask] = approved.toolsFor({ ...project, permissionMode: "ask" });
      const [full] = approved.toolsFor({ ...project, permissionMode: "full" });
      expect(ask?.tool.needsApproval).toBe(true);
      expect(full?.tool.needsApproval).toBe(false);
    }),
  );

  it.effect("runs a call the review allows without asking, and records why", () =>
    Effect.gen(function* () {
      const { page, review, shellResult } = yield* shellRequest("printf reviewed-ok");
      expect(page.pending()).toHaveLength(0);
      expect(page.answer()).toContain('"scriptSha256"');
      expect(yield* review).toMatchObject({
        decision: "allow",
        decidedBy: "classifier",
        reason: "검토 결과: allow",
      });
      expect((yield* shellResult())?.detail).toMatchObject({
        ok: true,
        permission: { decision: "allow", decidedBy: "classifier" },
      });
    }),
  );

  it.effect("never runs a blocked call and tells the model why", () =>
    Effect.gen(function* () {
      const { page, shellResult } = yield* shellRequest("printf block-me-output");
      expect(page.pending()).toHaveLength(0);
      expect(page.answer()).toContain("blocked_by_permission_review");
      expect(page.answer()).not.toContain("block-me-output\\n");
      expect((yield* shellResult())?.detail).toMatchObject({
        ok: false,
        permission: { decision: "block" },
      });
    }),
  );

  it.effect("asks the user when the review is unsure, then runs only after approval", () =>
    Effect.gen(function* () {
      const { page, review, shellResult } = yield* shellRequest("printf ask-me-approved");
      expect(page.pending()).toMatchObject([
        {
          reason: "permission_review",
          metadata: { payload: { toolName: "save_code_skill", reason: "검토 결과: ask" } },
        },
      ]);
      expect(yield* shellResult()).toBeUndefined();
      yield* page.resolve(() => true);
      expect(page.answer()).toContain('"scriptSha256"');
      expect(yield* review).toMatchObject({ decision: "approved", decidedBy: "user" });
      expect((yield* shellResult())?.detail).toMatchObject({
        ok: true,
        permission: { decision: "approved" },
      });
    }),
  );

  it.effect("a declined review never runs the call", () =>
    Effect.gen(function* () {
      const { page, shellResult } = yield* shellRequest("printf ask-me-declined");
      expect(page.pending()).toHaveLength(1);
      yield* page.resolve(() => false);
      expect(page.answer()).toContain('"approved":false');
      expect((yield* shellResult())?.detail).toMatchObject({
        ok: false,
        permission: { decision: "denied", decidedBy: "user" },
      });
    }),
  );

  it.effect("a broken verdict falls back to asking the user", () =>
    Effect.gen(function* () {
      const { page, review, shellResult } = yield* shellRequest("printf broken-review");
      expect(page.pending()).toHaveLength(1);
      expect(yield* review).toMatchObject({ decision: "ask", decidedBy: "fallback" });
      expect(yield* shellResult()).toBeUndefined();
    }),
  );

  it.effect("a restored permission review resolves once after leaving the conversation", () =>
    Effect.gen(function* () {
      const { sessionId, shellResult } = yield* shellRequest("printf ask-me-restored");
      const reloaded = yield* openPage(sessionId);
      expect(reloaded.pending()).toHaveLength(1);
      yield* reloaded.resolve(() => true);
      expect(reloaded.pending()).toHaveLength(0);
      expect((yield* shellResult())?.detail).toMatchObject({ ok: true });
    }),
  );
});
