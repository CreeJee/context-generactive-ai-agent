import { Result, Function as EffectFunction } from "effect";
import { isTruthy } from "../truthy.ts";
import { Context, Data, Effect, Layer, Schema, Semaphore } from "effect";
import { Database } from "../db/database.ts";
import { AppEvents } from "../events/app-events.ts";
import { Indexer } from "./embedding/indexer.ts";
import { VectorIndex } from "./embedding/vector-index.ts";
import { meaningfulNodeFilter, memoryGraphRepairVersion, nonBlankTextSql } from "./quality.ts";
import { createSupersededReads } from "./superseded-reads.ts";

export class MemoryGraphRepairFailed extends Data.TaggedError("MemoryGraphRepairFailed")<{
  readonly cause: unknown;
}> {}

const batchSize = 64;
// Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
const decodeProgress = EffectFunction.flow(
  Schema.decodeUnknownResult(
    Schema.Struct({
      through_seq: Schema.Finite,
      after_seq: Schema.Finite,
      status: Schema.Literals(["pending", "running", "completed", "failed"]),
      scanned: Schema.Finite,
      repaired_edges: Schema.Finite,
      suppressed_edges: Schema.Finite,
      retired_topics: Schema.Finite,
      error: Schema.NullOr(Schema.String),
    }),
  ),
  Result.getOrThrow,
);
// Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
const decodeBatch = EffectFunction.flow(
  Schema.decodeUnknownResult(
    Schema.Array(Schema.Struct({ seq: Schema.Finite, id: Schema.String })),
  ),
  Result.getOrThrow,
);

const make = Effect.gen(function* () {
  const { sqlite, atomic } = yield* Database;
  const indexer = yield* Indexer;
  const vectors = yield* VectorIndex;
  const events = yield* AppEvents;
  const scope = yield* Effect.scope;
  const permit = yield* Semaphore.make(1);
  let started = false;
  const version = memoryGraphRepairVersion;

  const saved = sqlite.prepare("SELECT * FROM memory_graph_maintenance WHERE version = ?");
  const initialize = sqlite.prepare(
    "INSERT INTO memory_graph_maintenance (version, through_seq, status) SELECT ?, coalesce(max(seq), 0), 'pending' FROM nodes WHERE true ON CONFLICT DO NOTHING",
  );
  const progress = () => {
    const row = saved.get(version);
    return isTruthy(row)
      ? decodeProgress(row)
      : {
          through_seq: 0,
          after_seq: 0,
          status: "pending" as const,
          scanned: 0,
          repaired_edges: 0,
          suppressed_edges: 0,
          retired_topics: 0,
          error: null,
        };
  };

  const nodes = sqlite.prepare(
    "SELECT seq, id FROM nodes WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT ?",
  );
  const emptyNode = sqlite.prepare(
    `SELECT 1 FROM nodes n WHERE n.id = ? AND NOT (${meaningfulNodeFilter})`,
  );
  const collectTopics = sqlite.prepare(`
    INSERT INTO memory_graph_topic_candidates (node_seq)
    SELECT t.seq FROM edges e JOIN nodes t ON t.id = e.to_id
    WHERE e.from_id = ? AND e.origin = 'llm' AND e.kind = 'about' AND t.kind = 'topic'
    ON CONFLICT DO NOTHING`);
  const archiveEdges = sqlite.prepare(`
    INSERT INTO memory_graph_edge_repairs
      (version, from_id, to_id, kind, origin, weight, created_at, action, replacement_added)
    SELECT ?, e.from_id, e.to_id, e.kind, e.origin, e.weight, e.created_at,
      CASE WHEN e.kind = 'returns' THEN 'reverse' ELSE 'suppress' END,
      CASE WHEN e.kind = 'returns' THEN NOT EXISTS (
        SELECT 1 FROM edges canonical WHERE canonical.from_id = e.to_id
        AND canonical.to_id = e.from_id AND canonical.kind = e.kind) ELSE 0 END
    FROM edges e JOIN nodes n ON n.id = e.from_id JOIN nodes target ON target.id = e.to_id
    WHERE n.id = ? AND (
      (e.kind = 'returns' AND e.origin = 'structure' AND n.kind = 'tool_result'
        AND target.kind = 'tool_call' AND n.project_id = target.project_id
        AND n.session_id = target.session_id)
      OR (e.origin = 'llm' AND (
        NOT (${meaningfulNodeFilter})
        OR NOT (${nonBlankTextSql("target.text")})
      ))
    ) ON CONFLICT DO NOTHING`);
  const archiveInterpretations = sqlite.prepare(`
    INSERT INTO memory_graph_interpretation_repairs (version, interpretation_id, previous_status)
    SELECT ?, i.id, i.status FROM interpretations i
    JOIN memory_graph_edge_repairs r ON r.version = ? AND r.from_id = i.node_id
      AND r.to_id = i.target_id AND r.kind = i.kind AND r.action = 'suppress'
    WHERE i.node_id = ? AND i.status = 'applied' ON CONFLICT DO NOTHING`);
  const demote = sqlite.prepare(`
    UPDATE interpretations SET status = 'unconfirmed' WHERE node_id = ? AND id IN (
      SELECT interpretation_id FROM memory_graph_interpretation_repairs WHERE version = ?)`);
  const reverse = sqlite.prepare(`
    INSERT INTO edges (from_id, to_id, kind, origin, weight, created_at)
    SELECT to_id, from_id, kind, origin, weight, created_at FROM memory_graph_edge_repairs
    WHERE version = ? AND from_id = ? AND action = 'reverse' ON CONFLICT DO NOTHING`);
  const removeEdges = sqlite.prepare(`
    DELETE FROM edges WHERE from_id = ? AND EXISTS (
      SELECT 1 FROM memory_graph_edge_repairs r WHERE r.version = ?
      AND r.from_id = edges.from_id AND r.to_id = edges.to_id AND r.kind = edges.kind)`);
  // Stores older than the rule recorded their reads without it.
  const supersedeEarlierReads = createSupersededReads(sqlite);
  const discardEmptyJobs = sqlite.prepare(`
    DELETE FROM interpret_jobs WHERE node_id = ? AND EXISTS (
      SELECT 1 FROM nodes n WHERE n.id = interpret_jobs.node_id AND NOT (${meaningfulNodeFilter}))`);

  // Version 1 also suppressed every cross-session correction it could not tie to the same
  // decision. Those with a meaningful source and target were suppressed for that reason alone.
  const demotedAcrossSessions = `
    FROM memory_graph_edge_repairs r
    JOIN nodes n ON n.id = r.from_id JOIN nodes target ON target.id = r.to_id
    WHERE r.version = 1 AND r.action = 'suppress' AND r.kind IN ('corrects', 'retracts')
      AND n.session_id IS NOT target.session_id
      AND ${meaningfulNodeFilter} AND ${nonBlankTextSql("target.text")}`;
  const restoreInterpretations = sqlite.prepare(`
    UPDATE interpretations SET status = 'applied' WHERE status = 'unconfirmed' AND id IN (
      SELECT ir.interpretation_id FROM memory_graph_interpretation_repairs ir
      JOIN interpretations i ON i.id = ir.interpretation_id
      WHERE ir.version = 1 AND EXISTS (SELECT 1 ${demotedAcrossSessions}
        AND r.from_id = i.node_id AND r.to_id = i.target_id AND r.kind = i.kind))`);
  const restoreEdges = sqlite.prepare(`
    INSERT INTO edges (from_id, to_id, kind, origin, weight, created_at)
    SELECT r.from_id, r.to_id, r.kind, r.origin, r.weight, r.created_at ${demotedAcrossSessions}
    ON CONFLICT DO NOTHING`);
  const forgetInterpretationRepairs = sqlite.prepare(`
    DELETE FROM memory_graph_interpretation_repairs WHERE version = 1 AND interpretation_id IN (
      SELECT i.id FROM interpretations i WHERE EXISTS (SELECT 1 ${demotedAcrossSessions}
        AND r.from_id = i.node_id AND r.to_id = i.target_id AND r.kind = i.kind))`);
  const forgetEdgeRepairs = sqlite.prepare(`
    DELETE FROM memory_graph_edge_repairs WHERE rowid IN (SELECT r.rowid ${demotedAcrossSessions})`);
  /** Undoes version 1's cross-session demotions. Running it again finds nothing left to undo. */
  const restoreCrossSession = indexer.exclusive(
    Effect.try({
      try: () =>
        atomic(() => {
          restoreInterpretations.run();
          restoreEdges.run();
          forgetInterpretationRepairs.run();
          forgetEdgeRepairs.run();
        }),
      catch: (cause) => new MemoryGraphRepairFailed({ cause }),
    }),
  );

  const topics = sqlite.prepare(`
    SELECT n.seq, n.id FROM memory_graph_topic_candidates c JOIN nodes n ON n.seq = c.node_seq
    ORDER BY n.seq LIMIT ?`);
  const retireTopic = sqlite.prepare(`
    INSERT INTO memory_graph_suppressed_nodes (node_seq, version, reason)
    SELECT n.seq, ?, 'empty_statement_topic' FROM nodes n WHERE n.seq = ? AND n.kind = 'topic'
      AND json_extract(n.detail, '$.memoryCandidateId') IS NULL
      AND json_extract(n.detail, '$.authorizedByUserNodeId') IS NULL
      AND NOT EXISTS (SELECT 1 FROM memory_candidates m WHERE m.memory_node_id = n.id)
      AND NOT EXISTS (SELECT 1 FROM memory_usage_events u WHERE u.memory_node_id = n.id)
      AND NOT EXISTS (SELECT 1 FROM node_refs r WHERE r.node_id = n.id)
      AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.from_id = n.id OR e.to_id = n.id)
    ON CONFLICT DO NOTHING`);
  const queueVectors = sqlite.prepare(`
    INSERT INTO memory_graph_vector_removals (node_seq, embedder)
    SELECT v.node_seq, v.embedder FROM node_vectors v
    JOIN memory_graph_suppressed_nodes s ON s.node_seq = v.node_seq
    WHERE v.node_seq = ? ON CONFLICT DO NOTHING`);
  const finishTopic = sqlite.prepare(
    "DELETE FROM memory_graph_topic_candidates WHERE node_seq = ?",
  );
  const update = sqlite.prepare(`
    UPDATE memory_graph_maintenance SET after_seq = ?, scanned = scanned + ?,
      repaired_edges = (SELECT count(*) FROM memory_graph_edge_repairs WHERE version = ? AND action = 'reverse'),
      suppressed_edges = (SELECT count(*) FROM memory_graph_edge_repairs WHERE version = ? AND action = 'suppress'),
      retired_topics = (SELECT count(*) FROM memory_graph_suppressed_nodes WHERE version = ? AND reason = 'empty_statement_topic')
    WHERE version = ?`);

  const batch = Effect.fnUntraced(function* () {
    const rows = decodeBatch(nodes.all(progress().after_seq, progress().through_seq, batchSize));
    const candidates = decodeBatch(topics.all(batchSize));
    if (rows.length === 0 && candidates.length === 0) return false;
    yield* indexer.exclusive(
      Effect.gen(function* () {
        yield* Effect.try({
          try: () =>
            atomic(() => {
              for (const node of rows) {
                // Remember only topics affected by empty-source links, not every orphan topic.
                const blank = emptyNode.get(node.id);
                if (isTruthy(blank)) collectTopics.run(node.id);
                archiveEdges.run(version, node.id);
                archiveInterpretations.run(version, version, node.id);
                demote.run(node.id, version);
                reverse.run(version, node.id);
                removeEdges.run(node.id, version);
                discardEmptyJobs.run(node.id);
                supersedeEarlierReads(node.id);
              }
              for (const topic of candidates) {
                retireTopic.run(version, topic.seq);
                queueVectors.run(topic.seq);
                finishTopic.run(topic.seq);
              }
              update.run(
                rows.at(-1)?.seq ?? progress().after_seq,
                rows.length,
                version,
                version,
                version,
                version,
              );
            }),
          catch: (cause) => new MemoryGraphRepairFailed({ cause }),
        });
        // SQLite holds durable removal intent before the file changes. Failed saves remain queued.
        yield* vectors.flushRemovals;
      }),
    );
    events.publishGlobal("embedding");
    return true;
  });

  const run = Effect.gen(function* () {
    yield* restoreCrossSession;
    initialize.run(version);
    if (progress().status === "completed") return;
    sqlite
      .prepare(
        "UPDATE memory_graph_maintenance SET status = 'running', error = NULL WHERE version = ?",
      )
      .run(version);
    events.publishGlobal("embedding");
    yield* indexer.exclusive(vectors.flushRemovals);
    while (yield* batch()) yield* Effect.yieldNow;
    sqlite
      .prepare("UPDATE memory_graph_maintenance SET status = 'completed' WHERE version = ?")
      .run(version);
    events.publishGlobal("embedding");
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        sqlite
          .prepare(
            "UPDATE memory_graph_maintenance SET status = 'failed', error = ? WHERE version = ?",
          )
          .run("그래프 정리를 완료하지 못했어요. 다음 시작 시 다시 시도해요.", version);
        events.publishGlobal("embedding");
        yield* Effect.logWarning("Memory graph maintenance failed", cause);
      }),
    ),
    permit.withPermits(1),
  );

  const start = Effect.suspend(() => {
    if (started) return Effect.void;
    started = true;
    return Effect.forkIn(
      run.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            started = false;
          }),
        ),
      ),
      scope,
    ).pipe(Effect.asVoid);
  });
  yield* start;
  return {
    run,
    start,
    overview: Effect.sync(() => {
      const current = progress();
      return {
        version,
        status: current.status,
        scanned: current.scanned,
        repairedEdges: current.repaired_edges,
        suppressedEdges: current.suppressed_edges,
        retiredTopics: current.retired_topics,
        error: current.error,
      };
    }),
  };
});

/**
 * Automatic, local repairs of links older versions wrote wrongly. They only fix what has no use,
 * so every store runs them; original nodes are never deleted or rewritten.
 */
export class MemoryGraphMaintenance extends Context.Service<
  MemoryGraphMaintenance,
  Effect.Success<typeof make>
>()("memory-agent/memory/maintenance/MemoryGraphMaintenance") {
  static readonly layer = Layer.effect(MemoryGraphMaintenance, make);
}
