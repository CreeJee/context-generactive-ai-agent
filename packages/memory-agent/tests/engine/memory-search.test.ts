import { Effect } from "effect";
import { expect } from "vite-plus/test";
import { Indexer } from "../../src/memory/embedding/indexer.ts";
import { Nodes } from "../../src/memory/nodes.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";
import { sqlGet } from "../support/sql.ts";

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
});
