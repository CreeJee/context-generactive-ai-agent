import { layer } from "@effect/vitest";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { describe, expect } from "vite-plus/test";
import { StorageRoot, defaultStorageRoot } from "../../src/config/storage-root.ts";
import { Indexer } from "../../src/memory/embedding/indexer.ts";
import { kiwiModel, MorphAnalyzer } from "../../src/memory/morph/analyzer.ts";
import { Nodes } from "../../src/memory/nodes.ts";
import { fakeTerms } from "../../src/testing/fake-morph.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";
import { sqlGet } from "../support/sql.ts";

const indexAll = Effect.flatMap(Indexer, (indexer) => indexer.indexAll());

testAgent()("MemorySearch.find", (it) => {
  it.effect("applies every journaled node change to the lexical index", () =>
    Effect.gen(function* () {
      const { project, session } = yield* TestEnv;
      const nodes = yield* Nodes;
      const indexer = yield* Indexer;
      yield* indexer.lexicalAll();
      yield* nodes.append({
        projectId: project.id,
        sessionId: session.id,
        kind: "user",
        text: "검색엔진",
      });
      yield* nodes.append({
        projectId: project.id,
        sessionId: session.id,
        kind: "user",
        text: " ",
      });
      yield* indexer.lexicalAll();
      expect(yield* sqlGet("SELECT count(*) AS count FROM lexical_changes")).toEqual({ count: 0 });
      // The startup rebuild named the build the journal leads to.
      expect(yield* sqlGet("SELECT instance FROM lexical_index")).toMatchObject({
        instance: expect.any(String),
      });
    }),
  );

  it.effect("stores each node's morpheme terms once", () =>
    Effect.gen(function* () {
      const { project, session } = yield* TestEnv;
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
        const kiwiStorage = yield* defaultStorageRoot;
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
