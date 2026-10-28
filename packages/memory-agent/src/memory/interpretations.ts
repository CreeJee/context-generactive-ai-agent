import { Array as EffectArray, DateTime, Context, Effect, Layer, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { meaningfulNodeFilter } from "./quality.ts";
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
const toInterpretation = (row: typeof Row.Type): Interpretation => ({
  nodeId: row.node_id,
  kind: row.kind,
  targetId: row.target_id,
  status: row.status,
  reason: row.reason,
  model: row.model,
  createdAt: row.created_at,
});

/** Interpretations could not be read or written; the cause stays with the error. */
export class InterpretationStoreFailed extends Schema.TaggedError<
  InterpretationStoreFailed,
  { readonly brand: unique symbol }
>()("InterpretationStoreFailed", { cause: Schema.Defect() }) {}
const stored = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.mapError(effect, (cause) => InterpretationStoreFailed.make({ cause }));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const validEndpoints = SqlSchema.findOne({
    Request: Schema.Struct({ nodeId: Schema.String, targetId: Schema.String }),
    Result: Schema.Struct({ count: Schema.Finite }),
    execute: ({ nodeId, targetId }) => sql`SELECT count(*) AS count FROM nodes n
      WHERE n.id IN (${nodeId}, ${targetId}) AND ${sql.literal(meaningfulNodeFilter)}`,
  });
  const targetingRows = SqlSchema.findAll({
    Request: Schema.Struct({
      targetIds: Schema.Array(Schema.String),
      status: Schema.Literals(["applied", "unconfirmed"]),
    }),
    Result: Row,
    execute: ({ targetIds, status }) => sql`SELECT * FROM interpretations
      WHERE status = ${status} AND target_id IN ${sql.in(targetIds)} ORDER BY id`,
  });

  return {
    /**
     * Records a conclusion. An applied one also becomes an llm edge from the statement to its target,
     * so graph walks and traces follow it; an unconfirmed one stays a question.
     */
    record: (interpretation: Omit<Interpretation, "createdAt">) =>
      stored(
        Effect.when(
          Effect.gen(function* () {
            const createdAt = DateTime.formatIso(yield* DateTime.now);
            yield* sql`INSERT INTO interpretations ${sql.insert({
              node_id: interpretation.nodeId,
              kind: interpretation.kind,
              target_id: interpretation.targetId,
              status: interpretation.status,
              reason: interpretation.reason,
              model: interpretation.model,
              created_at: createdAt,
            })}`;
            yield* Effect.when(
              sql`INSERT INTO edges VALUES (${interpretation.nodeId}, ${interpretation.targetId},
                ${interpretation.kind}, 'llm', ${edgeWeights[interpretation.kind]}, ${createdAt})
                ON CONFLICT DO NOTHING`,
              Effect.succeed(interpretation.status === "applied"),
            );
          }),
          Effect.map(validEndpoints(interpretation), ({ count }) => count === 2),
        ).pipe(Effect.asVoid, sql.withTransaction),
      ),

    /** Conclusions whose target is one of these nodes, oldest first. */
    targeting: (targetIds: readonly string[], status: Interpretation["status"]) =>
      targetIds.length === 0
        ? Effect.succeed(EffectArray.empty<Interpretation>())
        : stored(
            Effect.map(targetingRows({ targetIds, status }), (rows) => rows.map(toInterpretation)),
          ),
  };
});

/** Why llm-interpret linked statements, and the corrections it could not attribute for sure. */
export class Interpretations extends Context.Service<
  Interpretations,
  Effect.Success<typeof make>
>()("memory-agent/memory/interpretations") {
  static readonly layer = Layer.effect(Interpretations, make);
}
