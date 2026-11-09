import { Array as Arr, Context, Effect, HashMap, Iterable, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { currentStatesSql } from "./state-rows.ts";
import { GoalOrder } from "../kanban/goal-order.ts";
import { planEnded, UserChange, UserChangeRequestStatus } from "./board-edit.ts";
import { BoardAuthor, type CardStatus } from "./card.ts";
import {
  GoalArtifact,
  type BoardCard,
  type BoardRevision,
  type BoardView,
  type ProjectBoard,
} from "./contracts.ts";
import { OutcomeLedger, outcomeStandings } from "./outcome-ledger.ts";
import { decodeRevisionPlan, PlanStep, WorkflowStorageError } from "./workflow.ts";

/** Cards in each column of a board. */
export type BoardColumnCounts = Readonly<Record<CardStatus, number>>;

export type { BoardCard, BoardRevision, BoardView, ProjectBoard };

/** The latest revisions whose changes attribute cards. */
const revisionWindow = 200;
const historyLimit = 30;

/** A revision of the window that changed cards. */
const ChangeRow = Schema.Struct({
  id: Schema.Int,
  card_ids_json: Schema.fromJsonString(Schema.Array(Schema.String)),
  author_json: Schema.NullOr(Schema.fromJsonString(BoardAuthor)),
  created_at: Schema.String,
});
/** The detail of the last ledger event a revision covers. */
const DetailRow = Schema.Struct({ id: Schema.Int, detail: Schema.NullOr(Schema.String) });
const ChangeRequestRow = Schema.Struct({
  id: Schema.Int,
  card_id: Schema.String,
  plan_version: Schema.Int,
  change_json: Schema.fromJsonString(UserChange),
  status: UserChangeRequestStatus,
  reason: Schema.NullOr(Schema.String),
  created_at: Schema.String,
});
const ProjectBoardRow = Schema.Struct({
  session_id: Schema.String,
  title: Schema.NullOr(Schema.String),
  plan_json: Schema.NullOr(Schema.String),
  updated_at: Schema.String,
  kanban_active: Schema.Literals([0, 1]),
});

const noCards: BoardColumnCounts = {
  backlog: 0,
  ready: 0,
  in_progress: 0,
  verify: 0,
  human_decision: 0,
  done: 0,
  blocked: 0,
};
const countedBy = (steps: readonly PlanStep[]): BoardColumnCounts =>
  steps.reduce<BoardColumnCounts>(
    (counts, step) => ({ ...counts, [step.status]: counts[step.status] + 1 }),
    noCards,
  );

/** Read side of the board: cards, their authors and the changes waiting for the orchestrator. */
export class Boards extends Context.Service<
  Boards,
  {
    readonly view: (sessionId: string) => Effect.Effect<BoardView, WorkflowStorageError>;
    /** The project's boards: every unarchived conversation with a Plan, running boards first. */
    readonly list: (
      projectId: string,
    ) => Effect.Effect<readonly ProjectBoard[], WorkflowStorageError>;
  }
>()("memory-agent/workflow/board/Boards") {
  static readonly layer = Layer.effect(
    Boards,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const goalOrder = yield* GoalOrder;
      const ledger = yield* OutcomeLedger;
      const currentStates = sql.literal(currentStatesSql);
      const current = SqlSchema.findOneOption({
        Request: Schema.String,
        Result: Schema.Struct({
          plan_json: Schema.NullOr(Schema.String),
          goal_json: Schema.NullOr(Schema.fromJsonString(GoalArtifact)),
          goal_instance_id: Schema.NullOr(Schema.String),
        }),
        execute: (sessionId) =>
          sql`SELECT r.plan_json, r.goal_json, (SELECT g.goal_instance_id
              FROM workflow_goal_identities g WHERE g.session_id = w.session_id) AS goal_instance_id
            FROM ${currentStates} WHERE w.session_id = ${sessionId}`,
      });
      // Newest first. The window starts at the oldest of the session's latest revisions.
      const changes = SqlSchema.findAll({
        Request: Schema.String,
        Result: ChangeRow,
        execute: (sessionId) => sql`SELECT c.revision_id AS id, c.card_ids_json, r.author_json,
          r.created_at FROM workflow_board_changes c
          JOIN workflow_state_revisions r ON r.id = c.revision_id
          WHERE c.session_id = ${sessionId} AND c.revision_id >= coalesce(
            (SELECT id FROM workflow_state_revisions WHERE session_id = ${sessionId}
              ORDER BY id DESC LIMIT 1 OFFSET ${revisionWindow - 1}), 0)
          ORDER BY c.revision_id DESC`,
      });
      // The ledger events stay in SQLite: the board shows only each revision's last one.
      const details = SqlSchema.findAll({
        Request: Schema.NonEmptyArray(Schema.Int),
        Result: DetailRow,
        execute: (ids) => sql`SELECT r.id, (SELECT e.detail FROM workflow_ledger_events e
            WHERE e.session_id = r.session_id AND e.sequence <= r.ledger_length
            ORDER BY e.sequence DESC LIMIT 1) AS detail
          FROM workflow_state_revisions r WHERE r.id IN ${sql.in(ids)}`,
      });
      const pending = SqlSchema.findAll({
        Request: Schema.String,
        Result: ChangeRequestRow,
        execute: (sessionId) => sql`SELECT id, card_id, plan_version, change_json, status, reason,
          created_at FROM board_change_requests
          WHERE session_id = ${sessionId} AND status = 'pending' ORDER BY id`,
      });
      // A board runs when the session's current Goal has an active kanban row.
      const projectBoards = SqlSchema.findAll({
        Request: Schema.String,
        Result: ProjectBoardRow,
        execute: (projectId) => sql`SELECT w.session_id, s.title, r.plan_json,
          w.updated_at,
          EXISTS(SELECT 1 FROM kanban_goals k JOIN workflow_goal_identities g
            ON g.goal_instance_id = k.goal_instance_id
            WHERE g.session_id = w.session_id AND k.status = 'active') AS kanban_active
          FROM ${currentStates} JOIN sessions s ON s.id = w.session_id
          WHERE s.project_id = ${projectId} AND s.archived_at IS NULL
          ORDER BY kanban_active DESC, w.updated_at DESC`,
      });

      return Boards.of({
        list: (projectId) =>
          Effect.gen(function* () {
            const rows = yield* projectBoards(projectId);
            const rankOf = HashMap.fromIterable(
              Iterable.map(yield* goalOrder.goals(projectId), (sessionId, rank) => [
                sessionId,
                rank,
              ]),
            );
            const boards = yield* Effect.forEach(rows, (row) =>
              Effect.map(decodeRevisionPlan(row.plan_json), (plan): readonly ProjectBoard[] =>
                // An ended Plan (completed or closed) leaves the project board list; its
                // conversation's own board keeps showing it as it ended.
                plan === null || planEnded(plan)
                  ? []
                  : [
                      {
                        sessionId: row.session_id,
                        sessionTitle: row.title,
                        plan: {
                          version: plan.version,
                          status: plan.status,
                          summary: plan.summary,
                        },
                        counts: countedBy(plan.steps),
                        kanbanActive: row.kanban_active === 1,
                        updatedAt: row.updated_at,
                        rank: Option.getOrElse(
                          HashMap.get(rankOf, row.session_id),
                          () => rows.length,
                        ),
                      },
                    ],
              ),
            );
            return boards.flat();
          }).pipe(Effect.mapError((cause) => WorkflowStorageError.make({ cause }))),
        view: (sessionId) =>
          Effect.gen(function* () {
            const row = yield* current(sessionId);
            const plan = Option.isNone(row) ? null : yield* decodeRevisionPlan(row.value.plan_json);
            const changed = yield* changes(sessionId);
            const shown = changed.slice(0, historyLimit);
            const detailOf = yield* Arr.match(shown, {
              onEmpty: () => Effect.succeed(HashMap.empty<number, string | null>()),
              onNonEmpty: (rows) =>
                Effect.map(details(Arr.map(rows, (row) => row.id)), (found) =>
                  HashMap.fromIterable(Iterable.map(found, (row) => [row.id, row.detail])),
                ),
            });
            const history = shown.map((revision): BoardRevision => ({
              revisionId: revision.id,
              at: revision.created_at,
              author: revision.author_json,
              detail: Option.getOrNull(HashMap.get(detailOf, revision.id)) ?? "",
              cardIds: revision.card_ids_json,
            }));
            // Oldest first, so each card keeps its newest change.
            const lastChange = HashMap.fromIterable(
              Iterable.flatMap(changed.toReversed(), ({ author_json, created_at, card_ids_json }) =>
                Iterable.map(card_ids_json, (id): [string, BoardCard["lastChange"]] => [
                  id,
                  { author: author_json, at: created_at },
                ]),
              ),
            );
            const view: BoardView = {
              plan:
                plan === null
                  ? null
                  : { version: plan.version, status: plan.status, summary: plan.summary },
              cards: (plan?.steps ?? []).map((card) => ({
                card,
                lastChange: Option.getOrNull(HashMap.get(lastChange, card.id)),
              })),
              outcomes: yield* Option.match(row, {
                onNone: () => Effect.succeed([]),
                onSome: ({ goal_json, goal_instance_id }) =>
                  Effect.map(
                    goal_instance_id === null
                      ? Effect.succeed([])
                      : ledger.latest(goal_instance_id),
                    (latest) =>
                      outcomeStandings({
                        outcomes: goal_json?.outcomes ?? [],
                        steps: plan?.steps ?? [],
                        latest,
                      }).map(({ outcomeId, outcomeText, status }) => ({
                        id: outcomeId,
                        text: outcomeText,
                        status,
                      })),
                  ),
              }),
              history,
              pendingChanges: (yield* pending(sessionId)).map((request) => ({
                id: request.id,
                cardId: request.card_id,
                planVersion: request.plan_version,
                change: request.change_json,
                status: request.status,
                reason: request.reason,
                createdAt: request.created_at,
              })),
            };
            return view;
          }).pipe(Effect.mapError((cause) => WorkflowStorageError.make({ cause }))),
      });
    }),
  );
}
