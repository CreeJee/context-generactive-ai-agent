import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Schema } from "effect";
import { Sessions } from "memory-agent";
import { expect, test, vi } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { Database } from "../src/db/database.ts";
import { Workflows } from "../src/workflow/workflow.ts";
import { turnGate } from "./support/provider.ts";
import { testRuntime } from "./support/runtime.ts";

const fixture = vi.hoisted(() => ({ directory: "" }));
vi.mock("../src/agent/goal-worker-assets.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/agent/goal-worker-assets.ts")>();
  return {
    ...original,
    makeGoalWorkerAssetsRegistry: () =>
      original.makeGoalWorkerAssetsRegistry({
        sourceDirectory: fixture.directory,
        temporaryDirectory: fixture.directory,
      }),
  };
});

const goal = {
  statement: "Keep execution code pinned independently of revisions",
  outcomes: ["Separate real SDK loops retain their source generations"],
  constraints: [],
  nonGoals: [],
  assumptions: [],
  openQuestions: [],
  status: "active" as const,
};
const Pin = Schema.Struct({
  goal_instance_id: Schema.String,
  source_generation: Schema.String,
  manifest_hash: Schema.String,
  worker_url: Schema.String,
});
const plan = {
  summary: "Preserve execution assets while revising the method",
  steps: [
    {
      id: "pin",
      title: "Pin",
      description: "Keep source identity",
      dependsOn: [],
      acceptanceCriteria: ["Old code remains available"],
      ruleRefs: [],
    },
  ],
  risks: [],
  openQuestions: [],
  status: "ready" as const,
};
const Binding = Schema.Struct({
  goal_instance_id: Schema.String,
  goal_version: Schema.Finite,
  plan_version: Schema.NullOr(Schema.Finite),
});
const Dispatch = Schema.Struct({ generation: Schema.String });
const request = (sessionId: string, runId: string) =>
  new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      threadId: sessionId,
      runId,
      messages: [{ id: `user-${runId}`, role: "user", content: `hello ${runId}` }],
      tools: [],
      context: [],
    }),
  });

for (const damage of ["missing", "tampered"] as const) {
  test(`real SDK Goal code pins survive source edits/reopen and reject ${damage} snapshots before admission`, async () => {
    const previous = process.env.CONTEXT_AGENT_GOAL_WORKER;
    process.env.CONTEXT_AGENT_GOAL_WORKER = "1";
    fixture.directory = realpathSync(mkdtempSync(join(tmpdir(), "agent-chat-source-test-")));
    const sourceDirectory = new URL("../src/agent/", import.meta.url);
    for (const name of ["full-loop-worker.ts", "full-loop-codec.ts", "full-loop-rpc-client.ts"])
      copyFileSync(new URL(name, sourceDirectory), join(fixture.directory, name));
    const workerFile = join(fixture.directory, "full-loop-worker.ts");
    const original = readFileSync(workerFile, "utf8");
    const emission = 'parentPort.postMessage({ type: "chunk", chunk });';
    expect(original.split(emission)).toHaveLength(2);
    // Only the owned source fixture changes. The marker is attached at the actual SDK
    // loop emission, not fabricated by the scripted provider or owner adapter.
    const version = (marker: string) =>
      writeFileSync(
        workerFile,
        original.replace(
          emission,
          `if (chunk.type === "TEXT_MESSAGE_CONTENT") chunk.delta = "[${marker}]" + chunk.delta;\n    ${emission}`,
        ),
      );
    version("loop-v1");
    const gate = turnGate();
    let started = () => {};
    const modelStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let calls = 0;
    const context = await testRuntime({
      testProvider: {
        responder: () => {
          calls++;
          if (calls === 1) {
            started();
            return { text: "answer", waitFor: gate.waitFor };
          }
          return { text: "answer" };
        },
      },
    });
    let currentRuntime = context.runtime;
    let drainPending: Promise<unknown> = Promise.resolve();
    try {
      await context.provider!.select(context.runtime);
      const owner = await context.runtime.runPromise(
        Effect.all({ db: Database, chat: AgentChat, workflows: Workflows, sessions: Sessions }),
      );
      const sessionA = context.session.id;
      const sessionB = (await context.runtime.runPromise(owner.sessions.create(context.project.id)))
        .id;
      await context.runtime.runPromise(owner.workflows.updateGoal(sessionA, goal));
      await context.runtime.runPromise(owner.workflows.updateGoal(sessionB, goal));
      await context.runtime.runPromise(owner.workflows.updatePlan(sessionA, plan));
      const send = async (session: string, run: string) => {
        const response = await currentRuntime.runPromise(
          Effect.flatMap(AgentChat, (chat) => chat.handle(request(session, run), session)),
        );
        expect(response.status).toBe(200);
        const stream = await response.text();
        expect(stream).not.toContain("RUN_ERROR");
        return stream;
      };
      const pendingA = send(sessionA, "source-a1");
      drainPending = Promise.allSettled([pendingA]);
      await modelStarted;
      version("loop-v2");
      const streamB = await send(sessionB, "source-b1");
      expect(streamB).toContain("[loop-v2]");
      expect(streamB).not.toContain("[loop-v1]");
      gate.release();
      const streamA = await pendingA;
      expect(streamA).toContain("[loop-v1]");
      expect(streamA).not.toContain("[loop-v2]");
      const binding = (db: Database["Service"], run: string) =>
        Schema.decodeUnknownSync(Binding)(
          db.sqlite
            .prepare(
              "SELECT goal_instance_id, goal_version, plan_version FROM workflow_run_bindings WHERE run_id = ?",
            )
            .get(run),
        );
      const pin = (db: Database["Service"], id: string) =>
        Schema.decodeUnknownSync(Pin)(
          db.sqlite
            .prepare(
              "SELECT goal_instance_id, source_generation, manifest_hash, worker_url FROM workflow_goal_worker_generations WHERE goal_instance_id = ?",
            )
            .get(id),
        );
      const dispatch = (db: Database["Service"], run: string) =>
        Schema.decodeUnknownSync(Dispatch)(
          db.sqlite
            .prepare("SELECT generation FROM workflow_worker_dispatches WHERE run_id = ?")
            .get(run),
        );
      const a = binding(owner.db, "source-a1");
      const b = binding(owner.db, "source-b1");
      expect(a).toMatchObject({ goal_version: 1, plan_version: 1 });
      expect(b).toMatchObject({ goal_version: 1, plan_version: null });
      expect(a.goal_instance_id).not.toBe(b.goal_instance_id);
      const pinA = pin(owner.db, a.goal_instance_id);
      const pinB = pin(owner.db, b.goal_instance_id);
      expect(pinA.source_generation).not.toBe(pinB.source_generation);
      expect(pinA.source_generation).not.toBe(dispatch(owner.db, "source-a1").generation);
      // A first method-only Plan must not retroactively invent a Plan for the old run.
      await context.runtime.runPromise(owner.workflows.updatePlan(sessionB, plan));
      const methodOnly = await send(sessionB, "source-b2");
      expect(methodOnly).toContain("[loop-v2]");
      expect(methodOnly).not.toContain("[loop-v1]");
      expect(binding(owner.db, "source-b2")).toEqual({ ...b, plan_version: 1 });
      expect(binding(owner.db, "source-b1")).toEqual(b);
      expect(pin(owner.db, b.goal_instance_id)).toEqual(pinB);
      const oldDispatch = dispatch(owner.db, "source-a1");
      const oldEvidence = JSON.stringify(
        owner.db.sqlite
          .prepare("SELECT * FROM workflow_run_events WHERE run_id = ? ORDER BY cursor")
          .all("source-a1"),
      );
      await context.runtime.runPromise(
        owner.workflows.updateGoal(sessionA, {
          ...goal,
          statement: "Amended Goal with preserved old execution code",
        }),
      );
      await context.runtime.runPromise(
        owner.workflows.updatePlan(sessionA, {
          ...plan,
          summary: "Amended method retaining the same source assets",
        }),
      );
      const amended = await send(sessionA, "source-a2");
      expect(amended).toContain("[loop-v1]");
      expect(binding(owner.db, "source-a2")).toEqual({
        ...a,
        goal_version: 2,
        plan_version: 2,
      });
      expect(binding(owner.db, "source-a1")).toEqual(a);
      expect(pin(owner.db, a.goal_instance_id)).toEqual(pinA);
      process.env.CONTEXT_AGENT_GOAL_WORKER = "0";
      const legacy = await send(sessionA, "source-legacy");
      expect(legacy).not.toContain("[loop-v1]");
      expect(pin(owner.db, a.goal_instance_id)).toEqual(pinA);
      process.env.CONTEXT_AGENT_GOAL_WORKER = "1";
      currentRuntime = await context.reopen();
      const reopened = await currentRuntime.runPromise(
        Effect.all({ db: Database, chat: AgentChat }),
      );
      const revived = await send(sessionA, "source-a3");
      expect(revived).toContain("[loop-v1]");
      expect(revived).not.toContain("[loop-v2]");
      expect(pin(reopened.db, a.goal_instance_id)).toEqual(pinA);
      expect(dispatch(reopened.db, "source-a3").generation).not.toBe(oldDispatch.generation);
      expect(dispatch(reopened.db, "source-a1")).toEqual(oldDispatch);
      expect(
        JSON.stringify(
          reopened.db.sqlite
            .prepare("SELECT * FROM workflow_run_events WHERE run_id = ? ORDER BY cursor")
            .all("source-a1"),
        ),
      ).toBe(oldEvidence);
      const offset = [...streamA.matchAll(/^id: (.+)$/gm)][0]![1]!;
      const replay = await currentRuntime.runPromise(
        reopened.chat.hydrate(
          new Request("http://localhost/api/chat?runId=source-a1", {
            headers: { "Last-Event-ID": offset },
          }),
          sessionA,
        ),
      );
      expect(replay.status).toBe(200);
      expect(await replay.text()).toBe(streamA.slice(streamA.indexOf("\n\n") + 2));
      const before = () =>
        JSON.stringify({
          nodes: reopened.db.sqlite
            .prepare("SELECT * FROM nodes WHERE session_id = ? ORDER BY seq")
            .all(sessionA),
          bindings: reopened.db.sqlite
            .prepare("SELECT * FROM workflow_run_bindings WHERE session_id = ? ORDER BY run_id")
            .all(sessionA),
          runs: reopened.db.sqlite
            .prepare("SELECT * FROM chat_runs WHERE thread_id = ? ORDER BY run_id")
            .all(sessionA),
        });
      const admissionBefore = before();
      const callsBefore = calls;
      const snapshotWorker = fileURLToPath(pinA.worker_url);
      expect(snapshotWorker.startsWith(fixture.directory + "/")).toBe(true);
      if (damage === "missing") rmSync(snapshotWorker);
      else {
        chmodSync(snapshotWorker, 0o600);
        writeFileSync(snapshotWorker, "// damaged owned snapshot\n");
      }
      const rejected = await currentRuntime.runPromise(
        reopened.chat.handle(request(sessionA, "source-damaged"), sessionA),
      );
      expect(rejected.status).toBe(409);
      expect(calls).toBe(callsBefore);
      expect(before()).toBe(admissionBefore);
      expect(pin(reopened.db, a.goal_instance_id)).toEqual(pinA);
    } finally {
      gate.release();
      await drainPending;
      await currentRuntime.dispose();
      rmSync(fixture.directory, { recursive: true, force: true });
      fixture.directory = "";
      if (previous === undefined) delete process.env.CONTEXT_AGENT_GOAL_WORKER;
      else process.env.CONTEXT_AGENT_GOAL_WORKER = previous;
    }
  }, 30000);
}
