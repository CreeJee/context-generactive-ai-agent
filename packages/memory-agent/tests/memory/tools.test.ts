import { Effect, FileSystem, Schema, Tracer } from "effect";
import { expect } from "vite-plus/test";
import { Indexer } from "../../src/memory/embedding/indexer.ts";
import { Graph, GraphReadFailed } from "../../src/memory/graph.ts";
import { Interpretations } from "../../src/memory/interpretations.ts";
import { Nodes } from "../../src/memory/nodes.ts";
import { MemorySearch } from "../../src/memory/search.ts";
import { Projects } from "../../src/projects/projects.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import {
  MemoryTools,
  memoryReadRunTools,
  type MemoryToolEnvironment,
} from "../../src/tools/memory.ts";
import type { RunTool } from "../../src/tools/run-tool.ts";
import type { JsonValue } from "../../src/json.ts";
import { callTool } from "../support/run-tools.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";

const environment = Effect.gen(function* () {
  return {
    search: yield* MemorySearch,
    nodes: yield* Nodes,
    graph: yield* Graph,
    interpretations: yield* Interpretations,
  };
});

/** The memory tools, by name, called as the model would. */
const callers = (tools: ReadonlyArray<RunTool>) => {
  const named = (name: string) => (params: JsonValue) => callTool(tools, name, params);
  return {
    find: named("find_memory"),
    read: named("read_evidence"),
    trace: named("trace_evidence"),
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
      yield* Effect.forEach(
        Array.from({ length: 9 }, (_, index) => `possible change ${index}`),
        Effect.fnUntraced(function* (text) {
          const pending = yield* env.nodes.append({ ...at, kind: "user", text });
          yield* env.interpretations.record({
            nodeId: pending.id,
            targetId: original.id,
            kind: "corrects",
            status: "unconfirmed",
            reason: "ambiguous target",
            model: "fixture",
          });
        }),
        { discard: true },
      );
      const { read } = reads(env, at.projectId);
      const result = yield* read({ id: original.id, offset: 4000 });
      expect(result).toHaveProperty("evidenceContext.changes.length", 8);
      expect(result).toHaveProperty("evidenceContext.changes.0.source.id", replacement.id);
      expect(result).toMatchObject({
        ...(yield* env.nodes.page(original, 4000)),
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
        yield* Effect.forEach(
          [older, assistant],
          (source) =>
            env.interpretations.record({
              nodeId: source.id,
              targetId: original.id,
              kind: "corrects",
              status: "applied",
              reason: "invalid authority",
              model: "fixture",
            }),
          { discard: true },
        );
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
      yield* Effect.forEach(
        [older, assistant, later],
        (source) =>
          env.interpretations.record({
            nodeId: source.id,
            targetId: original.id,
            kind: "corrects",
            status: "applied",
            reason: "fixture",
            model: "fixture",
          }),
        { discard: true },
      );
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

  it.effect("applies current project visibility to direct reads", () =>
    Effect.gen(function* () {
      const env = yield* environment;
      const { base, project } = yield* TestEnv;
      const projects = yield* Projects;
      const fs = yield* FileSystem.FileSystem;
      const other = yield* projects.add(yield* fs.makeTempDirectory({ directory: base }));
      const session = yield* (yield* Sessions).create(other.id);
      const hidden = yield* env.nodes.append({
        projectId: other.id,
        sessionId: session.id,
        kind: "user",
        text: "other project source",
      });
      const shared = reads(env, project.id).read;
      const scoped = callers(
        memoryReadRunTools({ env, projectId: project.id, scope: "project" }),
      ).read;
      expect(yield* shared({ id: hidden.id })).toMatchObject({
        id: hidden.id,
        text: "other project source",
      });
      expect(yield* scoped({ id: hidden.id })).toEqual({ error: "not_found", id: hidden.id });
      yield* projects.setCrossRecallExcluded(other.id, true);
      expect(yield* shared({ id: hidden.id })).toEqual({ error: "not_found", id: hidden.id });
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

testAgent()("memory tools per run", (it) => {
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
      const tools = (yield* MemoryTools).toolsFor(at);
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
});
