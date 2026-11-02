import { Effect, Scope } from "effect";
import { expect } from "vite-plus/test";
import { EmbeddingSetup } from "../../src/memory/embedding/setup.ts";
import { Graph } from "../../src/memory/graph.ts";
import type { Node } from "../../src/memory/nodes.ts";
import { MemorySearch } from "../../src/memory/search.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import { type AgentServices, TestEnv, testAgent } from "../support/test-env.ts";
import { sqlAll, sqlGet, sqlRun } from "../support/sql.ts";
import {
  asOlderStore,
  indexAll,
  legacy,
  overview,
  run,
  vectorCount,
} from "../support/memory-maintenance.ts";

/** Repairs scan and rewrite the whole store, so each test owns its agent. */
const alone = <E>(
  name: string,
  test: () => Effect.Effect<void, E, AgentServices | TestEnv | Scope.Scope>,
) => testAgent()("automatic memory graph maintenance", (it) => it.effect(name, test));

alone("repairs already embedded nodes while preserving originals and useful vectors", () =>
  Effect.gen(function* () {
    const env = yield* TestEnv;
    const c = yield* legacy;
    yield* indexAll;
    const original = yield* sqlAll("SELECT * FROM nodes ORDER BY seq");
    const before = yield* vectorCount;
    yield* sqlRun("INSERT INTO node_vectors VALUES (?, 'inactive-model')", c.topic.seq);
    yield* asOlderStore;
    yield* run;
    expect((yield* (yield* Graph).trace(c.result.id))?.chain.map((node) => node.id)).toEqual([
      c.result.id,
      c.call.id,
      c.empty.id,
      c.user.id,
    ]);
    expect(yield* sqlAll("SELECT * FROM nodes ORDER BY seq")).toEqual(original);
    expect(yield* sqlAll("SELECT node_seq FROM memory_graph_suppressed_nodes")).toEqual([
      { node_seq: c.topic.seq },
    ]);
    expect(yield* vectorCount).toBe(before - 1);
    expect(yield* sqlAll("SELECT * FROM memory_graph_vector_removals")).toEqual([
      { node_seq: c.topic.seq, embedder: "inactive-model" },
    ]);
    expect(yield* indexAll).toBe(0);
    expect(
      yield* sqlGet("SELECT * FROM interpret_jobs WHERE node_id = ?", c.empty.id),
    ).toBeUndefined();
    expect(yield* sqlAll("PRAGMA foreign_key_check")).toEqual([]);
    expect(yield* sqlGet("PRAGMA integrity_check")).toEqual({ integrity_check: "ok" });
    const state = yield* overview;
    expect(state).toMatchObject({
      status: "completed",
      repairedEdges: 1,
      suppressedEdges: 3,
      retiredTopics: 1,
    });
    const found = yield* (yield* MemorySearch).find({
      query: c.topic.text,
      projectId: env.project.id,
    });
    expect(found.matches.some((match) => match.id === c.topic.id || match.id === c.empty.id)).toBe(
      false,
    );
    // A second pass over a repaired store changes nothing, before or after reopening.
    yield* run;
    expect(yield* overview).toEqual(state);
    yield* env.reopen;
    expect(yield* env.use(indexAll)).toBe(0);
    expect(yield* env.use(vectorCount)).toBe(before - 1);
  }),
);

alone("an older store is repaired when the agent starts, without a manual command", () =>
  Effect.gen(function* () {
    const env = yield* TestEnv;
    yield* legacy;
    yield* asOlderStore;
    yield* env.reopen;
    // Wait on the same pass permit, rather than guessing how long a background job takes.
    yield* env.use(run);
    expect(yield* env.use(Effect.flatMap(EmbeddingSetup, (setup) => setup.overview))).toMatchObject(
      { maintenance: { status: "completed", repairedEdges: 1 } },
    );
  }),
);

alone(
  "cross-session corrections keep their interpretation, and version 1 demotions come back",
  () =>
    Effect.gen(function* () {
      const { project, session } = yield* TestEnv;
      const c = yield* legacy;
      const another = yield* (yield* Sessions).create(project.id);
      const cross = yield* c.nodes.append({
        projectId: project.id,
        sessionId: another.id,
        kind: "user",
        text: "도구 없이 1부터 60까지 써줘",
      });
      const same = yield* c.nodes.append({
        projectId: project.id,
        sessionId: session.id,
        kind: "user",
        text: "아니 SQLite 대신 Postgres로 바꾸자",
      });
      const demoted = yield* c.nodes.append({
        projectId: project.id,
        sessionId: another.id,
        kind: "user",
        text: "SQLite 말고 DuckDB로 하자",
      });
      yield* c.link(cross, c.user, "corrects");
      yield* c.link(same, c.user, "corrects");
      yield* c.link(demoted, c.user, "corrects");
      // What version 1 did to a cross-session correction: archive it, demote it, drop the edge.
      yield* sqlRun(
        "INSERT INTO memory_graph_edge_repairs (version, from_id, to_id, kind, origin, weight, created_at, action) VALUES (1, ?, ?, 'corrects', 'llm', 0.8, ?, 'suppress')",
        demoted.id,
        c.user.id,
        demoted.createdAt,
      );
      yield* sqlRun(
        "INSERT INTO memory_graph_interpretation_repairs SELECT 1, id, status FROM interpretations WHERE node_id = ?",
        demoted.id,
      );
      yield* sqlRun(
        "UPDATE interpretations SET status = 'unconfirmed' WHERE node_id = ?",
        demoted.id,
      );
      yield* sqlRun("DELETE FROM edges WHERE from_id = ?", demoted.id);
      yield* asOlderStore;
      yield* run;
      const status = (node: Node) =>
        sqlGet(
          "SELECT status FROM interpretations WHERE node_id = ? AND kind = 'corrects'",
          node.id,
        );
      expect(yield* status(cross)).toEqual({ status: "applied" });
      expect(yield* status(same)).toEqual({ status: "applied" });
      expect(yield* status(demoted)).toEqual({ status: "applied" });
      expect(
        yield* sqlAll(
          "SELECT kind FROM edges WHERE from_id = ? AND to_id = ?",
          demoted.id,
          c.user.id,
        ),
      ).toEqual([{ kind: "corrects" }]);
    }),
);
