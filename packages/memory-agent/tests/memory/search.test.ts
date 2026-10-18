import { layer } from "@effect/vitest";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { chat } from "@tanstack/ai";
import { homedir } from "node:os";
import {
  Cause,
  Effect,
  FileSystem,
  Layer,
  MutableHashMap,
  Option,
  Path,
  Random,
  Schema,
  Stream,
} from "effect";
import { describe, expect } from "vite-plus/test";
import { StorageRoot } from "../../src/config/storage-root.ts";
import { Embedder, EmbeddingError } from "../../src/memory/embedding/embedder.ts";
import { Indexer } from "../../src/memory/embedding/indexer.ts";
import { kiwiModel, MorphAnalyzer } from "../../src/memory/morph/analyzer.ts";
import { Nodes } from "../../src/memory/nodes.ts";
import { Recorder } from "../../src/memory/record.ts";
import { type FindInput, MemorySearch } from "../../src/memory/search.ts";
import { Projects } from "../../src/projects/projects.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import { fakeVector } from "../../src/testing/fake-embedder.ts";
import { fakeTerms } from "../../src/testing/fake-morph.ts";
import { ScriptedTextAdapter } from "../../src/testing/scripted-adapter.ts";
import { MemoryTools } from "../../src/tools/memory.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";
import { sqlGet } from "../support/sql.ts";

/**
 * A new project with one session. Search ranks within a project, so each test gets its own and
 * never sees what another test in the block stored.
 */
const freshProject = Effect.gen(function* () {
  const { base } = yield* TestEnv;
  const root = (yield* Path.Path).join(
    base,
    `project-${(yield* Random.next).toString(36).slice(2)}`,
  );
  yield* (yield* FileSystem.FileSystem).makeDirectory(root);
  const project = yield* (yield* Projects).add(root);
  const session = yield* (yield* Sessions).create(project.id);
  return { project, session };
});

/** A fresh project whose only node is a user statement. */
const otherProject = Effect.fnUntraced(function* (text: string) {
  const { project, session } = yield* freshProject;
  const node = yield* (yield* Nodes).append({
    projectId: project.id,
    sessionId: session.id,
    kind: "user",
    text,
  });
  return { project, node };
});

/** An earlier session in a fresh project: a decision, then the assistant reads a file about it. */
const earlierSession = Effect.gen(function* () {
  const { project, session } = yield* freshProject;
  const nodes = yield* Nodes;
  const at = { projectId: project.id, sessionId: session.id };
  const runId = `${session.id}:old-run`;
  const decision = yield* nodes.append({
    ...at,
    kind: "user",
    text: "저장소는 SQLite로 결정했다. Postgres는 과하다.",
  });
  const answer = yield* nodes.append({
    ...at,
    runId,
    kind: "assistant",
    text: "스키마를 확인할게요.",
    links: [{ kind: "reply", nodeId: decision.id }],
  });
  const call = yield* nodes.append({
    ...at,
    runId,
    kind: "tool_call",
    text: 'read_file {"path":"schema.sql"}',
    links: [{ kind: "calls", nodeId: answer.id }],
    refs: ["schema.sql"],
  });
  const result = yield* nodes.append({
    ...at,
    runId,
    kind: "tool_result",
    text: "CREATE TABLE nodes (seq INTEGER PRIMARY KEY)",
    links: [{ kind: "returns", nodeId: call.id }],
  });
  return { project, session, decision, answer, call, result };
});

const indexAll = Effect.flatMap(Indexer, (indexer) => indexer.indexAll());

const find = Effect.fnUntraced(function* (input: FindInput) {
  return yield* (yield* MemorySearch).find(input);
});

testAgent()("MemorySearch.find", (it) => {
  it.effect(
    "seeds from vector and text matches, then reaches linked evidence through the graph",
    () =>
      Effect.gen(function* () {
        const earlier = yield* earlierSession;
        yield* indexAll;
        const result = yield* find({
          query: "SQLite로 결정했던 이유",
          projectId: earlier.project.id,
        });
        const byId = MutableHashMap.fromIterable(result.matches.map((match) => [match.id, match]));
        const match = (id: string) => Option.getOrUndefined(MutableHashMap.get(byId, id));
        expect(result.degraded).toEqual([]);
        expect(result.unindexed).toBe(0);
        expect(match(earlier.decision.id)?.foundBy).toMatch(/vector|text/);
        expect(match(earlier.result.id)).toMatchObject({
          foundBy: "graph",
          fromOtherProject: false,
        });
        expect(match(earlier.result.id)?.path.map((hop) => hop.kind)).toEqual([
          "reply",
          "calls",
          "returns",
        ]);
      }),
  );

  it.effect("includes other projects unless they opted out of cross-project recall", () =>
    Effect.gen(function* () {
      const { project } = yield* freshProject;
      const shared = yield* otherProject("다른 프로젝트도 SQLite를 쓰기로 했다");
      const excluded = yield* otherProject("비공개 프로젝트의 SQLite 설정");
      yield* (yield* Projects).setCrossRecallExcluded(excluded.project.id, true);
      yield* indexAll;
      const across = yield* find({ query: "SQLite", projectId: project.id, crossProject: true });
      expect(across.matches.find((match) => match.id === shared.node.id)).toMatchObject({
        fromOtherProject: true,
        projectId: shared.project.id,
      });
      expect(across.matches.map((match) => match.id)).not.toContain(excluded.node.id);
      expect(
        (yield* find({ query: "SQLite", projectId: project.id, crossProject: false })).matches,
      ).toEqual([]);
    }),
  );

  it.effect("leaves out a read that a later read of the changed file superseded", () =>
    Effect.gen(function* () {
      const { project, session } = yield* freshProject;
      const nodes = yield* Nodes;
      const at = { projectId: project.id, sessionId: session.id };
      const read = Effect.fnUntraced(function* (content: string, sha256: string) {
        const call = yield* nodes.append({
          ...at,
          kind: "tool_call",
          text: 'read_file {"path":"config.toml"}',
          detail: { toolName: "read_file" },
          refs: ["config.toml"],
        });
        return yield* nodes.append({
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
      });
      const found = Effect.map(
        find({ query: "retries", projectId: project.id, crossProject: false }),
        (result) => result.matches.map((match) => match.id),
      );
      const first = yield* read("retries = 2", "a".repeat(64));
      const unchanged = yield* read("retries = 2", "a".repeat(64));
      expect(yield* found).toEqual(expect.arrayContaining([first.id, unchanged.id]));
      const changed = yield* read("retries = 5", "b".repeat(64));
      const after = yield* found;
      expect(after).toContain(changed.id);
      expect(after).not.toContain(first.id);
      expect(after).not.toContain(unchanged.id);
      expect((yield* nodes.get(first.id))?.text).toContain("retries = 2");
    }),
  );

  it.effect("stores each node's morpheme terms once and lets particles and endings differ", () =>
    Effect.gen(function* () {
      const { project, session } = yield* freshProject;
      const nodes = yield* Nodes;
      const indexer = yield* Indexer;
      yield* indexAll;
      yield* indexer.analyzeAll();
      const append = (text: string) =>
        nodes.append({ projectId: project.id, sessionId: session.id, kind: "user", text });
      const target = yield* append("결제모듈은 토스페이먼츠로 연동하기로 했다");
      yield* append("회의실 예약은 금요일까지");
      yield* append("디자인 시안은 다음 주에 공유");
      yield* indexAll;
      expect(yield* indexer.analyzeAll()).toBe(3);
      expect(yield* indexer.analyzeAll()).toBe(0);
      const stored = yield* Schema.decodeUnknownEffect(Schema.Struct({ terms: Schema.String }))(
        yield* sqlGet("SELECT terms FROM nodes_morph WHERE rowid = ?", target.seq),
      );
      expect(stored.terms).toBe(fakeTerms("결제모듈은 토스페이먼츠로 연동하기로 했다").join(" "));
      // "결제모듈을" never occurs as text, so only the morpheme terms tie the question to it.
      const result = yield* find({
        query: "결제모듈을 어디로 정했지",
        projectId: project.id,
        crossProject: false,
      });
      expect(result.degraded).toEqual([]);
      expect(result.matches[0]?.id).toBe(target.id);
    }),
  );

  it.effect("memory tools let the model find, read and trace earlier evidence in a chat run", () =>
    Effect.gen(function* () {
      const earlier = yield* earlierSession;
      const { project } = earlier;
      const hidden = yield* otherProject("비공개 메모");
      yield* (yield* Projects).setCrossRecallExcluded(hidden.project.id, true);
      yield* indexAll;
      const newSession = yield* (yield* Sessions).create(project.id);
      const nodes = yield* Nodes;
      const question = yield* nodes.append({
        projectId: project.id,
        sessionId: newSession.id,
        kind: "user",
        text: "우리 DB 뭐로 하기로 했었지?",
      });
      const call = (id: string, name: string, args: Readonly<Record<string, string>>) => ({
        id,
        name,
        arguments: JSON.stringify(args),
      });
      const runId = `${newSession.id}:run`;
      yield* Stream.runDrain(
        Stream.fromAsyncIterable(
          chat({
            adapter: new ScriptedTextAdapter([
              { toolCalls: [call("c1", "find_memory", { query: "SQLite 결정" })] },
              {
                toolCalls: [
                  call("c2", "read_evidence", { id: earlier.decision.id }),
                  call("c3", "trace_evidence", { id: earlier.result.id }),
                  call("c4", "read_evidence", { id: hidden.node.id }),
                ],
              },
              { text: "이전 세션에서 SQLite로 결정했습니다." },
            ]),
            messages: [{ role: "user", content: question.text }],
            tools: (yield* MemoryTools).forProject(project.id),
            runId,
            middleware: [
              (yield* Recorder).forRun({
                projectId: project.id,
                sessionId: newSession.id,
                runId,
                userNodeId: question.id,
              }),
            ],
          }),
          (cause) => new Cause.UnknownError(cause),
        ),
      );
      const results = MutableHashMap.fromIterable(
        (yield* nodes.session(newSession.id))
          .filter((node) => node.kind === "tool_result")
          .map((node) => [node.detail.toolCallId, node.text]),
      );
      const output = <S extends Schema.Top>(id: string, schema: S) =>
        Schema.decodeEffect(Schema.fromJsonString(schema))(
          Option.getOrUndefined(MutableHashMap.get(results, id)) ?? "{}",
        );
      const found = yield* output(
        "c1",
        Schema.Struct({ matches: Schema.Array(Schema.Struct({ id: Schema.String })) }),
      );
      const read = yield* output(
        "c2",
        Schema.Struct({
          text: Schema.String,
          nextOffset: Schema.Union([Schema.Null, Schema.Finite]),
          sessionId: Schema.String,
        }),
      );
      const traced = yield* output(
        "c3",
        Schema.Struct({ chain: Schema.Array(Schema.Struct({ id: Schema.String })) }),
      );
      const refused = yield* output(
        "c4",
        Schema.Struct({ error: Schema.String, id: Schema.String }),
      );
      expect(found.matches.map((match) => match.id)).toContain(earlier.decision.id);
      expect(read).toMatchObject({
        text: earlier.decision.text,
        nextOffset: null,
        sessionId: earlier.session.id,
      });
      expect(traced.chain.map((node) => node.id)).toEqual([
        earlier.result.id,
        earlier.call.id,
        earlier.answer.id,
        earlier.decision.id,
      ]);
      expect(refused).toEqual({ error: "not_found", id: hidden.node.id });
    }),
  );
});

testAgent({ morphAnalyzer: MorphAnalyzer.disabled })(
  "MemorySearch.find without morphemes",
  (it) => {
    it.effect("ranks vectors inside the allowed project before applying the result limit", () =>
      Effect.gen(function* () {
        const { project, session } = yield* freshProject;
        const excluded = yield* otherProject("shared vector text");
        const nodes = yield* Nodes;
        const distractors = yield* Effect.forEach(Array.from({ length: 50 }), () =>
          nodes.append({
            projectId: excluded.project.id,
            sessionId: excluded.node.sessionId,
            kind: "user",
            text: "shared vector text",
          }),
        );
        const target = yield* nodes.append({
          projectId: project.id,
          sessionId: session.id,
          kind: "user",
          text: "shared vector text",
        });
        yield* indexAll;
        const result = yield* find({
          query: "unrelated query",
          projectId: project.id,
          crossProject: false,
          limit: 1,
        });
        expect(result.degraded).toEqual([]);
        expect(result.matches[0]).toMatchObject({ id: target.id, foundBy: "vector" });
        expect(result.matches.map((match) => match.id)).not.toContain(distractors[0]?.id);
      }),
    );

    it.effect(
      "a query naming something exactly finds the tool output ahead of the nearest statement",
      () =>
        Effect.gen(function* () {
          const { project, session } = yield* freshProject;
          const nodes = yield* Nodes;
          const at = { projectId: project.id, sessionId: session.id };
          yield* nodes.append({ ...at, kind: "user", text: "개발 서버를 띄워 줘" });
          const output = yield* nodes.append({
            ...at,
            kind: "tool_result",
            text: "Error: listen EADDRINUSE: address already in use 127.0.0.1:5174",
          });
          yield* nodes.append({ ...at, kind: "assistant", text: "다른 포트로 옮길게요." });
          yield* indexAll;
          // Only the statements have vectors, so the vector ranking is all statements.
          const result = yield* find({ query: "EADDRINUSE 5174", projectId: project.id });
          expect(result.matches[0]).toMatchObject({ id: output.id, foundBy: "text" });
        }),
    );
  },
);

const nativeTestEmbedderLayer = Layer.succeed(Embedder, {
  identity: "fake-trigram-384",
  dimensions: 384,
  embed: (texts: readonly string[]) =>
    Effect.succeed(
      texts.map((text) => {
        const vector = new Float32Array(384);
        vector.set(fakeVector(text));
        return vector;
      }),
    ),
  runtime: () => ({ kind: "other" as const }),
});

testAgent({ embedder: nativeTestEmbedderLayer })(
  "MemorySearch.find on the native seed path",
  (it) => {
    it.effect("keeps project and graph result semantics", () =>
      Effect.gen(function* () {
        const earlier = yield* earlierSession;
        const excluded = yield* otherProject("SQLite로 결정한 다른 프로젝트 기록");
        yield* indexAll;
        const result = yield* find({
          query: "SQLite로 결정했던 이유",
          projectId: earlier.project.id,
          crossProject: false,
        });
        expect(result.degraded).toEqual([]);
        expect(result.unindexed).toBe(0);
        expect(result.matches.map((match) => match.id)).not.toContain(excluded.node.id);
        expect(result.matches.find((match) => match.id === earlier.decision.id)?.foundBy).toMatch(
          /vector|text/,
        );
        expect(result.matches.find((match) => match.id === earlier.result.id)).toMatchObject({
          foundBy: "graph",
          fromOtherProject: false,
        });
      }),
    );
  },
);

const brokenEmbedder = Layer.succeed(Embedder, {
  identity: "broken",
  dimensions: 64,
  embed: () => Effect.fail(new EmbeddingError({ cause: new Error("model not downloaded") })),
  runtime: () => ({ kind: "other" }),
});

testAgent({ embedder: brokenEmbedder })("MemorySearch.find with a failing embedder", (it) => {
  it.effect("falls back to text search, and says so", () =>
    Effect.gen(function* () {
      const earlier = yield* earlierSession;
      const result = yield* find({ query: "Postgres", projectId: earlier.project.id });
      expect(result.degraded).toEqual(["vector"]);
      // The two statements; tool calls and results are never embedded.
      expect(result.unindexed).toBe(2);
      expect(result.matches[0]).toMatchObject({ id: earlier.decision.id, foundBy: "text" });
    }),
  );
});

let warmed = 0;
const loadingAnalyzer = Layer.succeed(MorphAnalyzer, {
  identity: "loading",
  ready: () => false,
  warm: () => void warmed++,
  terms: () => Effect.die("not loaded"),
});

testAgent({ morphAnalyzer: loadingAnalyzer })("MemorySearch.find while Kiwi loads", (it) => {
  it.effect("does not wait for the analyzer; it says so and warms it", () =>
    Effect.gen(function* () {
      const { project } = yield* TestEnv;
      const result = yield* find({ query: "아무거나", projectId: project.id });
      expect(result.degraded).toEqual(["morph"]);
      expect(warmed).toBe(1);
    }),
  );
});

// The downloaded model is the user's; this test runs only where it is already cached.
const { kiwiStorage, kiwiCached } = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const services = yield* Layer.build(Layer.merge(NodeFileSystem.layer, NodePath.layer));
      return yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const kiwiStorage = path.join(homedir(), ".context-generactive-agent");
        const kiwiCached = yield* fs
          .exists(
            path.join(
              kiwiStorage,
              "models",
              `kiwi-${kiwiModel.version}`,
              kiwiModel.directory,
              "cong.mdl",
            ),
          )
          .pipe(Effect.orElseSucceed(() => false));
        return { kiwiStorage, kiwiCached };
      }).pipe(Effect.provideContext(services));
    }),
  ),
);

describe.skipIf(!kiwiCached)("Kiwi (model already downloaded)", () => {
  layer(MorphAnalyzer.kiwi.pipe(Layer.provide(StorageRoot.layer(kiwiStorage))), {
    excludeTestServices: true,
    timeout: "60 seconds",
  })("kiwi", (it) => {
    it.effect(
      "keeps nouns and stems and drops particles and endings",
      () =>
        Effect.gen(function* () {
          const terms = yield* (yield* MorphAnalyzer).terms([
            "로그 포맷은 JSON Lines로 하기로 했다.",
            "로그 형식을 뭐로 정했었지?",
            "메인 데이터베이스는 PostgreSQL, 대시보드는 Grafana.",
          ]);
          expect(terms[0]).toEqual(expect.arrayContaining(["로그", "포맷", "json", "lines"]));
          expect(terms[1]).toEqual(expect.arrayContaining(["로그", "형식", "정하"]));
          // Split compounds also count whole; Latin words come from the text, not Kiwi's pieces.
          expect(terms[2]).toEqual(
            expect.arrayContaining(["데이터베이스", "postgresql", "grafana"]),
          );
          expect(terms.flat()).not.toContain("은");
          expect(terms.flat()).not.toContain("하");
        }),
      60_000,
    );
  });
});
