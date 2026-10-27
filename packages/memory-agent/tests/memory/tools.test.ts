import { layer } from "@effect/vitest";
import { Context, Effect, FileSystem, Layer, Schema, Tracer } from "effect";
import { expect } from "vite-plus/test";
import { StepEnded, type RunHook } from "../../src/loop/run.ts";
import { RunEnd } from "../../src/loop/store.ts";
import { Indexer } from "../../src/memory/embedding/indexer.ts";
import { Graph, GraphReadFailed } from "../../src/memory/graph.ts";
import { Interpretations } from "../../src/memory/interpretations.ts";
import { KnowledgePromotions } from "../../src/memory/knowledge.ts";
import { Nodes } from "../../src/memory/nodes.ts";
import { MemorySearch } from "../../src/memory/search.ts";
import { Projects } from "../../src/projects/projects.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import {
  MemoryTools,
  memoryReadRunTools,
  memoryRunTools,
  type MemoryToolEnvironment,
} from "../../src/tools/memory.ts";
import type { RunTool } from "../../src/tools/run-tool.ts";
import { WorkTraceStore } from "../../src/work-trace/store.ts";
import type { JsonValue } from "../../src/json.ts";
import { callTool } from "../support/run-tools.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";
import { sqlRun } from "../support/sql.ts";

const environment = Effect.gen(function* () {
  return {
    search: yield* MemorySearch,
    nodes: yield* Nodes,
    graph: yield* Graph,
    interpretations: yield* Interpretations,
    knowledge: yield* KnowledgePromotions,
  };
});

/** The memory tools, by name, called as the model would. */
const callers = (tools: ReadonlyArray<RunTool>) => {
  const named = (name: string) => (params: JsonValue) => callTool(tools, name, params);
  return {
    find: named("find_memory"),
    read: named("read_evidence"),
    trace: named("trace_evidence"),
    promote: named("promote_memory_candidate"),
    use: named("use_promoted_memory"),
  };
};

/** The read-only tools over `env`'s memory of every project cross recall allows. */
const reads = (env: MemoryToolEnvironment, projectId: string) =>
  callers(memoryReadRunTools({ env, projectId }));

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
      const original = yield* env.nodes.append({
        ...at,
        kind: "user",
        text: "original ".repeat(600),
      });
      const replacement = yield* env.nodes.append({
        ...at,
        kind: "user",
        text: "x".repeat(599) + "😀 replacement",
      });
      yield* env.interpretations.record({
        nodeId: replacement.id,
        targetId: original.id,
        kind: "corrects",
        status: "applied",
        reason: "changed decision",
        model: "fixture",
      });
      const retraction = yield* env.nodes.append({
        ...at,
        kind: "user",
        text: "Withdraw that replacement.",
      });
      yield* env.interpretations.record({
        nodeId: retraction.id,
        targetId: replacement.id,
        kind: "retracts",
        status: "applied",
        reason: "withdrawal",
        model: "fixture",
      });
      for (let index = 0; index < 9; index++) {
        const pending = yield* env.nodes.append({
          ...at,
          kind: "user",
          text: `possible change ${index}`,
        });
        yield* env.interpretations.record({
          nodeId: pending.id,
          targetId: original.id,
          kind: "corrects",
          status: "unconfirmed",
          reason: "ambiguous target",
          model: "fixture",
        });
      }
      const { read } = reads(env, at.projectId);
      const result = yield* read({ id: original.id, offset: 4000 });
      expect(result).toHaveProperty("evidenceContext.changes.length", 8);
      expect(result).toHaveProperty("evidenceContext.changes.0.source.id", replacement.id);
      expect(result).toMatchObject({
        ...(yield* env.nodes.read(original.id, 4000)),
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
      expect(yield* read({ id: replacement.id, offset: 599 })).toMatchObject({
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
        const older = yield* env.nodes.append({ ...at, kind: "user", text: "earlier statement" });
        const original = yield* env.nodes.append({ ...at, kind: "user", text: "decision" });
        const assistant = yield* env.nodes.append({
          ...at,
          kind: "assistant",
          text: "I changed your decision",
        });
        for (const source of [older, assistant]) {
          yield* env.interpretations.record({
            nodeId: source.id,
            targetId: original.id,
            kind: "corrects",
            status: "applied",
            reason: "invalid authority",
            model: "fixture",
          });
        }
        const { read } = reads(env, at.projectId);
        expect(yield* read({ id: original.id })).toMatchObject({
          evidenceContext: { assessment: { kind: "no_recorded_change" }, changes: [] },
        });
        const pending = yield* env.nodes.append({ ...at, kind: "user", text: "Maybe change that" });
        yield* env.interpretations.record({
          nodeId: pending.id,
          targetId: original.id,
          kind: "retracts",
          status: "unconfirmed",
          reason: "ambiguous",
          model: "fixture",
        });
        expect(yield* read({ id: original.id })).toMatchObject({
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
        yield* env.interpretations.record({
          nodeId: pending.id,
          targetId: original.id,
          kind: "retracts",
          status: "applied",
          reason: "confirmed by the user",
          model: "fixture",
        });
        expect(yield* read({ id: original.id })).toMatchObject({
          evidenceContext: {
            assessment: { kind: "recorded_change" },
            hasUnconfirmedChanges: false,
            changes: [{ source: expect.objectContaining({ id: pending.id }), status: "applied" }],
          },
        });
      }),
  );

  it.effect("judges changes by one authority rule in find, trace and read", () =>
    Effect.gen(function* () {
      const at = yield* freshSession;
      const env = yield* environment;
      const older = yield* env.nodes.append({ ...at, kind: "user", text: "earlier note" });
      const original = yield* env.nodes.append({
        ...at,
        kind: "user",
        text: "배포 창구는 화요일 오후로 정했다",
      });
      const assistant = yield* env.nodes.append({ ...at, kind: "assistant", text: "changed it" });
      const later = yield* env.nodes.append({
        ...at,
        kind: "user",
        text: "수요일 오전으로 바꾸자",
      });
      for (const source of [older, assistant, later])
        yield* env.interpretations.record({
          nodeId: source.id,
          targetId: original.id,
          kind: "corrects",
          status: "applied",
          reason: "fixture",
          model: "fixture",
        });
      yield* env.interpretations.record({
        nodeId: later.id,
        targetId: original.id,
        kind: "corrects",
        status: "unconfirmed",
        reason: "resolved later",
        model: "fixture",
      });
      yield* Effect.flatMap(Indexer, (indexer) => indexer.indexAll());
      const { find, read, trace } = reads(env, at.projectId);
      expect(yield* find({ query: "배포 창구 화요일" })).toMatchObject({
        matches: expect.arrayContaining([
          expect.objectContaining({
            id: original.id,
            supersededBy: [{ id: later.id, relation: "corrects" }],
            unconfirmedChallenges: 0,
          }),
        ]),
      });
      expect(yield* trace({ id: original.id })).toMatchObject({
        challengedBy: [{ id: later.id, relation: "corrects", target: original.id }],
        unconfirmed: [],
      });
      expect(yield* read({ id: original.id })).toMatchObject({
        evidenceContext: {
          assessment: { kind: "recorded_change" },
          hasUnconfirmedChanges: false,
          changes: [{ source: expect.objectContaining({ id: later.id }), status: "applied" }],
        },
      });
    }),
  );

  it.effect("names every end of a change chain without choosing between branches", () =>
    Effect.gen(function* () {
      const at = yield* freshSession;
      const env = yield* environment;
      const user = (text: string) => env.nodes.append({ ...at, kind: "user", text });
      const change = (
        source: { readonly id: string },
        target: { readonly id: string },
        kind: "corrects" | "retracts",
        status: "applied" | "unconfirmed" = "applied",
      ) =>
        env.interpretations.record({
          nodeId: source.id,
          targetId: target.id,
          kind,
          status,
          reason: "fixture",
          model: "fixture",
        });
      const root = yield* user("Orion 캐시 포트는 7000으로 정했다");
      const second = yield* user("Orion 캐시 포트를 7100으로 바꾼다");
      const third = yield* user("Orion 캐시 포트는 7200이 맞다");
      const withdrawn = yield* user("Orion 7200 결정은 철회한다");
      const branch = yield* user("Orion 스테이징만 7300으로 둔다");
      const maybe = yield* user("Orion 철회도 다시 생각해 보자");
      yield* change(second, root, "corrects");
      yield* change(third, second, "corrects");
      yield* change(withdrawn, third, "retracts");
      yield* change(branch, root, "corrects");
      yield* change(maybe, withdrawn, "retracts", "unconfirmed");
      yield* Effect.flatMap(Indexer, (indexer) => indexer.indexAll());
      const { find } = reads(env, at.projectId);
      expect(yield* find({ query: "Orion 캐시 포트 7000" })).toMatchObject({
        matches: expect.arrayContaining([
          expect.objectContaining({
            id: root.id,
            latest: {
              kind: "branched",
              heads: [
                expect.objectContaining({ id: branch.id, depth: 1, recordedRank: 1 }),
                expect.objectContaining({
                  id: withdrawn.id,
                  relation: "retracts",
                  recordedRank: 2,
                }),
              ],
              unconfirmedAfter: true,
              truncated: false,
            },
          }),
        ]),
      });
    }),
  );

  it.effect("traces a read that a later read of the changed file superseded", () =>
    Effect.gen(function* () {
      const at = yield* freshSession;
      const env = yield* environment;
      const read = Effect.fnUntraced(function* (content: string, sha256: string) {
        const call = yield* env.nodes.append({
          ...at,
          kind: "tool_call",
          text: 'read_file {"path":"config.toml"}',
          detail: { toolName: "read_file" },
          refs: ["config.toml"],
        });
        const result = yield* env.nodes.append({
          ...at,
          kind: "tool_result",
          text: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
            path: "config.toml",
            sha256,
            content,
          }),
          detail: { toolName: "read_file", ok: true },
          links: [{ kind: "returns", nodeId: call.id }],
        });
        return { call, result };
      });
      const first = yield* read("retries = 2", "a".repeat(64));
      yield* read("retries = 5", "b".repeat(64));
      const { read: readEvidence, trace } = reads(env, at.projectId);
      expect(yield* readEvidence({ id: first.result.id })).toMatchObject({
        evidenceContext: {
          assessment: { kind: "no_recorded_change" },
          provenance: [expect.objectContaining({ id: first.call.id })],
        },
      });
      expect(yield* trace({ id: first.result.id })).toMatchObject({
        chain: [{ id: first.result.id }, { id: first.call.id }],
      });
    }),
  );

  it.effect("distinguishes an ancestor correction from a changed observation", () =>
    Effect.gen(function* () {
      const at = yield* freshSession;
      const env = yield* environment;
      const user = yield* env.nodes.append({
        ...at,
        kind: "user",
        text: "Read the staging settings.",
      });
      const assistant = yield* env.nodes.append({
        ...at,
        kind: "assistant",
        text: "Reading staging",
        detail: { partial: true },
        links: [{ kind: "reply", nodeId: user.id }],
      });
      const tool = yield* env.nodes.append({
        ...at,
        kind: "tool_call",
        text: "read settings",
        links: [{ kind: "calls", nodeId: assistant.id }],
      });
      const result = yield* env.nodes.append({
        ...at,
        kind: "tool_result",
        text: "read failed",
        detail: { ok: false },
        links: [{ kind: "returns", nodeId: tool.id }],
      });
      const changed = yield* env.nodes.append({ ...at, kind: "user", text: "I meant production." });
      yield* env.interpretations.record({
        nodeId: changed.id,
        targetId: user.id,
        kind: "corrects",
        status: "applied",
        reason: "different environment",
        model: "fixture",
      });
      const { read } = reads(env, at.projectId);
      expect(yield* read({ id: result.id })).toMatchObject({
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
      const hidden = yield* env.nodes.append({
        ...otherAt,
        kind: "user",
        text: "other project source",
      });
      const root = yield* env.nodes.append({
        ...at,
        kind: "assistant",
        text: "visible source",
        links: [{ kind: "reply", nodeId: hidden.id }],
      });
      const foreignChange = yield* env.nodes.append({
        ...otherAt,
        kind: "user",
        text: "foreign correction",
      });
      for (const status of ["applied", "unconfirmed"] as const) {
        yield* env.interpretations.record({
          nodeId: foreignChange.id,
          targetId: root.id,
          kind: "corrects",
          status,
          reason: "different scope",
          model: "fixture",
        });
      }
      const shared = reads(env, at.projectId).read;
      const scoped = callers(
        memoryReadRunTools({ env, projectId: at.projectId, scope: "project" }),
      ).read;
      expect(yield* shared({ id: root.id })).toMatchObject({
        evidenceContext: { provenance: [expect.objectContaining({ id: hidden.id })], changes: [] },
      });
      expect(yield* scoped({ id: root.id })).toMatchObject({
        evidenceContext: { provenance: [], changes: [], provenanceScopeLimited: true },
      });
      expect(yield* scoped({ id: hidden.id })).toEqual({
        error: "not_found",
        id: hidden.id,
      });
      yield* projects.setCrossRecallExcluded(other.id, true);
      expect(yield* shared({ id: root.id })).toMatchObject({
        evidenceContext: { provenance: [], changes: [], provenanceScopeLimited: true },
      });
      expect(yield* shared({ id: hidden.id })).toEqual({
        error: "not_found",
        id: hidden.id,
      });
    }),
  );

  it.effect("reports an unavailable trace and fails closed on storage errors", () =>
    Effect.gen(function* () {
      const at = yield* freshSession;
      const env = yield* environment;
      const node = yield* env.nodes.append({ ...at, kind: "user", text: "evidence" });
      const untraced = reads(
        { ...env, graph: { ...env.graph, trace: () => Effect.succeed(null) } },
        at.projectId,
      ).read;
      expect(yield* untraced({ id: node.id })).toMatchObject({
        evidenceContext: { assessment: { kind: "untraced" } },
      });
      const broken = reads(
        {
          ...env,
          graph: {
            ...env.graph,
            trace: () =>
              Effect.fail(
                GraphReadFailed.make({
                  cause: new DOMException("private storage detail", "InvalidStateError"),
                }),
              ),
          },
        },
        at.projectId,
      ).read;
      // The model reads the failure's tag, never the storage detail.
      const failure = yield* Effect.flip(broken({ id: node.id }));
      expect(failure).toMatchObject({ tag: "EvidenceReadFailed" });
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
        const a = yield* append(envA, first, "first owner evidence");
        const b = yield* append(envB, second, "second owner evidence");
        const toolsA = reads(envA, first.project.id);
        const toolsB = reads(envB, second.project.id);
        expect(yield* toolsA.read({ id: a.id })).toMatchObject({ text: a.text });
        expect(yield* toolsB.read({ id: b.id })).toMatchObject({ text: b.text });
        expect(yield* toolsB.read({ id: a.id })).toEqual({
          error: "not_found",
          id: a.id,
        });
        expect(yield* toolsA.read({ id: b.id })).toEqual({
          error: "not_found",
          id: b.id,
        });
        const wrapper = yield* second.use(MemoryTools);
        const bound = yield* wrapper.toolsFor({
          projectId: second.project.id,
          sessionId: second.session.id,
          runId: `${second.session.id}:run`,
          userNodeId: "user",
        });
        expect(yield* callers(bound.tools).read({ id: b.id })).toMatchObject({ text: b.text });
      }),
  );
});

testAgent()("memory tools per run", (it) => {
  /** Ends the run with `answer` as its last message, as the loop does, so `hook` records the use. */
  const finish = Effect.fnUntraced(function* (
    hook: Effect.Effect<RunHook>,
    runId: string,
    answer: { readonly role: "assistant"; readonly id: string; readonly content: string },
  ) {
    const { stepEnded, ended } = yield* hook;
    const scope = { threadId: `${runId}:thread`, runId, emit: () => Effect.void };
    yield* stepEnded!(scope, StepEnded.Model({ message: answer, answered: [] }));
    yield* ended!(scope, RunEnd.Completed(), [answer]);
  });

  it.effect(
    "fresh run getters and conversation bindings are not reused; native promotion gates remain",
    () =>
      Effect.gen(function* () {
        const at = yield* freshSession;
        const env = yield* environment;
        const user = yield* env.nodes.append({ ...at, kind: "user", text: "save" });
        let currentUser = "missing";
        let readsA = 0;
        let readsB = 0;
        const a = yield* memoryRunTools({
          env,
          binding: {
            ...at,
            runId: `${at.sessionId}:run-a`,
            userNodeId: () => {
              readsA++;
              return user.id;
            },
          },
        });
        const b = yield* memoryRunTools({
          env,
          binding: {
            ...at,
            runId: `${at.sessionId}:run-b`,
            userNodeId: () => {
              readsB++;
              return currentUser;
            },
          },
        });
        const promoteA = callers(a.tools).promote;
        const promoteB = callers(b.tools).promote;
        const notAdopted = {
          tag: "MemoryPromotionRejected",
          detail: "Memory promotion source is not an adopted final-answer claim",
        };
        expect(yield* Effect.flip(promoteA(unadoptedClaim))).toMatchObject(notAdopted);
        expect(yield* Effect.flip(promoteB(unadoptedClaim))).toMatchObject({
          tag: "MemoryPromotionRejected",
          detail: "Memory promotion requires the current user turn as authorization",
        });
        currentUser = user.id;
        expect(yield* Effect.flip(promoteB(unadoptedClaim))).toMatchObject(notAdopted);
        expect(readsA).toBe(1);
        expect(readsB).toBe(2);
        expect(a.hook).not.toBe(b.hook);
        expect(
          yield* Effect.flip(callers(b.tools).use({ memoryNodeIds: [user.id] })),
        ).toMatchObject({ tag: "PromotedMemoryUseRejected" });
      }),
  );

  it.effect("the run binding keeps the deferred admission user-node getter", () =>
    Effect.gen(function* () {
      const at = yield* freshSession;
      const env = yield* environment;
      let reads = 0;
      const user = yield* env.nodes.append({ ...at, kind: "user", text: "explicit save" });
      const prepared = yield* (yield* MemoryTools).toolsFor({
        ...at,
        runId: `${at.sessionId}:deferred-run`,
        get userNodeId() {
          reads++;
          return user.id;
        },
      });
      expect(reads).toBe(0);
      expect(yield* Effect.flip(callers(prepared.tools).promote(unadoptedClaim))).toMatchObject({
        tag: "MemoryPromotionRejected",
        detail: "Memory promotion source is not an adopted final-answer claim",
      });
      expect(reads).toBe(1);
    }),
  );

  it.effect("runs a run's tool calls on its fiber, so their spans join the run's trace", () =>
    Effect.gen(function* () {
      const at = yield* freshSession;
      const recorded: Tracer.Span[] = [];
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options);
          recorded.push(span);
          return span;
        },
      });
      const { tools } = yield* (yield* MemoryTools).toolsFor({
        ...at,
        runId: `${at.sessionId}:traced-run`,
        userNodeId: "user",
      });
      const { run, toolSpans } = yield* Effect.gen(function* () {
        const run = yield* Effect.currentSpan;
        const before = recorded.length;
        yield* callers(tools).find({ query: "anything" });
        return { run, toolSpans: recorded.slice(before) };
      }).pipe(Effect.withSpan("chat.run"), Effect.withTracer(tracer));
      expect(toolSpans.length).toBeGreaterThan(0);
      expect(toolSpans.every((span) => span.traceId === run.traceId)).toBe(true);
    }),
  );

  it.effect("populated promoted-memory retrieval and use state never leak into a fresh run", () =>
    Effect.gen(function* () {
      const at = yield* freshSession;
      const { sessionId } = at;
      const env = yield* environment;
      const trace = yield* WorkTraceStore;
      const agentId = `${sessionId}:factory-agent`;
      const parentRunId = `${sessionId}:parent`;
      yield* sqlRun(
        `INSERT INTO subagents
          (id, session_id, name, instructions, status, parent_run_id, last_task, created_at, updated_at)
          VALUES (?, ?, 'factory', 'research', 'interrupted', ?, 'task', 1, 1)`,
        agentId,
        sessionId,
        parentRunId,
      );
      const user = yield* env.nodes.append({
        ...at,
        kind: "user",
        text: "Save this fixture decision: isolated-memory-state.",
      });
      const handle = yield* trace.startAttempt({
        sessionId,
        parentRunId,
        parentToolCallId: `${sessionId}:factory-call`,
        agentId,
        title: "Factory research",
        request: "Research factory state",
        kind: "start",
        threadId: `${sessionId}:factory-thread`,
      });
      const claimId = yield* trace.finalizeAnswerClaim({
        ...at,
        parentRunId,
        parentMessageId: "research-answer",
        usedReports: [{ taskId: handle.taskId, attemptId: handle.id }],
        reflectedNotificationIds: [],
      });
      const runA = `${sessionId}:memory-run-a`;
      const runB = `${sessionId}:memory-run-b`;
      const makeRun = (runId: string) =>
        memoryRunTools({ env, binding: { ...at, runId, userNodeId: () => user.id } });
      const first = yield* makeRun(runA);
      const second = yield* makeRun(runB);
      const firstCalls = callers(first.tools);
      const secondCalls = callers(second.tools);
      const promoted = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ memoryNodeId: Schema.NonEmptyString }),
      )(
        yield* firstCalls.promote({
          claimId,
          taskId: handle.taskId,
          attemptId: handle.id,
          proposedText: "isolated-memory-state is a fixture decision",
          resolvedText: "isolated-memory-state is a fixture decision",
          disposition: "save",
        }),
      );
      const memoryNodeIds = [promoted.memoryNodeId];
      yield* (yield* Indexer).indexAll();
      const found = yield* firstCalls.find({ query: "isolated-memory-state" });
      expect(found).toMatchObject({
        matches: expect.arrayContaining([expect.objectContaining({ id: promoted.memoryNodeId })]),
      });
      expect(yield* firstCalls.use({ memoryNodeIds })).toMatchObject({ usedMemoryCount: 1 });
      expect(yield* Effect.flip(secondCalls.use({ memoryNodeIds }))).toMatchObject({
        tag: "PromotedMemoryUseRejected",
      });
      const answer = (id: string) => ({
        role: "assistant" as const,
        id,
        content: "fixture answer",
      });
      yield* finish(second.hook, runB, answer("answer-b"));
      expect((yield* env.knowledge.usageForTask(handle.taskId)).map((usage) => usage.kind)).toEqual(
        ["retrieved"],
      );
      yield* finish(first.hook, runA, answer("answer-a"));
      const usage = () =>
        Effect.map(env.knowledge.usageForTask(handle.taskId), (entries) =>
          entries.map((entry) => ({ kind: entry.kind, parentRunId: entry.parentRunId })),
        );
      expect(yield* usage()).toEqual([
        { kind: "retrieved", parentRunId: runA },
        { kind: "used", parentRunId: runA },
      ]);
      yield* secondCalls.find({ query: "isolated-memory-state" });
      yield* secondCalls.use({ memoryNodeIds });
      yield* finish(second.hook, runB, answer("answer-b"));
      expect(yield* usage()).toEqual([
        { kind: "retrieved", parentRunId: runA },
        { kind: "used", parentRunId: runA },
        { kind: "retrieved", parentRunId: runB },
        { kind: "used", parentRunId: runB },
      ]);
    }),
  );
});
