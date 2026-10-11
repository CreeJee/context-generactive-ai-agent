import { chat } from "@tanstack/ai";
import { layer } from "@effect/vitest";
import { Cause, Context, Effect, Layer, Schema } from "effect";
import { expect } from "vite-plus/test";
import { Database } from "../../src/db/database.ts";
import { Indexer } from "../../src/memory/embedding/indexer.ts";
import { Graph } from "../../src/memory/graph.ts";
import { Interpretations } from "../../src/memory/interpretations.ts";
import { KnowledgePromotions } from "../../src/memory/knowledge.ts";
import { Nodes } from "../../src/memory/nodes.ts";
import { MemorySearch } from "../../src/memory/search.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import { ScriptedTextAdapter } from "../../src/testing/scripted-adapter.ts";
import { createMemoryTools, MemoryTools } from "../../src/tools/memory.ts";
import { WorkTraceStore } from "../../src/work-trace/store.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";

const environment = Effect.gen(function* () {
  return {
    search: yield* MemorySearch,
    nodes: yield* Nodes,
    graph: yield* Graph,
    interpretations: yield* Interpretations,
    knowledge: yield* KnowledgePromotions,
  };
});

const call = <A>(execute: () => A) =>
  Effect.tryPromise({
    try: () => Promise.resolve(execute()),
    catch: (cause) => new Cause.UnknownError(cause),
  });

/** The typed reason a tool call failed with, or null when it succeeded. */
const refusal = <A>(execute: () => A) =>
  Effect.match(call(execute), { onFailure: (error) => error.cause, onSuccess: () => null });

/** Each test gets its own session in the shared agent; run IDs are global, so they carry it. */
const freshSession = Effect.gen(function* () {
  const { project } = yield* TestEnv;
  const session = (yield* (yield* Sessions).create(project.id)).id;
  return { projectId: project.id, sessionId: session };
});

const unadoptedClaim = {
  claimId: "not-adopted",
  taskId: "task",
  attemptId: "attempt",
  evidenceRefIds: [],
  proposedText: "memory",
  resolvedText: "memory",
  disposition: "save" as const,
};

/** A second agent over its own storage, beside the block's own. */
class OtherStore extends Context.Service<OtherStore, TestEnv["Service"]>()(
  "memory-agent/tests/memory/tools.test/OtherStore",
) {}

layer(
  Layer.merge(
    TestEnv.layer(),
    Layer.effect(OtherStore, TestEnv).pipe(Layer.provide(TestEnv.layer())),
  ),
  { excludeTestServices: true },
)("memory tools across agents", (it) => {
  it.effect(
    "one pinned implementation reads the supplied native owner services, not the first agent",
    () =>
      Effect.gen(function* () {
        const first = yield* TestEnv;
        const second = yield* OtherStore;
        const envA = yield* environment;
        const envB = yield* second.use(environment);
        const append = (env: typeof envA, fixture: typeof first, text: string) =>
          env.nodes.append({
            projectId: fixture.project.id,
            sessionId: fixture.session.id,
            kind: "user",
            text,
          });
        const a = append(envA, first, "first owner evidence");
        const b = append(envB, second, "second owner evidence");
        const toolsA = createMemoryTools(envA, first.project.id).tools;
        const toolsB = createMemoryTools(envB, second.project.id).tools;
        expect(yield* call(() => toolsA[1].execute!({ id: a.id }))).toMatchObject({ text: a.text });
        expect(yield* call(() => toolsB[1].execute!({ id: b.id }))).toMatchObject({ text: b.text });
        expect(yield* call(() => toolsB[1].execute!({ id: a.id }))).toEqual({
          error: "not_found",
          id: a.id,
        });
        expect(yield* call(() => toolsA[1].execute!({ id: b.id }))).toEqual({
          error: "not_found",
          id: b.id,
        });
        const wrapper = yield* second.use(MemoryTools);
        expect(
          yield* call(() => wrapper.forProject(second.project.id)[1].execute!({ id: b.id })),
        ).toMatchObject({ text: b.text });
      }),
  );
});

testAgent()("memory tools per run", (it) => {
  it.effect(
    "fresh run getters and conversation bindings are not reused; native promotion gates remain",
    () =>
      Effect.gen(function* () {
        const at = yield* freshSession;
        const env = yield* environment;
        const user = env.nodes.append({ ...at, kind: "user", text: "save" });
        let currentUser = "missing";
        let readsA = 0;
        let readsB = 0;
        const a = createMemoryTools(env, at.projectId, {
          ...at,
          runId: `${at.sessionId}:run-a`,
          userNodeId: () => {
            readsA++;
            return user.id;
          },
        });
        const b = createMemoryTools(env, at.projectId, {
          ...at,
          runId: `${at.sessionId}:run-b`,
          userNodeId: () => {
            readsB++;
            return currentUser;
          },
        });
        if (a.tools.length !== 6 || b.tools.length !== 6)
          return expect.unreachable("Expected run tools");
        const promoteA = a.tools[4];
        const promoteB = b.tools[4];
        expect(yield* refusal(() => promoteA.execute!(unadoptedClaim))).toMatchObject({
          reason: "claim_not_adopted",
        });
        expect(yield* refusal(() => promoteB.execute!(unadoptedClaim))).toMatchObject({
          reason: "missing_user_authorization",
        });
        currentUser = user.id;
        expect(yield* refusal(() => promoteB.execute!(unadoptedClaim))).toMatchObject({
          reason: "claim_not_adopted",
        });
        expect(readsA).toBe(1);
        expect(readsB).toBe(2);
        expect(a.middleware).not.toBe(b.middleware);
        const useB = b.tools[5];
        expect(() => useB.execute!({ memoryNodeIds: [user.id] })).toThrow(
          "Only promoted memories retrieved in this run can be used",
        );
      }),
  );

  it.effect("the existing forRun wrapper preserves the deferred admission user-node getter", () =>
    Effect.gen(function* () {
      const at = yield* freshSession;
      const env = yield* environment;
      let reads = 0;
      const user = env.nodes.append({ ...at, kind: "user", text: "explicit save" });
      const prepared = (yield* MemoryTools).forRun({
        ...at,
        runId: `${at.sessionId}:deferred-run`,
        get userNodeId() {
          reads++;
          return user.id;
        },
      });
      expect(reads).toBe(0);
      if (prepared.tools.length !== 6) return expect.unreachable("Expected run tools");
      const promote = prepared.tools[4];
      expect(yield* refusal(() => promote.execute!(unadoptedClaim))).toMatchObject({
        reason: "claim_not_adopted",
      });
      expect(reads).toBe(1);
    }),
  );

  it.effect("populated promoted-memory retrieval and use state never leak into a fresh run", () =>
    Effect.gen(function* () {
      const at = yield* freshSession;
      const { sessionId } = at;
      const env = yield* environment;
      const db = yield* Database;
      const trace = yield* WorkTraceStore;
      const agentId = `${sessionId}:factory-agent`;
      const parentRunId = `${sessionId}:parent`;
      db.sqlite
        .prepare(
          `INSERT INTO subagents
          (id, session_id, name, instructions, status, parent_run_id, last_task, created_at, updated_at)
          VALUES (?, ?, 'factory', 'research', 'interrupted', ?, 'task', 1, 1)`,
        )
        .run(agentId, sessionId, parentRunId);
      const user = env.nodes.append({
        ...at,
        kind: "user",
        text: "Save this fixture decision: isolated-memory-state.",
      });
      const handle = trace.startAttempt({
        sessionId,
        parentRunId,
        parentToolCallId: `${sessionId}:factory-call`,
        agentId,
        title: "Factory research",
        request: "Research factory state",
        kind: "start",
        threadId: `${sessionId}:factory-thread`,
      });
      const evidence = trace.recordEvidence({
        handle,
        locator: { kind: "message", threadId: handle.threadId, messageId: "verified-answer" },
        verification: "verified",
      });
      trace.recordReportDisposition({ handle, sessionId, disposition: "reviewed", parentRunId });
      const claimId = trace.finalizeAnswerClaim({
        ...at,
        parentRunId,
        parentMessageId: "research-answer",
        usedReports: [
          { taskId: handle.taskId, attemptId: handle.id, evidenceRefIds: [evidence.id] },
        ],
        reflectedNotificationIds: [],
      });
      const runA = `${sessionId}:memory-run-a`;
      const runB = `${sessionId}:memory-run-b`;
      const makeRun = (runId: string) =>
        createMemoryTools(env, at.projectId, { ...at, runId, userNodeId: () => user.id });
      const first = makeRun(runA);
      const second = makeRun(runB);
      if (
        first.tools.length !== 6 ||
        second.tools.length !== 6 ||
        first.middleware === null ||
        second.middleware === null
      )
        return expect.unreachable("Expected run tools and middleware");
      const promoted = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ memoryNodeId: Schema.NonEmptyString }),
      )(
        yield* call(() =>
          first.tools[4].execute!({
            claimId,
            taskId: handle.taskId,
            attemptId: handle.id,
            evidenceRefIds: [evidence.id],
            proposedText: "isolated-memory-state is a fixture decision",
            resolvedText: "isolated-memory-state is a fixture decision",
            disposition: "save",
          }),
        ),
      );
      const memoryNodeIds = [promoted.memoryNodeId];
      yield* (yield* Indexer).indexAll();
      const found = yield* call(() => first.tools[0].execute!({ query: "isolated-memory-state" }));
      expect(found).toMatchObject({
        matches: expect.arrayContaining([expect.objectContaining({ id: promoted.memoryNodeId })]),
      });
      expect(first.tools[5].execute!({ memoryNodeIds })).toMatchObject({ usedMemoryCount: 1 });
      expect(() => second.tools[5].execute!({ memoryNodeIds })).toThrow(
        "Only promoted memories retrieved in this run can be used",
      );
      const finish = (middleware: NonNullable<typeof first.middleware>) =>
        call(() =>
          chat({
            adapter: new ScriptedTextAdapter([{ text: "fixture answer" }]),
            messages: [],
            middleware: [middleware],
            stream: false,
          }),
        );
      yield* finish(second.middleware);
      expect(env.knowledge.usageForTask(handle.taskId).map((usage) => usage.kind)).toEqual([
        "retrieved",
      ]);
      yield* finish(first.middleware);
      const usage = () =>
        env.knowledge.usageForTask(handle.taskId).map((entry) => ({
          kind: entry.kind,
          parentRunId: entry.parentRunId,
        }));
      expect(usage()).toEqual([
        { kind: "retrieved", parentRunId: runA },
        { kind: "used", parentRunId: runA },
      ]);
      yield* call(() => second.tools[0].execute!({ query: "isolated-memory-state" }));
      second.tools[5].execute!({ memoryNodeIds });
      yield* finish(second.middleware);
      expect(usage()).toEqual([
        { kind: "retrieved", parentRunId: runA },
        { kind: "used", parentRunId: runA },
        { kind: "retrieved", parentRunId: runB },
        { kind: "used", parentRunId: runB },
      ]);
    }),
  );
});
