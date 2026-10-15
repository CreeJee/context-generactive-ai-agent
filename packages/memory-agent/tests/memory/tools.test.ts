import { chat } from "@tanstack/ai";
import { layer } from "@effect/vitest";
import { Cause, Context, Effect, FileSystem, Layer, Schema } from "effect";
import { expect } from "vite-plus/test";
import { Database } from "../../src/db/database.ts";
import { Indexer } from "../../src/memory/embedding/indexer.ts";
import { Graph } from "../../src/memory/graph.ts";
import { Interpretations } from "../../src/memory/interpretations.ts";
import { KnowledgePromotions } from "../../src/memory/knowledge.ts";
import { Nodes } from "../../src/memory/nodes.ts";
import { MemorySearch } from "../../src/memory/search.ts";
import { Projects } from "../../src/projects/projects.ts";
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

testAgent()("structured memory evidence", (it) => {
  it.effect("preserves exact pages and prioritizes direct changes within the excerpt budget", () =>
    Effect.gen(function* () {
      const at = yield* freshSession;
      const env = yield* environment;
      const original = env.nodes.append({ ...at, kind: "user", text: "original ".repeat(600) });
      const replacement = env.nodes.append({
        ...at,
        kind: "user",
        text: "x".repeat(599) + "😀 replacement",
      });
      env.interpretations.record({
        nodeId: replacement.id,
        targetId: original.id,
        kind: "corrects",
        status: "applied",
        reason: "changed decision",
        model: "fixture",
      });
      const retraction = env.nodes.append({
        ...at,
        kind: "user",
        text: "Withdraw that replacement.",
      });
      env.interpretations.record({
        nodeId: retraction.id,
        targetId: replacement.id,
        kind: "retracts",
        status: "applied",
        reason: "withdrawal",
        model: "fixture",
      });
      for (let index = 0; index < 9; index++) {
        const pending = env.nodes.append({ ...at, kind: "user", text: `possible change ${index}` });
        env.interpretations.record({
          nodeId: pending.id,
          targetId: original.id,
          kind: "corrects",
          status: "unconfirmed",
          reason: "ambiguous target",
          model: "fixture",
        });
      }
      const read = createMemoryTools(env, at.projectId).tools[1];
      const result = yield* call(() => read.execute!({ id: original.id, offset: 4000 }));
      expect(result).toHaveProperty("evidenceContext.changes.length", 8);
      expect(result).toHaveProperty("evidenceContext.changes.0.source.id", replacement.id);
      expect(result).toMatchObject({
        ...env.nodes.read(original.id, 4000),
        evidenceContext: {
          assessment: { kind: "recorded_change" },
          hasUnconfirmedChanges: true,
          sourceSpan: { start: 4000, end: original.text.length, unit: "utf16" },
          omittedChanges: 2,
          changes: expect.arrayContaining([
            {
              source: expect.objectContaining({
                id: replacement.id,
                text: "x".repeat(599),
                span: { start: 0, end: 599, unit: "utf16" },
                nextOffset: 599,
              }),
              targetId: original.id,
              relation: "corrects",
              status: "applied",
            },
          ]),
        },
      });
      expect(yield* call(() => read.execute!({ id: replacement.id, offset: 599 }))).toMatchObject({
        text: "😀 replacement",
        evidenceContext: {
          assessment: { kind: "recorded_change" },
          changes: [
            {
              source: expect.objectContaining({ id: retraction.id }),
              targetId: replacement.id,
              relation: "retracts",
              status: "applied",
            },
          ],
        },
      });
    }),
  );

  it.effect(
    "keeps pending changes unresolved and rejects non-user or older correction sources",
    () =>
      Effect.gen(function* () {
        const at = yield* freshSession;
        const env = yield* environment;
        const older = env.nodes.append({ ...at, kind: "user", text: "earlier statement" });
        const original = env.nodes.append({ ...at, kind: "user", text: "decision" });
        const assistant = env.nodes.append({
          ...at,
          kind: "assistant",
          text: "I changed your decision",
        });
        for (const source of [older, assistant]) {
          env.interpretations.record({
            nodeId: source.id,
            targetId: original.id,
            kind: "corrects",
            status: "applied",
            reason: "invalid authority",
            model: "fixture",
          });
        }
        const read = createMemoryTools(env, at.projectId).tools[1];
        expect(yield* call(() => read.execute!({ id: original.id }))).toMatchObject({
          evidenceContext: { assessment: { kind: "no_recorded_change" }, changes: [] },
        });
        const pending = env.nodes.append({ ...at, kind: "user", text: "Maybe change that" });
        env.interpretations.record({
          nodeId: pending.id,
          targetId: original.id,
          kind: "retracts",
          status: "unconfirmed",
          reason: "ambiguous",
          model: "fixture",
        });
        expect(yield* call(() => read.execute!({ id: original.id }))).toMatchObject({
          evidenceContext: {
            assessment: { kind: "unresolved" },
            hasUnconfirmedChanges: true,
            changes: [
              {
                source: expect.objectContaining({ id: pending.id }),
                targetId: original.id,
                relation: "retracts",
                status: "unconfirmed",
              },
            ],
          },
        });
        env.interpretations.record({
          nodeId: pending.id,
          targetId: original.id,
          kind: "retracts",
          status: "applied",
          reason: "confirmed by the user",
          model: "fixture",
        });
        expect(yield* call(() => read.execute!({ id: original.id }))).toMatchObject({
          evidenceContext: {
            assessment: { kind: "recorded_change" },
            hasUnconfirmedChanges: false,
            changes: [{ source: expect.objectContaining({ id: pending.id }), status: "applied" }],
          },
        });
      }),
  );

  it.effect("distinguishes an ancestor correction from a changed observation", () =>
    Effect.gen(function* () {
      const at = yield* freshSession;
      const env = yield* environment;
      const user = env.nodes.append({ ...at, kind: "user", text: "Read the staging settings." });
      const assistant = env.nodes.append({
        ...at,
        kind: "assistant",
        text: "Reading staging",
        detail: { partial: true },
        links: [{ kind: "reply", nodeId: user.id }],
      });
      const tool = env.nodes.append({
        ...at,
        kind: "tool_call",
        text: "read settings",
        links: [{ kind: "calls", nodeId: assistant.id }],
      });
      const result = env.nodes.append({
        ...at,
        kind: "tool_result",
        text: "read failed",
        detail: { ok: false },
        links: [{ kind: "returns", nodeId: tool.id }],
      });
      const changed = env.nodes.append({ ...at, kind: "user", text: "I meant production." });
      env.interpretations.record({
        nodeId: changed.id,
        targetId: user.id,
        kind: "corrects",
        status: "applied",
        reason: "different environment",
        model: "fixture",
      });
      const read = createMemoryTools(env, at.projectId).tools[1];
      expect(yield* call(() => read.execute!({ id: result.id }))).toMatchObject({
        text: result.text,
        detail: { ok: false },
        evidenceContext: {
          assessment: { kind: "context_changed" },
          provenance: [
            expect.objectContaining({ id: tool.id }),
            expect.objectContaining({ id: assistant.id, detail: { partial: true } }),
            expect.objectContaining({ id: user.id }),
          ],
          changes: [
            {
              source: expect.objectContaining({ id: changed.id }),
              targetId: user.id,
              relation: "corrects",
              status: "applied",
            },
          ],
        },
      });
    }),
  );

  it.effect("applies current project visibility to sources, provenance and challenges", () =>
    Effect.gen(function* () {
      const at = yield* freshSession;
      const env = yield* environment;
      const fixture = yield* TestEnv;
      const projects = yield* Projects;
      const fs = yield* FileSystem.FileSystem;
      const other = yield* projects.add(yield* fs.makeTempDirectory({ directory: fixture.base }));
      const session = yield* (yield* Sessions).create(other.id);
      const otherAt = { projectId: other.id, sessionId: session.id };
      const hidden = env.nodes.append({ ...otherAt, kind: "user", text: "other project source" });
      const root = env.nodes.append({
        ...at,
        kind: "assistant",
        text: "visible source",
        links: [{ kind: "reply", nodeId: hidden.id }],
      });
      const foreignChange = env.nodes.append({
        ...otherAt,
        kind: "user",
        text: "foreign correction",
      });
      for (const status of ["applied", "unconfirmed"] as const) {
        env.interpretations.record({
          nodeId: foreignChange.id,
          targetId: root.id,
          kind: "corrects",
          status,
          reason: "different scope",
          model: "fixture",
        });
      }
      const shared = createMemoryTools(env, at.projectId).tools[1];
      const scoped = createMemoryTools(env, at.projectId, undefined, "project").tools[1];
      expect(yield* call(() => shared.execute!({ id: root.id }))).toMatchObject({
        evidenceContext: { provenance: [expect.objectContaining({ id: hidden.id })], changes: [] },
      });
      expect(yield* call(() => scoped.execute!({ id: root.id }))).toMatchObject({
        evidenceContext: { provenance: [], changes: [], provenanceScopeLimited: true },
      });
      expect(yield* call(() => scoped.execute!({ id: hidden.id }))).toEqual({
        error: "not_found",
        id: hidden.id,
      });
      yield* projects.setCrossRecallExcluded(other.id, true);
      expect(yield* call(() => shared.execute!({ id: root.id }))).toMatchObject({
        evidenceContext: { provenance: [], changes: [], provenanceScopeLimited: true },
      });
      expect(yield* call(() => shared.execute!({ id: hidden.id }))).toEqual({
        error: "not_found",
        id: hidden.id,
      });
    }),
  );

  it.effect("reports an unavailable trace and fails closed on storage errors", () =>
    Effect.gen(function* () {
      const at = yield* freshSession;
      const env = yield* environment;
      const node = env.nodes.append({ ...at, kind: "user", text: "evidence" });
      const untraced = createMemoryTools(
        { ...env, graph: { ...env.graph, trace: () => null } },
        at.projectId,
      ).tools[1];
      expect(yield* call(() => untraced.execute!({ id: node.id }))).toMatchObject({
        evidenceContext: { assessment: { kind: "untraced" } },
      });
      const broken = createMemoryTools(
        {
          ...env,
          graph: {
            ...env.graph,
            trace: () => {
              throw new DOMException("private storage detail", "InvalidStateError");
            },
          },
        },
        at.projectId,
      ).tools[1];
      const failure = yield* refusal(() => broken.execute!({ id: node.id }));
      expect(failure).toMatchObject({
        _tag: "EvidenceReadFailed",
        reason: { _tag: "StorageRead", stage: "trace" },
      });
      expect(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(failure),
      ).not.toContain("private storage detail");
    }),
  );
});

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
