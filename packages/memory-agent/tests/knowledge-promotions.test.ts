import { Effect, Layer } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { Database } from "../src/db/database.ts";
import { KnowledgePromotions } from "../src/memory/knowledge.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { WorkTraceStore } from "../src/work-trace/store.ts";

const testLayer = () => {
  const database = Database.layer(":memory:");
  const nodes = Nodes.layer.pipe(Layer.provide(database));
  const trace = WorkTraceStore.layer.pipe(Layer.provide(database));
  const knowledge = KnowledgePromotions.layer.pipe(Layer.provide(nodes), Layer.provide(database));
  return Layer.mergeAll(database, nodes, trace, knowledge);
};
const run = <A, E>(
  effect: Effect.Effect<A, E, Database | Nodes | WorkTraceStore | KnowledgePromotions>,
) => Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(testLayer()))));

const seed = (db: Database["Service"]) => {
  const iso = new Date(0).toISOString();
  db.sqlite
    .prepare("INSERT INTO projects (id, root, name, created_at) VALUES ('p1', '/tmp/p1', 'p1', ?)")
    .run(iso);
  db.sqlite
    .prepare(
      "INSERT INTO sessions (id, project_id, title, created_at) VALUES ('s1', 'p1', NULL, ?)",
    )
    .run(iso);
  db.sqlite
    .prepare(`INSERT INTO subagents
    (id, session_id, name, instructions, status, parent_run_id, last_task, created_at, updated_at)
    VALUES ('agent-1', 's1', 'researcher', 'research', 'interrupted', 'parent-1', 'task', 1, 1)`)
    .run();
};

describe("Work Trace knowledge promotion", () => {
  test("saves only adopted verified evidence and distinguishes retrieval from answer use", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        const nodes = yield* Nodes;
        const trace = yield* WorkTraceStore;
        const knowledge = yield* KnowledgePromotions;
        seed(db);
        const user = nodes.append({
          projectId: "p1",
          sessionId: "s1",
          kind: "user",
          text: "Save this project decision.",
        });
        const handle = trace.startAttempt({
          sessionId: "s1",
          parentRunId: "parent-1",
          parentToolCallId: "call-1",
          agentId: "agent-1",
          title: "Research",
          request: "Research the code",
          kind: "start",
          threadId: "subagent-agent-1",
        });
        const evidence = trace.recordEvidence({
          handle,
          locator: { kind: "message", threadId: handle.threadId, messageId: "child-answer" },
          verification: "verified",
        });
        const pending = trace.recordEvidence({
          handle,
          locator: { kind: "tool_result", threadId: handle.threadId, toolCallId: "pending-tool" },
        });
        trace.recordReportDisposition({
          handle,
          sessionId: "s1",
          disposition: "reviewed",
          parentRunId: "parent-1",
        });
        const claimId = trace.finalizeAnswerClaim({
          projectId: "p1",
          sessionId: "s1",
          parentRunId: "parent-1",
          parentMessageId: "parent-answer",
          usedReports: [
            { taskId: handle.taskId, attemptId: handle.id, evidenceRefIds: [evidence.id] },
          ],
          reflectedNotificationIds: [],
        });

        const rejected = yield* Effect.flip(
          knowledge.promote({
            projectId: "p1",
            sessionId: "s1",
            authorizedByUserNodeId: user.id,
            claimId,
            taskId: handle.taskId,
            attemptId: handle.id,
            evidenceRefIds: [pending.id],
            proposedText: "Use SQLite.",
            resolvedText: "Use SQLite.",
            disposition: "save",
          }),
        );
        expect(rejected).toMatchObject({
          _tag: "MemoryPromotionRejected",
          reason: "evidence_not_adopted",
        });

        const candidate = yield* knowledge.promote({
          projectId: "p1",
          sessionId: "s1",
          authorizedByUserNodeId: user.id,
          claimId,
          taskId: handle.taskId,
          attemptId: handle.id,
          evidenceRefIds: [evidence.id],
          proposedText: "Use the old database.",
          resolvedText: "Use SQLite for durable Work Trace state.",
          disposition: "save",
        });
        expect(candidate).toMatchObject({
          disposition: "edited_saved",
          evidence: [{ evidenceRefId: evidence.id }],
        });
        const memory = nodes.get(candidate.memoryNodeId!);
        expect(memory).toMatchObject({
          projectId: "p1",
          sessionId: null,
          kind: "topic",
          text: "Use SQLite for durable Work Trace state.",
          detail: { memoryCandidateId: candidate.id, authorizedByUserNodeId: user.id },
        });

        expect(
          knowledge.recordRetrieval({
            projectId: "p1",
            sessionId: "s1",
            runId: "run-2",
            memoryNodeIds: [memory!.id],
          }),
        ).toEqual([memory!.id]);
        expect(knowledge.usageForTask(handle.taskId).map((item) => item.kind)).toEqual([
          "retrieved",
        ]);
        knowledge.recordUsed({
          projectId: "p1",
          sessionId: "s1",
          runId: "run-2",
          parentMessageId: "answer-2",
          memoryNodeIds: [memory!.id],
        });
        expect(knowledge.usageForTask(handle.taskId).map((item) => item.kind)).toEqual([
          "retrieved",
          "used",
        ]);

        db.sqlite.prepare("DELETE FROM subagents WHERE id = 'agent-1'").run();
        db.sqlite.prepare("DELETE FROM interpret_jobs WHERE node_id = ?").run(user.id);
        db.sqlite.prepare("DELETE FROM nodes WHERE session_id = 's1'").run();
        db.sqlite.prepare("DELETE FROM sessions WHERE id = 's1'").run();
        expect(knowledge.candidatesForTask(handle.taskId)[0]).toMatchObject({
          id: candidate.id,
          originSessionId: null,
          authorizedByUserNodeId: user.id,
        });
        expect(nodes.get(memory!.id)?.text).toBe("Use SQLite for durable Work Trace state.");
      }),
    );
  });

  test("conversation-only and rejected dispositions never create recall nodes", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        const nodes = yield* Nodes;
        const trace = yield* WorkTraceStore;
        const knowledge = yield* KnowledgePromotions;
        seed(db);
        const user = nodes.append({
          projectId: "p1",
          sessionId: "s1",
          kind: "user",
          text: "Do not save this.",
        });
        const handle = trace.startAttempt({
          sessionId: "s1",
          parentRunId: "parent-1",
          parentToolCallId: "call-1",
          agentId: "agent-1",
          title: "Research",
          request: "Research",
          kind: "start",
          threadId: "subagent-agent-1",
        });
        trace.recordReportDisposition({
          handle,
          sessionId: "s1",
          disposition: "reviewed",
          parentRunId: "parent-1",
        });
        const claimId = trace.finalizeAnswerClaim({
          projectId: "p1",
          sessionId: "s1",
          parentRunId: "parent-1",
          parentMessageId: "answer",
          usedReports: [{ taskId: handle.taskId, attemptId: handle.id, evidenceRefIds: [] }],
          reflectedNotificationIds: [],
        });
        const evidenceRefIds: string[] = [];
        const common = {
          projectId: "p1",
          sessionId: "s1",
          authorizedByUserNodeId: user.id,
          claimId,
          taskId: handle.taskId,
          attemptId: handle.id,
          evidenceRefIds,
          proposedText: "Temporary conclusion",
          resolvedText: "Temporary conclusion",
        };
        expect(
          (yield* knowledge.promote({ ...common, disposition: "conversation_only" })).memoryNodeId,
        ).toBeNull();
        expect(
          (yield* knowledge.promote({ ...common, disposition: "reject" })).memoryNodeId,
        ).toBeNull();
        expect(
          db.sqlite.prepare("SELECT count(*) AS count FROM nodes WHERE kind = 'topic'").get(),
        ).toEqual({ count: 0 });
      }),
    );
  });
});
