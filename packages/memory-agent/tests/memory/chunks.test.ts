import { Effect, FileSystem, Layer, Path } from "effect";
import { expect } from "vite-plus/test";
import { chunkText } from "../../src/memory/embedding/chunks.ts";
import { Embedder, EmbeddingError, normalize } from "../../src/memory/embedding/embedder.ts";
import { Indexer, IndexingError } from "../../src/memory/embedding/indexer.ts";
import { VectorIndex } from "../../src/memory/embedding/vector-index.ts";
import { MorphAnalyzer } from "../../src/memory/morph/analyzer.ts";
import { Nodes } from "../../src/memory/nodes.ts";
import { MemorySearch } from "../../src/memory/search.ts";
import { readStructuredEvidence } from "../../src/memory/evidence.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";
import { Projects } from "../../src/projects/projects.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import { sqlGet, sqlRun } from "../support/sql.ts";

// Deliberately semantic fixture: the question and answer share no lexical search terms.
const vector = (text: string) => {
  const row = new Float32Array(384);
  if (text.includes("목요일") || text === "release decision") row[0] = 1;
  else if (text.includes("금요일")) {
    row[0] = 0.8;
    row[1] = 0.6;
  } else row[1] = 1;
  return normalize(row);
};
const chunked = Layer.succeed(Embedder, {
  identity: "chunk-contract-v1",
  dimensions: 384,
  runtime: () => ({ kind: "other" }),
  chunks: (texts) =>
    Effect.forEach(
      texts,
      (text) =>
        chunkText(text, (part, special) =>
          Effect.succeed(Array.from(part).length + (special ? 2 : 0)),
        ),
      { concurrency: 1 },
    ).pipe(Effect.mapError((cause) => EmbeddingError.make({ cause }))),
  embed: (texts) => Effect.succeed(texts.map(vector)),
});

testAgent({ embedder: chunked, morphAnalyzer: MorphAnalyzer.disabled })("chunk recovery", (it) => {
  it.effect(
    "removes saved but uncommitted chunks on reopen without rebuilding committed nodes",
    () =>
      Effect.gen(function* () {
        const env = yield* TestEnv;
        const nodes = yield* Nodes;
        yield* nodes.append({
          projectId: env.project.id,
          sessionId: env.session.id,
          kind: "user",
          text: "목요일",
        });
        yield* (yield* Indexer).indexAll();
        const pending = yield* nodes.append({
          projectId: env.project.id,
          sessionId: env.session.id,
          kind: "user",
          text: "금요일",
        });
        const index = yield* VectorIndex;
        const failed = yield* Effect.flip(
          index.publish(
            Effect.gen(function* () {
              const id = Number(
                (yield* sqlRun(
                  "INSERT INTO node_vector_chunks(node_seq,embedder,ordinal,start_offset,end_offset) VALUES (?, 'chunk-contract-v1', 0, 0, 3)",
                  pending.seq,
                )).lastInsertRowid,
              );
              return {
                seqs: [id],
                vectors: [vector("금요일")],
                commit: Effect.fail(IndexingError.make({ reason: "mapping-commit-failed" })),
              };
            }),
          ),
        );
        expect(failed).toBeInstanceOf(IndexingError);
        expect(index.size()).toBe(2);
        yield* env.reopen;
        yield* env.use(
          Effect.gen(function* () {
            expect((yield* VectorIndex).size()).toBe(1);
            expect(yield* (yield* Indexer).pending).toBe(1);
            expect(yield* (yield* Indexer).indexAll()).toBe(1);
            expect((yield* VectorIndex).size()).toBe(2);
          }),
        );
      }),
  );
});

testAgent({ embedder: chunked, morphAnalyzer: MorphAnalyzer.disabled })("chunked memory", (it) => {
  it.effect(
    "retrieves a late original span, preserves it on reopen, and removes every chunk on invalidation",
    () =>
      Effect.gen(function* () {
        const env = yield* TestEnv;
        const nodes = yield* Nodes;
        const body =
          "앞부분에는 관련 없는 작업 기록만 있습니다. ".repeat(300) +
          "최종 배포 결정은 목요일입니다.";
        const node = yield* nodes.append({
          projectId: env.project.id,
          sessionId: env.session.id,
          kind: "user",
          text: body,
        });
        yield* nodes.append({
          projectId: env.project.id,
          sessionId: env.session.id,
          kind: "tool_result",
          text: body,
        });
        const indexer = yield* Indexer;
        expect(yield* indexer.indexAll()).toBe(1);
        expect((yield* VectorIndex).size()).toBeGreaterThan(1);
        const find = Effect.gen(function* () {
          const search = yield* MemorySearch;
          const result = yield* search.find({
            projectId: env.project.id,
            query: "release decision",
            crossProject: false,
            limit: 1,
          });
          const match = result.matches[0]!;
          expect(match.id).toBe(node.id);
          expect(match.matchedSpan!.start).toBeGreaterThan(2048);
          expect(body.slice(match.matchedSpan!.start, match.matchedSpan!.end)).toContain("목요일");
          const evidence = yield* readStructuredEvidence(
            match.id,
            match.matchedSpan!.start,
            env.project.id,
            false,
          );
          expect(evidence?.text).toContain("목요일");
          return match.matchedSpan;
        });
        const span = yield* find;
        yield* env.reopen;
        expect(yield* env.use(find)).toEqual(span);
        yield* env.use(
          Effect.gen(function* () {
            expect(yield* (yield* Indexer).indexAll()).toBe(0);
            yield* sqlRun("DELETE FROM node_vectors WHERE node_seq=?", node.seq);
            expect(
              (yield* sqlGet("SELECT count(*) AS n FROM memory_chunk_vector_removals"))!.n,
            ).toBeGreaterThan(1);
            const index = yield* VectorIndex;
            yield* index.flushRemovals;
            expect(index.size()).toBe(0);
            expect((yield* sqlGet("SELECT count(*) AS n FROM node_vector_chunks"))!.n).toBe(0);
            expect(
              (yield* (yield* MemorySearch).find({
                projectId: env.project.id,
                query: "release decision",
              })).matches,
            ).toEqual([]);
            yield* (yield* Indexer).indexAll();
            // A mapping removed independently must retain its native removal ID, too.
            yield* sqlRun("DELETE FROM node_vector_chunks WHERE node_seq=?", node.seq);
            yield* sqlRun("DELETE FROM node_vectors WHERE node_seq=?", node.seq);
            expect(
              (yield* sqlGet("SELECT count(*) AS n FROM memory_chunk_vector_removals"))!.n,
            ).toBeGreaterThan(1);
            yield* index.flushRemovals;
            expect(index.size()).toBe(0);
          }),
        );
      }),
  );
});

testAgent({ embedder: chunked, morphAnalyzer: MorphAnalyzer.disabled })(
  "chunk parent ranking",
  (it) => {
    it.effect(
      "fills the parent candidate budget even when many highest-scoring chunks belong to one node",
      () =>
        Effect.gen(function* () {
          const { project, session, base } = yield* TestEnv;
          const nodes = yield* Nodes;
          const long = yield* nodes.append({
            projectId: project.id,
            sessionId: session.id,
            kind: "user",
            text: "목요일 ".repeat(6000),
          });
          const second = yield* nodes.append({
            projectId: project.id,
            sessionId: session.id,
            kind: "user",
            text: "금요일 대안",
          });
          const hiddenRoot = (yield* Path.Path).join(base, "hidden-project");
          yield* (yield* FileSystem.FileSystem).makeDirectory(hiddenRoot);
          const hiddenProject = yield* (yield* Projects).add(hiddenRoot);
          const hiddenSession = yield* (yield* Sessions).create(hiddenProject.id);
          yield* nodes.append({
            projectId: hiddenProject.id,
            sessionId: hiddenSession.id,
            kind: "user",
            text: "목요일 ".repeat(3000),
          });
          yield* (yield* Indexer).indexAll();
          const filtered = yield* (yield* VectorIndex).search(vector("release decision"), 2, [
            long.seq,
            second.seq,
          ]);
          expect(filtered.map((hit) => hit.seq)).toEqual([long.seq, second.seq]);
          const result = yield* (yield* MemorySearch).find({
            projectId: project.id,
            query: "release decision",
            crossProject: false,
            limit: 2,
          });
          expect(result.matches.map((match) => match.id)).toEqual([long.id, second.id]);
        }),
    );
  },
);
