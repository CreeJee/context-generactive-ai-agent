import { chat } from "@tanstack/ai";
import { Effect, Schema } from "effect";
import { expect, test } from "vite-plus/test";
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

test("one pinned implementation reads the supplied native owner services, not the first runtime", async () => {
  const first = await testRuntime();
  const second = await testRuntime();
  const envA = await first.runtime.runPromise(environment);
  const envB = await second.runtime.runPromise(environment);
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
  expect(await toolsA[1].execute!({ id: a.id })).toMatchObject({ text: a.text });
  expect(await toolsB[1].execute!({ id: b.id })).toMatchObject({ text: b.text });
  expect(await toolsB[1].execute!({ id: a.id })).toEqual({ error: "not_found", id: a.id });
  expect(await toolsA[1].execute!({ id: b.id })).toEqual({ error: "not_found", id: b.id });
  const wrapper = await second.runtime.runPromise(MemoryTools);
  expect(await wrapper.forProject(second.project.id)[1].execute!({ id: b.id })).toMatchObject({
    text: b.text,
  });
});

test("fresh run getters and conversation bindings are not reused; native promotion gates remain", async () => {
  const fixture = await testRuntime();
  const env = await fixture.runtime.runPromise(environment);
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
  await expect(promoteA!.execute!(input)).rejects.toMatchObject({ reason: "claim_not_adopted" });
  await expect(promoteB!.execute!(input)).rejects.toMatchObject({
    reason: "missing_user_authorization",
  });
  currentUser = user.id;
  await expect(promoteB!.execute!(input)).rejects.toMatchObject({ reason: "claim_not_adopted" });
  expect(readsA).toBe(1);
  expect(readsB).toBe(2);
  expect(a.middleware).not.toBe(b.middleware);
  const useB = b.tools[5];
  expect(() => useB!.execute!({ memoryNodeIds: [user.id] })).toThrow(
    "Only promoted memories retrieved in this run can be used",
  );
});

test("the existing forRun wrapper preserves the deferred admission user-node getter", async () => {
  const fixture = await testRuntime();
  const env = await fixture.runtime.runPromise(environment);
  const wrapper = await fixture.runtime.runPromise(MemoryTools);
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
  await expect(
    prepared.tools[4].execute!({
      claimId: "not-adopted",
      taskId: "task",
      attemptId: "attempt",
      evidenceRefIds: [],
      proposedText: "memory",
      resolvedText: "memory",
      disposition: "save",
    }),
  ).rejects.toMatchObject({ reason: "claim_not_adopted" });
  expect(reads).toBe(1);
});

test("populated promoted-memory retrieval and use state never leak into a fresh run", async () => {
  const fixture = await testRuntime();
  const env = await fixture.runtime.runPromise(environment);
  const db = await fixture.runtime.runPromise(Database);
  const trace = await fixture.runtime.runPromise(WorkTraceStore);
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
    !first.middleware ||
    !second.middleware
  )
    throw new Error("Expected run tools and middleware");
  const promoted = Schema.decodeUnknownSync(Schema.Struct({ memoryNodeId: Schema.NonEmptyString }))(
    await first.tools[4].execute!({
      claimId,
      taskId: handle.taskId,
      attemptId: handle.id,
      evidenceRefIds: [evidence.id],
      proposedText: "isolated-memory-state is a fixture decision",
      resolvedText: "isolated-memory-state is a fixture decision",
      disposition: "save",
    }),
  );
  const memoryNodeIds = [promoted.memoryNodeId];
  await fixture.runtime.runPromise(Effect.flatMap(Indexer, (indexer) => indexer.indexAll()));
  const found = await first.tools[0].execute!({ query: "isolated-memory-state" });
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
  await finish(second.middleware);
  expect(env.knowledge.usageForTask(handle.taskId).map((usage) => usage.kind)).toEqual([
    "retrieved",
  ]);
  await finish(first.middleware);
  const usage = () =>
    env.knowledge.usageForTask(handle.taskId).map((entry) => ({
      kind: entry.kind,
      parentRunId: entry.parentRunId,
    }));
  expect(usage()).toEqual([
    { kind: "retrieved", parentRunId: "memory-run-a" },
    { kind: "used", parentRunId: "memory-run-a" },
  ]);
  await second.tools[0].execute!({ query: "isolated-memory-state" });
  second.tools[5].execute!({ memoryNodeIds });
  await finish(second.middleware);
  expect(usage()).toEqual([
    { kind: "retrieved", parentRunId: "memory-run-a" },
    { kind: "used", parentRunId: "memory-run-a" },
    { kind: "retrieved", parentRunId: "memory-run-b" },
    { kind: "used", parentRunId: "memory-run-b" },
  ]);
});
