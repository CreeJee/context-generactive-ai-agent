import { Array as Arr, Context, Effect, Layer, Order, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { type GoalOutcome, OutcomeId, type PlanStep, StepWork } from "./contracts.ts";
import { WorkflowStorageError } from "./workflow.ts";

/**
 * One judgment of whether the Goal branch meets an outcome, made once every card serving the
 * outcome was done. It holds while the outcome keeps `outcomeText` and its cards keep the work in
 * `cards`.
 */
export const OutcomeVerdict = Schema.Struct({
  outcomeId: OutcomeId,
  outcomeText: Schema.String,
  met: Schema.Boolean,
  summary: Schema.String,
  evidence: Schema.Array(Schema.String),
  cards: Schema.Array(StepWork),
  /** The Goal branch commit that was checked; null when no branch was checked out. */
  goalHead: Schema.NullOr(Schema.String),
  runId: Schema.NullOr(Schema.String),
  at: Schema.String,
});
export type OutcomeVerdict = typeof OutcomeVerdict.Type;

/** Where an outcome of the current Goal stands. */
export const OutcomeStatus = Schema.TaggedUnion({
  /** No card serves the outcome. */
  Unplanned: {},
  /** Cards serving the outcome are not done yet. */
  InProgress: { pending: Schema.Array(Schema.String) },
  /**
   * Every card serving the outcome is done and no verdict holds for it. `stale` when an earlier
   * verdict judged another outcome text or other card work.
   */
  AwaitingCheck: { stale: Schema.Boolean },
  Met: { summary: Schema.String },
  NotMet: { summary: Schema.String },
});
export type OutcomeStatus = typeof OutcomeStatus.Type;

/** An outcome status as the model reads it: one plain word. */
export const outcomeStatusWord = OutcomeStatus.match({
  Unplanned: () => "unplanned" as const,
  InProgress: () => "in_progress" as const,
  AwaitingCheck: () => "awaiting_check" as const,
  Met: () => "met" as const,
  NotMet: () => "not_met" as const,
});

export const OutcomeStanding = Schema.Struct({
  outcomeId: OutcomeId,
  outcomeText: Schema.String,
  status: OutcomeStatus,
});
export type OutcomeStanding = typeof OutcomeStanding.Type;

const byId = Order.mapInput(Order.String, (card: StepWork) => card.id);
const sameWork = Schema.toEquivalence(Schema.Array(StepWork));
const workOf = (cards: readonly StepWork[]) =>
  Arr.sort(
    cards.map(({ id, title, description, dependsOn, acceptanceCriteria, ruleRefs }) => ({
      id,
      title,
      description,
      dependsOn,
      acceptanceCriteria,
      ruleRefs,
    })),
    byId,
  );

/** The cards an outcome's verdict judges: every step that serves it, by id. */
export const servingCards = (input: {
  readonly steps: readonly PlanStep[];
  readonly outcomeId: string;
}) => workOf(input.steps.filter((step) => step.outcomes.includes(input.outcomeId)));

/** Each outcome of the Goal with its status, from the Plan's steps and each outcome's latest verdict. */
export const outcomeStandings = ({
  outcomes,
  steps,
  latest,
}: {
  readonly outcomes: readonly GoalOutcome[];
  readonly steps: readonly PlanStep[];
  readonly latest: readonly OutcomeVerdict[];
}): ReadonlyArray<OutcomeStanding> =>
  outcomes.map(({ id, text }) => {
    const serving = steps.filter((step) => step.outcomes.includes(id));
    const pending = serving.filter((step) => step.status !== "done").map((step) => step.id);
    const verdict = latest.find((candidate) => candidate.outcomeId === id);
    const holds =
      verdict !== undefined &&
      verdict.outcomeText === text &&
      sameWork(workOf(verdict.cards), workOf(serving));
    const status: OutcomeStatus =
      serving.length === 0
        ? OutcomeStatus.cases.Unplanned.make({})
        : pending.length > 0
          ? OutcomeStatus.cases.InProgress.make({ pending })
          : !holds
            ? OutcomeStatus.cases.AwaitingCheck.make({ stale: verdict !== undefined })
            : verdict.met
              ? OutcomeStatus.cases.Met.make({ summary: verdict.summary })
              : OutcomeStatus.cases.NotMet.make({ summary: verdict.summary });
    return { outcomeId: id, outcomeText: text, status };
  });

const VerdictRow = Schema.Struct({
  outcome_id: OutcomeId,
  outcome_text: Schema.String,
  met: Schema.Literals([0, 1]),
  summary: Schema.String,
  evidence_json: Schema.fromJsonString(Schema.Array(Schema.String)),
  cards_json: Schema.fromJsonString(Schema.Array(StepWork)),
  goal_head: Schema.NullOr(Schema.String),
  run_id: Schema.NullOr(Schema.String),
  at: Schema.String,
});

/** The outcome verdicts of each Goal instance; a verdict is added, never changed. */
export class OutcomeLedger extends Context.Service<
  OutcomeLedger,
  {
    readonly record: (
      goalInstanceId: string,
      verdict: OutcomeVerdict,
    ) => Effect.Effect<void, WorkflowStorageError>;
    /** Each outcome's latest verdict. */
    readonly latest: (
      goalInstanceId: string,
    ) => Effect.Effect<ReadonlyArray<OutcomeVerdict>, WorkflowStorageError>;
  }
>()("memory-agent/workflow/outcome-ledger/OutcomeLedger") {
  static readonly layer = Layer.effect(
    OutcomeLedger,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const insert = SqlSchema.void({
        Request: Schema.Struct({ goalInstanceId: Schema.String, row: VerdictRow }),
        execute: ({ goalInstanceId, row }) =>
          sql`INSERT INTO workflow_outcome_verdicts (goal_instance_id, outcome_id, outcome_text, met,
              summary, evidence_json, cards_json, goal_head, run_id, at)
            VALUES (${goalInstanceId}, ${row.outcome_id}, ${row.outcome_text}, ${row.met},
              ${row.summary}, ${row.evidence_json}, ${row.cards_json}, ${row.goal_head},
              ${row.run_id}, ${row.at})`,
      });
      const latest = SqlSchema.findAll({
        Request: Schema.String,
        Result: VerdictRow,
        execute: (goalInstanceId) =>
          sql`SELECT outcome_id, outcome_text, met, summary, evidence_json, cards_json, goal_head,
              run_id, at
            FROM workflow_outcome_verdicts v
            WHERE goal_instance_id = ${goalInstanceId}
              AND id = (SELECT max(id) FROM workflow_outcome_verdicts w
                WHERE w.goal_instance_id = v.goal_instance_id AND w.outcome_id = v.outcome_id)
            ORDER BY outcome_id`,
      });
      const stored = (cause: unknown) => WorkflowStorageError.make({ cause });
      return {
        record: (goalInstanceId, verdict) =>
          insert({
            goalInstanceId,
            row: {
              outcome_id: verdict.outcomeId,
              outcome_text: verdict.outcomeText,
              met: verdict.met ? 1 : 0,
              summary: verdict.summary,
              evidence_json: verdict.evidence,
              cards_json: workOf(verdict.cards),
              goal_head: verdict.goalHead,
              run_id: verdict.runId,
              at: verdict.at,
            },
          }).pipe(Effect.mapError(stored)),
        latest: (goalInstanceId) =>
          latest(goalInstanceId).pipe(
            Effect.map(
              Arr.map((row): OutcomeVerdict => ({
                outcomeId: row.outcome_id,
                outcomeText: row.outcome_text,
                met: row.met === 1,
                summary: row.summary,
                evidence: row.evidence_json,
                cards: row.cards_json,
                goalHead: row.goal_head,
                runId: row.run_id,
                at: row.at,
              })),
            ),
            Effect.mapError(stored),
          ),
      };
    }),
  );
}
