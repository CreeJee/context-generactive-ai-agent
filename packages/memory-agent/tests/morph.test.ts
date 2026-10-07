import { it as effectTest } from "@effect/vitest";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { homedir } from "node:os";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { describe, expect } from "vite-plus/test";
import { StorageRoot } from "../src/config/storage-root.ts";
import { Database } from "../src/db/database.ts";
import { Indexer } from "../src/memory/embedding/indexer.ts";
import { MorphAnalyzer, kiwiModel } from "../src/memory/morph/analyzer.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { MemorySearch } from "../src/memory/search.ts";
import { fakeTerms } from "../src/testing/fake-morph.ts";
import { testRuntime } from "./support/runtime.ts";

const Terms = Schema.Struct({ terms: Schema.String });

describe("morpheme search terms", () => {
  effectTest.live(
    "stores each node's terms once and lets particles and endings differ in a search",
    () =>
      Effect.gen(function* () {
        const { runtime, project, session } = yield* Effect.promise(() => testRuntime());
        const found = yield* Effect.provideContext(
          Effect.gen(function* () {
            const nodes = yield* Nodes;
            const append = (text: string) =>
              nodes.append({ projectId: project.id, sessionId: session.id, kind: "user", text });
            const target = append("결제모듈은 토스페이먼츠로 연동하기로 했다");
            append("회의실 예약은 금요일까지");
            append("디자인 시안은 다음 주에 공유");
            const indexer = yield* Indexer;
            yield* indexer.indexAll();
            const analyzed = yield* indexer.analyzeAll();
            const again = yield* indexer.analyzeAll();
            const { sqlite } = yield* Database;
            const stored = yield* Schema.decodeUnknownEffect(Terms)(
              sqlite.prepare("SELECT terms FROM nodes_morph WHERE rowid = ?").get(target.seq),
            );
            // "결제모듈을" never occurs as text, so only the morpheme terms tie the question to it.
            const result = yield* (yield* MemorySearch).find({
              query: "결제모듈을 어디로 정했지",
              projectId: project.id,
            });
            return { target, analyzed, again, stored, result };
          }),
          yield* runtime.contextEffect,
        );
        expect(found.analyzed).toBe(3);
        expect(found.again).toBe(0);
        expect(found.stored.terms).toBe(
          fakeTerms("결제모듈은 토스페이먼츠로 연동하기로 했다").join(" "),
        );
        expect(found.result.degraded).toEqual([]);
        expect(found.result.matches[0]?.id).toBe(found.target.id);
      }),
  );

  effectTest.live(
    "a search does not wait for an analyzer that is still loading; it says so and warms it",
    () =>
      Effect.gen(function* () {
        let warmed = 0;
        const loading = Layer.succeed(MorphAnalyzer, {
          identity: "loading",
          ready: () => false,
          warm: () => void warmed++,
          terms: () => Effect.die("not loaded"),
        });
        const { runtime, project } = yield* Effect.promise(() =>
          testRuntime({ morphAnalyzer: loading }),
        );
        const result = yield* Effect.provideContext(
          Effect.flatMap(MemorySearch, (search) =>
            search.find({ query: "아무거나", projectId: project.id }),
          ),
          yield* runtime.contextEffect,
        );
        expect(result.degraded).toEqual(["morph"]);
        expect(warmed).toBe(1);
      }),
  );
});

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
  effectTest.effect(
    "keeps nouns and stems and drops particles and endings",
    () =>
      Effect.gen(function* () {
        const terms = yield* Effect.scoped(
          Effect.flatMap(MorphAnalyzer, (analyzer) =>
            analyzer.terms([
              "로그 포맷은 JSON Lines로 하기로 했다.",
              "로그 형식을 뭐로 정했었지?",
              "메인 데이터베이스는 PostgreSQL, 대시보드는 Grafana.",
            ]),
          ),
        ).pipe(
          // Test entry point owns this Layer and its resource scope.
          Effect.fnUntraced(function* <A, E, R>(program: Effect.Effect<A, E, R>) {
            const services = yield* Layer.build(
              MorphAnalyzer.kiwi.pipe(Layer.provide(StorageRoot.layer(kiwiStorage))),
            );
            return yield* Effect.provideContext(program, services);
          }, Effect.scoped),
        );
        expect(terms[0]).toEqual(expect.arrayContaining(["로그", "포맷", "json", "lines"]));
        expect(terms[1]).toEqual(expect.arrayContaining(["로그", "형식", "정하"]));
        // Split compounds also count whole; Latin words come from the text, not Kiwi's pieces.
        expect(terms[2]).toEqual(expect.arrayContaining(["데이터베이스", "postgresql", "grafana"]));
        expect(terms.flat()).not.toContain("은");
        expect(terms.flat()).not.toContain("하");
      }),
    60_000,
  );
});
