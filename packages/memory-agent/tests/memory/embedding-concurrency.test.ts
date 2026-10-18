import { Deferred, Effect, Fiber, Layer, Ref, Schema } from "effect";
import { expect, vi } from "vite-plus/test";
import * as nativeClient from "../../src/memory/native-search/client.ts";
import { Database } from "../../src/db/database.ts";
import { Embedder } from "../../src/memory/embedding/embedder.ts";
import { Indexer } from "../../src/memory/embedding/indexer.ts";
import { VectorIndex } from "../../src/memory/embedding/vector-index.ts";
import { Nodes } from "../../src/memory/nodes.ts";
import { MemorySearch } from "../../src/memory/search.ts";
import { MorphAnalyzer } from "../../src/memory/morph/analyzer.ts";
import { fakeVector } from "../../src/testing/fake-embedder.ts";
import { WorkTraceStore } from "../../src/work-trace/store.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";

// Pause the real native save boundary without replacing its execution or publication protocol.
const beforeSave = Ref.makeUnsafe<Effect.Effect<void>>(Effect.void);
const openOwner = nativeClient.makeNativeOwner;
vi.spyOn(nativeClient, "makeNativeOwner").mockImplementation((...args) =>
  openOwner(...args).pipe(
    Effect.map((owner) => ({
      ...owner,
      execute: (command) =>
        command.kind === "save"
          ? Ref.get(beforeSave).pipe(
              Effect.flatMap((hook) => hook),
              Effect.andThen(owner.execute(command)),
            )
          : owner.execute(command),
    })),
  ),
);
const embedder = Layer.succeed(Embedder, {
  identity: "concurrent-chunks",
  dimensions: 384,
  runtime: () => ({ kind: "other" }),
  chunks: (texts) => Effect.succeed(texts.map((text) => [{ start: 0, end: text.length }])),
  embed: (texts) => Effect.succeed(texts.map(fakeVector)),
});

testAgent({ embedder, morphAnalyzer: MorphAnalyzer.disabled })(
  "concurrent chunk publication",
  (it) => {
    it.effect("keeps removal intents created while another agent is saving a removal", () =>
      Effect.gen(function* () {
        const env = yield* TestEnv;
        const nodes = yield* Nodes;
        const first = yield* nodes.append({
          projectId: env.project.id,
          sessionId: env.session.id,
          kind: "user",
          text: "first removal",
        });
        const second = yield* nodes.append({
          projectId: env.project.id,
          sessionId: env.session.id,
          kind: "user",
          text: "second removal",
        });
        yield* (yield* Indexer).indexAll();
        const { sqlite } = yield* Database;
        const vectors = yield* VectorIndex;
        const saving = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        yield* Ref.set(
          beforeSave,
          Deferred.succeed(saving, undefined).pipe(Effect.andThen(Deferred.await(release))),
        );
        sqlite.prepare("DELETE FROM node_vectors WHERE node_seq=?").run(first.seq);
        const flush = yield* vectors.flushRemovals.pipe(Effect.forkChild);
        yield* Deferred.await(saving);
        sqlite.prepare("DELETE FROM node_vectors WHERE node_seq=?").run(second.seq);
        yield* Ref.set(beforeSave, Effect.void);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(flush);
        expect(
          sqlite.prepare("SELECT count(*) AS n FROM memory_chunk_vector_removals").get()!.n,
        ).toBe(1);
        yield* vectors.flushRemovals;
        expect(vectors.size()).toBe(0);
        expect(
          sqlite.prepare("SELECT count(*) AS n FROM memory_chunk_vector_removals").get()!.n,
        ).toBe(0);
      }),
    );
  },
);

testAgent({ embedder, morphAnalyzer: MorphAnalyzer.disabled })(
  "purge during chunk publication",
  (it) => {
    it.effect("rejects a purged parent at commit without poisoning other agents' searches", () =>
      Effect.gen(function* () {
        const env = yield* TestEnv;
        yield* (yield* Nodes).append({
          projectId: env.project.id,
          sessionId: env.session.id,
          kind: "user",
          text: "purge this while its vectors are saving",
        });
        const saving = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        yield* Ref.set(
          beforeSave,
          Deferred.succeed(saving, undefined).pipe(Effect.andThen(Deferred.await(release))),
        );
        const indexer = yield* Indexer;
        const indexing = yield* indexer.indexAll().pipe(Effect.forkChild);
        yield* Deferred.await(saving);
        const trace = yield* WorkTraceStore;
        const request = trace.requestSessionLifecycle({
          sessionId: env.session.id,
          intent: "delete",
          idempotencyKey: "purge-during-save",
        });
        const { operationId } = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ operationId: Schema.String }),
        )(request);
        expect(trace.finalizeSessionLifecycle(operationId)).toMatchObject({ status: "completed" });
        yield* Ref.set(beforeSave, Effect.void);
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(indexing)).toBe(0);
        const vectors = yield* VectorIndex;
        yield* vectors.flushRemovals;
        expect(vectors.size()).toBe(0);
        const result = yield* (yield* MemorySearch).find({
          projectId: env.project.id,
          query: "purge",
          crossProject: false,
        });
        expect(result.matches).toEqual([]);
      }),
    );
  },
);
