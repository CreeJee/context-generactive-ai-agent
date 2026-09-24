import type { SQLOutputValue } from "node:sqlite";
import { Context, Effect, Layer, Schema } from "effect";
import { Database } from "../db/database.ts";
import { edgeWeights } from "./edges.ts";

export const InterpretedKind = Schema.Literals(["about", "corrects", "retracts", "related"]);
export type InterpretedKind = typeof InterpretedKind.Type;

/** A conclusion of llm-interpret about one statement. */
export const Interpretation = Schema.Struct({
  nodeId: Schema.String,
  kind: InterpretedKind,
  targetId: Schema.String,
  /** applied: also an llm edge. unconfirmed: the target was unclear; a question, not a fact. */
  status: Schema.Literals(["applied", "unconfirmed"]),
  reason: Schema.String,
  model: Schema.String,
  createdAt: Schema.String,
});
export type Interpretation = typeof Interpretation.Type;

const Row = Schema.Struct({
  node_id: Schema.String,
  kind: InterpretedKind,
  target_id: Schema.String,
  status: Schema.Literals(["applied", "unconfirmed"]),
  reason: Schema.String,
  model: Schema.String,
  created_at: Schema.String,
});
const decodeRow = Schema.decodeUnknownSync(Row);
const toInterpretation = (row: Record<string, SQLOutputValue>): Interpretation => {
  const decoded = decodeRow(row);
  return {
    nodeId: decoded.node_id,
    kind: decoded.kind,
    targetId: decoded.target_id,
    status: decoded.status,
    reason: decoded.reason,
    model: decoded.model,
    createdAt: decoded.created_at,
  };
};

const make = Effect.gen(function* () {
  const { sqlite } = yield* Database;
  const insert = sqlite.prepare(
    "INSERT INTO interpretations (node_id, kind, target_id, status, reason, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const insertEdge = sqlite.prepare(
    "INSERT INTO edges VALUES (?, ?, ?, 'llm', ?, ?) ON CONFLICT DO NOTHING",
  );

  return {
    /**
     * Records a conclusion. An applied one also becomes an llm edge from the statement to its target,
     * so graph walks and traces follow it; an unconfirmed one stays a question.
     */
    record(interpretation: Omit<Interpretation, "createdAt">) {
      const createdAt = new Date().toISOString();
      insert.run(
        interpretation.nodeId,
        interpretation.kind,
        interpretation.targetId,
        interpretation.status,
        interpretation.reason,
        interpretation.model,
        createdAt,
      );
      if (interpretation.status === "applied")
        insertEdge.run(
          interpretation.nodeId,
          interpretation.targetId,
          interpretation.kind,
          edgeWeights[interpretation.kind],
          createdAt,
        );
    },

    /** Conclusions whose target is one of these nodes, oldest first. */
    targeting(targetIds: readonly string[], status: Interpretation["status"]): Interpretation[] {
      if (targetIds.length === 0) return [];
      return sqlite
        .prepare(
          `SELECT * FROM interpretations WHERE status = ? AND target_id IN (${targetIds.map(() => "?").join(", ")}) ORDER BY id`,
        )
        .all(status, ...targetIds)
        .map(toInterpretation);
    },
  };
});

/** Why llm-interpret linked statements, and the corrections it could not attribute for sure. */
export class Interpretations extends Context.Service<
  Interpretations,
  Effect.Success<typeof make>
>()("memory-agent/Interpretations") {
  static readonly layer = Layer.effect(Interpretations, make);
}
