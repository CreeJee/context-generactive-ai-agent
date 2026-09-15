import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";
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
  test("stores each node's terms once and lets particles and endings differ in a search", async () => {
    const { runtime, project, session } = await testRuntime();
    const found = await runtime.runPromise(
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
        const stored = Schema.decodeUnknownSync(Terms)(
          sqlite.prepare("SELECT terms FROM nodes_morph WHERE rowid = ?").get(target.seq),
        );
        // "결제모듈을" never occurs as text, so only the morpheme terms tie the question to it.
        const result = yield* (yield* MemorySearch).find({
          query: "결제모듈을 어디로 정했지",
          projectId: project.id,
        });
        return { target, analyzed, again, stored, result };
      }),
    );
    expect(found.analyzed).toBe(3);
    expect(found.again).toBe(0);
    expect(found.stored.terms).toBe(
      fakeTerms("결제모듈은 토스페이먼츠로 연동하기로 했다").join(" "),
    );
    expect(found.result.degraded).toEqual([]);
    expect(found.result.matches[0]?.id).toBe(found.target.id);
  });

  test("a search does not wait for an analyzer that is still loading; it says so and warms it", async () => {
    let warmed = 0;
    const loading = Layer.succeed(MorphAnalyzer, {
      identity: "loading",
      ready: () => false,
      warm: () => void warmed++,
      terms: () => Effect.die("not loaded"),
    });
    const { runtime, project } = await testRuntime({ morphAnalyzer: loading });
    const result = await runtime.runPromise(
      Effect.flatMap(MemorySearch, (search) =>
        search.find({ query: "아무거나", projectId: project.id }),
      ),
    );
    expect(result.degraded).toEqual(["morph"]);
    expect(warmed).toBe(1);
  });
});

const kiwiStorage = join(homedir(), ".context-generactive-agent");
const kiwiCached = existsSync(
  join(kiwiStorage, "models", `kiwi-${kiwiModel.version}`, kiwiModel.directory, "cong.mdl"),
);

describe.skipIf(!kiwiCached)("Kiwi (model already downloaded)", () => {
  test("keeps nouns and stems and drops particles and endings", async () => {
    const terms = await Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(MorphAnalyzer, (analyzer) =>
          analyzer.terms([
            "로그 포맷은 JSON Lines로 하기로 했다.",
            "로그 형식을 뭐로 정했었지?",
            "메인 데이터베이스는 PostgreSQL, 대시보드는 Grafana.",
          ]),
        ),
      ).pipe(
        Effect.provide(MorphAnalyzer.kiwi.pipe(Layer.provide(StorageRoot.layer(kiwiStorage)))),
      ),
    );
    expect(terms[0]).toEqual(expect.arrayContaining(["로그", "포맷", "json", "lines"]));
    expect(terms[1]).toEqual(expect.arrayContaining(["로그", "형식", "정하"]));
    // Split compounds also count whole; Latin words come from the text, not Kiwi's pieces.
    expect(terms[2]).toEqual(expect.arrayContaining(["데이터베이스", "postgresql", "grafana"]));
    expect(terms.flat()).not.toContain("은");
    expect(terms.flat()).not.toContain("하");
  }, 60_000);
});
