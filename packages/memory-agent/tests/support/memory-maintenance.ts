import { Effect } from "effect";
import { Indexer } from "../../src/memory/embedding/indexer.ts";
import { VectorIndex } from "../../src/memory/embedding/vector-index.ts";
import { MemoryGraphMaintenance } from "../../src/memory/maintenance.ts";
import { Nodes, type Node } from "../../src/memory/nodes.ts";
import { TestEnv } from "./test-env.ts";
import { sqlRun } from "./sql.ts";

/**
 * A store written by an older version: a reversed `returns` edge, an empty answer linked to topics
 * by the model, and a pending interpretation of that empty answer.
 */
export const legacy = Effect.gen(function* () {
  const { project, session } = yield* TestEnv;
  const nodes = yield* Nodes;
  const at = { projectId: project.id, sessionId: session.id };
  const user = yield* nodes.append({ ...at, kind: "user", text: "원문 SQLite 결정" });
  const empty = yield* nodes.append({
    ...at,
    kind: "assistant",
    text: " \n\t",
    links: [{ kind: "reply", nodeId: user.id }],
  });
  const call = yield* nodes.append({
    ...at,
    kind: "tool_call",
    text: "read_file",
    links: [{ kind: "calls", nodeId: empty.id }],
  });
  const result = yield* nodes.append({
    ...at,
    kind: "tool_result",
    text: "CREATE TABLE",
    links: [{ kind: "returns", nodeId: call.id }],
  });
  yield* sqlRun(
    "DELETE FROM edges WHERE from_id = ? AND to_id = ? AND kind = 'returns'",
    call.id,
    result.id,
  );
  yield* sqlRun(
    "INSERT INTO edges VALUES (?, ?, 'returns', 'structure', 0.95, ?)",
    result.id,
    call.id,
    result.createdAt,
  );
  const topic = { projectId: project.id, sessionId: null, kind: "topic" } as const;
  const emptyTopic = yield* nodes.append({ ...topic, text: "내용 없는 응답" });
  const shared = yield* nodes.append({ ...topic, text: "SQLite 저장소" });
  const protectedTopic = yield* nodes.append({
    ...topic,
    text: "사용자가 저장한 기억",
    detail: { authorizedByUserNodeId: user.id },
  });
  yield* nodes.append({ ...topic, text: "다른 독립 주제" });
  const link = Effect.fnUntraced(function* (source: Node, target: Node, kind = "about") {
    yield* sqlRun(
      "INSERT INTO edges VALUES (?, ?, ?, 'llm', 0.8, ?)",
      source.id,
      target.id,
      kind,
      source.createdAt,
    );
    yield* sqlRun(
      "INSERT INTO interpretations (node_id, kind, target_id, status, reason, model, created_at) VALUES (?, ?, ?, 'applied', 'legacy', 'old', ?)",
      source.id,
      kind,
      target.id,
      source.createdAt,
    );
  });
  yield* link(empty, emptyTopic);
  yield* link(empty, shared);
  yield* link(user, shared);
  yield* link(empty, protectedTopic);
  yield* sqlRun(
    "INSERT INTO interpret_jobs (node_id, status, updated_at) VALUES (?, 'pending', ?)",
    empty.id,
    empty.createdAt,
  );
  return { nodes, user, empty, call, result, topic: emptyTopic, link };
});

export const run = Effect.flatMap(MemoryGraphMaintenance, (maintenance) => maintenance.run);
/**
 * The pass the agent starts on its own saw the store before `legacy` wrote into it. Forget it, as
 * if the store came from a version without repairs.
 */
export const asOlderStore = run.pipe(
  Effect.andThen(sqlRun("DELETE FROM memory_graph_maintenance")),
);
export const overview = Effect.flatMap(
  MemoryGraphMaintenance,
  (maintenance) => maintenance.overview,
);
export const indexAll = Effect.flatMap(Indexer, (indexer) => indexer.indexAll());
export const vectorCount = Effect.map(VectorIndex, (vectors) => vectors.size());
