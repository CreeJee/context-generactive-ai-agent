import { NodeCrypto } from "@effect/platform-node";
import { SqlClient } from "effect/sql";
import { Crypto, DateTime, Effect, Layer } from "effect";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { Database } from "../src/db/database.ts";
import { KnowledgePromotions } from "../src/memory/knowledge.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { WorkTraceStore } from "../src/work-trace/store.ts";
import { sqlGet, sqlRun } from "./support/sql.ts";

const testLayer = () => {
  const database = Database.layer(":memory:");
  const nodes = Nodes.layer.pipe(Layer.provide(database));
  const trace = WorkTraceStore.layer.pipe(Layer.provide(database));
  const knowledge = KnowledgePromotions.layer.pipe(Layer.provide(nodes), Layer.provide(database));
  return Layer.mergeAll(database, nodes, trace, knowledge);
};
const run = Effect.fnUntraced(function* <A, E>(
  program: Effect.Effect<
    A,
    E,
    SqlClient.SqlClient | Nodes | WorkTraceStore | KnowledgePromotions | Crypto.Crypto
  >,
) {
  const services = yield* Layer.build(Layer.merge(testLayer(), NodeCrypto.layer));
  return yield* Effect.provideContext(program, services);
}, Effect.scoped);

const seed = Effect.fnUntraced(function* () {
  const iso = DateTime.formatIso(DateTime.makeUnsafe(0));
  yield* sqlRun(
    "INSERT INTO projects (id, root, name, created_at) VALUES ('p1', '/tmp/p1', 'p1', ?)",
    iso,
  );
  yield* sqlRun(
    "INSERT INTO sessions (id, project_id, title, created_at) VALUES ('s1', 'p1', NULL, ?)",
    iso,
  );
  yield* sqlRun(`INSERT INTO subagents
    (id, session_id, name, instructions, status, parent_run_id, last_task, created_at, updated_at)
    VALUES ('agent-1', 's1', 'researcher', 'research', 'interrupted', 'parent-1', 'task', 1, 1)`);
});

describe("Work Trace knowledge promotion", () => {
  it.effect("saves only adopted claims and distinguishes retrieval from answer use", () =>
    run(
      Effect.gen(function* () {
        const nodes = yield* Nodes;
        const trace = yield* WorkTraceStore;
        const knowledge = yield* KnowledgePromotions;
        yield* seed();
        const user = yield* nodes.append({
          projectId: "p1",
          sessionId: "s1",
          kind: "user",
          text: "Save this project decision.",
        });
        const handle = yield* trace.startAttempt({
          sessionId: "s1",
          parentRunId: "parent-1",
          parentToolCallId: "call-1",
          agentId: "agent-1",
          title: "Research",
          request: "Research the code",
          kind: "start",
          threadId: "subagent-agent-1",
        });
        const claimId = yield* trace.finalizeAnswerClaim({
          projectId: "p1",
          sessionId: "s1",
          parentRunId: "parent-1",
          parentMessageId: "parent-answer",
          usedReports: [{ taskId: handle.taskId, attemptId: handle.id }],
          reflectedNotificationIds: [],
        });

        const rejected = yield* Effect.flip(
          knowledge.promote({
            projectId: "p1",
            sessionId: "s1",
            authorizedByUserNodeId: user.id,
            claimId: "unadopted",
            taskId: handle.taskId,
            attemptId: handle.id,
            proposedText: "Use SQLite.",
            resolvedText: "Use SQLite.",
            disposition: "save",
          }),
        );
        expect(rejected).toMatchObject({
          _tag: "MemoryPromotionRejected",
          reason: "claim_not_adopted",
        });

        const candidate = yield* knowledge.promote({
          projectId: "p1",
          sessionId: "s1",
          authorizedByUserNodeId: user.id,
          claimId,
          taskId: handle.taskId,
          attemptId: handle.id,
          proposedText: "Use the old database.",
          resolvedText: "Use SQLite for durable Work Trace state.",
          disposition: "save",
        });
        expect(candidate).toMatchObject({
          disposition: "edited_saved",
          evidence: [],
        });
        const memory = yield* nodes.get(candidate.memoryNodeId!);
        expect(memory).toMatchObject({
          projectId: "p1",
          sessionId: null,
          kind: "topic",
          text: "Use SQLite for durable Work Trace state.",
          detail: { memoryCandidateId: candidate.id, authorizedByUserNodeId: user.id },
        });

        expect(
          yield* knowledge.recordRetrieval({
            projectId: "p1",
            sessionId: "s1",
            runId: "run-2",
            memoryNodeIds: [memory!.id],
          }),
        ).toEqual([memory!.id]);
        expect((yield* knowledge.usageForTask(handle.taskId)).map((item) => item.kind)).toEqual([
          "retrieved",
        ]);
        yield* knowledge.recordUsed({
          projectId: "p1",
          sessionId: "s1",
          runId: "run-2",
          parentMessageId: "answer-2",
          memoryNodeIds: [memory!.id],
        });
        expect((yield* knowledge.usageForTask(handle.taskId)).map((item) => item.kind)).toEqual([
          "retrieved",
          "used",
        ]);

        yield* sqlRun("DELETE FROM subagents WHERE id = 'agent-1'");
        yield* sqlRun("DELETE FROM interpret_jobs WHERE node_id = ?", user.id);
        yield* sqlRun("DELETE FROM nodes WHERE session_id = 's1'");
        yield* sqlRun("DELETE FROM sessions WHERE id = 's1'");
        expect((yield* knowledge.candidatesForTask(handle.taskId))[0]).toMatchObject({
          id: candidate.id,
          originSessionId: null,
          authorizedByUserNodeId: user.id,
        });
        expect((yield* nodes.get(memory!.id))?.text).toBe(
          "Use SQLite for durable Work Trace state.",
        );
      }),
    ),
  );

  it.effect("conversation-only and rejected dispositions never create recall nodes", () =>
    run(
      Effect.gen(function* () {
        const nodes = yield* Nodes;
        const trace = yield* WorkTraceStore;
        const knowledge = yield* KnowledgePromotions;
        yield* seed();
        const user = yield* nodes.append({
          projectId: "p1",
          sessionId: "s1",
          kind: "user",
          text: "Do not save this.",
        });
        const handle = yield* trace.startAttempt({
          sessionId: "s1",
          parentRunId: "parent-1",
          parentToolCallId: "call-1",
          agentId: "agent-1",
          title: "Research",
          request: "Research",
          kind: "start",
          threadId: "subagent-agent-1",
        });
        const claimId = yield* trace.finalizeAnswerClaim({
          projectId: "p1",
          sessionId: "s1",
          parentRunId: "parent-1",
          parentMessageId: "answer",
          usedReports: [{ taskId: handle.taskId, attemptId: handle.id }],
          reflectedNotificationIds: [],
        });
        const common = {
          projectId: "p1",
          sessionId: "s1",
          authorizedByUserNodeId: user.id,
          claimId,
          taskId: handle.taskId,
          attemptId: handle.id,
          proposedText: "Temporary conclusion",
          resolvedText: "Temporary conclusion",
        };
        expect(
          (yield* knowledge.promote({ ...common, disposition: "conversation_only" })).memoryNodeId,
        ).toBeNull();
        expect(
          (yield* knowledge.promote({ ...common, disposition: "reject" })).memoryNodeId,
        ).toBeNull();
        expect(yield* sqlGet("SELECT count(*) AS count FROM nodes WHERE kind = 'topic'")).toEqual({
          count: 0,
        });
      }),
    ),
  );
});
