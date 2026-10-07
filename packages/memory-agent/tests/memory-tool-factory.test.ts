import { chat } from "@tanstack/ai";
import { Cause, Effect, Result, Schema } from "effect";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import { Database } from "../src/db/database.ts";
import { Indexer } from "../src/memory/embedding/indexer.ts";
import { Graph } from "../src/memory/graph.ts";
import { Interpretations } from "../src/memory/interpretations.ts";
import { KnowledgePromotions } from "../src/memory/knowledge.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { MemorySearch } from "../src/memory/search.ts";
import { ScriptedTextAdapter } from "../src/testing/scripted-adapter.ts";
import { createMemoryTools, MemoryTools } from "../src/tools/memory.ts";
import { WorkTraceStore } from "../src/work-trace/store.ts";
import { testRuntime } from "./support/runtime.ts";

const environment = Effect.gen(function* () {
  return {
    search: yield* MemorySearch,
    nodes: yield* Nodes,
    graph: yield* Graph,
    interpretations: yield* Interpretations,
    knowledge: yield* KnowledgePromotions,
  };
});

it.live(
  "one pinned implementation reads the supplied native owner services, not the first runtime",
  () =>
    Effect.gen(function* () {
      const first = yield* call(() => testRuntime());
      const second = yield* call(() => testRuntime());
      const envA = yield* Effect.provideContext(environment, yield* first.runtime.contextEffect);
      const envB = yield* Effect.provideContext(environment, yield* second.runtime.contextEffect);
      const append = (env: typeof envA, fixture: typeof first, text: string) =>
        env.nodes.append({
          projectId: fixture.project.id,
          sessionId: fixture.session.id,
          kind: "user",
          text,
        });
      const a = append(envA, first, "first owner evidence");
      const b = append(envB, second, "second owner evidence");
      const pinned = createMemoryTools;
      const toolsA = pinned(envA, first.project.id).tools;
      const toolsB = pinned(envB, second.project.id).tools;
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
      const wrapper = yield* Effect.provideContext(
        MemoryTools,
        yield* second.runtime.contextEffect,
      );
      expect(
        yield* call(() => wrapper.forProject(second.project.id)[1].execute!({ id: b.id })),
      ).toMatchObject({
        text: b.text,
      });
    }),
);

it.live(
  "fresh run getters and conversation bindings are not reused; native promotion gates remain",
  () =>
    Effect.gen(function* () {
      const fixture = yield* call(() => testRuntime());
      const env = yield* Effect.provideContext(environment, yield* fixture.runtime.contextEffect);
      const user = env.nodes.append({
        projectId: fixture.project.id,
        sessionId: fixture.session.id,
        kind: "user",
        text: "save",
      });
      let currentUser = "missing";
      let readsA = 0;
      let readsB = 0;
      const a = createMemoryTools(env, fixture.project.id, {
        projectId: fixture.project.id,
        sessionId: fixture.session.id,
        runId: "run-a",
        userNodeId: () => {
          readsA++;
          return user.id;
        },
      });
      const b = createMemoryTools(env, fixture.project.id, {
        projectId: fixture.project.id,
        sessionId: fixture.session.id,
        runId: "run-b",
        userNodeId: () => {
          readsB++;
          return currentUser;
        },
      });
      if (a.tools.length !== 6 || b.tools.length !== 6) throw new Error("Expected run tools");
      const promoteA = a.tools[4];
      const promoteB = b.tools[4];
      const input = {
        claimId: "not-adopted",
        taskId: "task",
        attemptId: "attempt",
        evidenceRefIds: [],
        proposedText: "memory",
        resolvedText: "memory",
        disposition: "save" as const,
      };
      expect(
        Result.match(yield* Effect.result(call(() => promoteA!.execute!(input))), {
          onFailure: (error) => error.cause,
          onSuccess: () => null,
        }),
      ).toMatchObject({
        reason: "claim_not_adopted",
      });
      expect(
        Result.match(yield* Effect.result(call(() => promoteB!.execute!(input))), {
          onFailure: (error) => error.cause,
          onSuccess: () => null,
        }),
      ).toMatchObject({
        reason: "missing_user_authorization",
      });
      currentUser = user.id;
      expect(
        Result.match(yield* Effect.result(call(() => promoteB!.execute!(input))), {
          onFailure: (error) => error.cause,
          onSuccess: () => null,
        }),
      ).toMatchObject({
        reason: "claim_not_adopted",
      });
      expect(readsA).toBe(1);
      expect(readsB).toBe(2);
      expect(a.middleware).not.toBe(b.middleware);
      const useB = b.tools[5];
      expect(() => useB!.execute!({ memoryNodeIds: [user.id] })).toThrow(
        "Only promoted memories retrieved in this run can be used",
      );
    }),
);

it.live("the existing forRun wrapper preserves the deferred admission user-node getter", () =>
  Effect.gen(function* () {
    const fixture = yield* call(() => testRuntime());
    const env = yield* Effect.provideContext(environment, yield* fixture.runtime.contextEffect);
    const wrapper = yield* Effect.provideContext(MemoryTools, yield* fixture.runtime.contextEffect);
    let reads = 0;
    const user = env.nodes.append({
      projectId: fixture.project.id,
      sessionId: fixture.session.id,
      kind: "user",
      text: "explicit save",
    });
    const prepared = wrapper.forRun({
      projectId: fixture.project.id,
      sessionId: fixture.session.id,
      runId: "deferred-run",
      get userNodeId() {
        reads++;
        return user.id;
      },
    });
    expect(reads).toBe(0);
    if (prepared.tools.length !== 6) throw new Error("Expected run tools");
    const promote = prepared.tools[4];
    expect(
      Result.match(
        yield* Effect.result(
          call(() =>
            promote.execute!({
              claimId: "not-adopted",
              taskId: "task",
              attemptId: "attempt",
              evidenceRefIds: [],
              proposedText: "memory",
              resolvedText: "memory",
              disposition: "save",
            }),
          ),
        ),
        { onFailure: (error) => error.cause, onSuccess: () => null },
      ),
    ).toMatchObject({ reason: "claim_not_adopted" });
    expect(reads).toBe(1);
  }),
);

it.live("populated promoted-memory retrieval and use state never leak into a fresh run", () =>
  Effect.gen(function* () {
    const fixture = yield* call(() => testRuntime());
    const env = yield* Effect.provideContext(environment, yield* fixture.runtime.contextEffect);
    const db = yield* Effect.provideContext(Database, yield* fixture.runtime.contextEffect);
    const trace = yield* Effect.provideContext(
      WorkTraceStore,
      yield* fixture.runtime.contextEffect,
    );
    db.sqlite
      .prepare(
        `INSERT INTO subagents
        (id, session_id, name, instructions, status, parent_run_id, last_task, created_at, updated_at)
        VALUES ('factory-agent', ?, 'factory', 'research', 'interrupted', 'parent', 'task', 1, 1)`,
      )
      .run(fixture.session.id);
    const user = env.nodes.append({
      projectId: fixture.project.id,
      sessionId: fixture.session.id,
      kind: "user",
      text: "Save this fixture decision: isolated-memory-state.",
    });
    const handle = trace.startAttempt({
      sessionId: fixture.session.id,
      parentRunId: "parent",
      parentToolCallId: "factory-call",
      agentId: "factory-agent",
      title: "Factory research",
      request: "Research factory state",
      kind: "start",
      threadId: "factory-thread",
    });
    const evidence = trace.recordEvidence({
      handle,
      locator: { kind: "message", threadId: handle.threadId, messageId: "verified-answer" },
      verification: "verified",
    });
    trace.recordReportDisposition({
      handle,
      sessionId: fixture.session.id,
      disposition: "reviewed",
      parentRunId: "parent",
    });
    const claimId = trace.finalizeAnswerClaim({
      projectId: fixture.project.id,
      sessionId: fixture.session.id,
      parentRunId: "parent",
      parentMessageId: "research-answer",
      usedReports: [{ taskId: handle.taskId, attemptId: handle.id, evidenceRefIds: [evidence.id] }],
      reflectedNotificationIds: [],
    });
    const makeRun = (runId: string) =>
      createMemoryTools(env, fixture.project.id, {
        projectId: fixture.project.id,
        sessionId: fixture.session.id,
        runId,
        userNodeId: () => user.id,
      });
    const first = makeRun("memory-run-a");
    const second = makeRun("memory-run-b");
    if (
      first.tools.length !== 6 ||
      second.tools.length !== 6 ||
      !(first.middleware !== null) ||
      !(second.middleware !== null)
    )
      throw new Error("Expected run tools and middleware");
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
    yield* Effect.provideContext(
      Effect.flatMap(Indexer, (indexer) => indexer.indexAll()),
      yield* fixture.runtime.contextEffect,
    );
    const found = yield* call(() => first.tools[0].execute!({ query: "isolated-memory-state" }));
    expect(found).toMatchObject({
      matches: expect.arrayContaining([expect.objectContaining({ id: promoted.memoryNodeId })]),
    });
    expect(first.tools[5].execute!({ memoryNodeIds })).toMatchObject({ usedMemoryCount: 1 });
    expect(() => second.tools[5].execute!({ memoryNodeIds })).toThrow(
      "Only promoted memories retrieved in this run can be used",
    );
    const finish = (middleware: NonNullable<typeof first.middleware>) =>
      chat({
        adapter: new ScriptedTextAdapter([{ text: "fixture answer" }]),
        messages: [],
        middleware: [middleware],
        stream: false,
      });
    yield* call(() => finish(second.middleware));
    expect(env.knowledge.usageForTask(handle.taskId).map((usage) => usage.kind)).toEqual([
      "retrieved",
    ]);
    yield* call(() => finish(first.middleware));
    const usage = () =>
      env.knowledge.usageForTask(handle.taskId).map((entry) => ({
        kind: entry.kind,
        parentRunId: entry.parentRunId,
      }));
    expect(usage()).toEqual([
      { kind: "retrieved", parentRunId: "memory-run-a" },
      { kind: "used", parentRunId: "memory-run-a" },
    ]);
    yield* call(() => second.tools[0].execute!({ query: "isolated-memory-state" }));
    second.tools[5].execute!({ memoryNodeIds });
    yield* call(() => finish(second.middleware));
    expect(usage()).toEqual([
      { kind: "retrieved", parentRunId: "memory-run-a" },
      { kind: "used", parentRunId: "memory-run-a" },
      { kind: "retrieved", parentRunId: "memory-run-b" },
      { kind: "used", parentRunId: "memory-run-b" },
    ]);
  }),
);

const call = <A>(execute: () => A) =>
  Effect.tryPromise({
    try: () => Promise.resolve(execute()),
    catch: (cause) => new Cause.UnknownError(cause),
  });
