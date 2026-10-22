import { Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { GoalOrder } from "../kanban/goal-order.ts";
import { UserChange, UserChangeRequestStatus, type UserChangeRequest } from "./board-edit.ts";
import { BoardAuthor, type CardStatus } from "./card.ts";
import {
  decodeWorkflowState,
  PlanStep,
  WorkflowStorageError,
  type PlanArtifact,
  type WorkflowState,
} from "./workflow.ts";

/** A card with the author of the latest revision that changed it, when one is recorded. */
export interface BoardCard {
  readonly card: PlanStep;
  readonly lastChange: { readonly author: BoardAuthor | null; readonly at: string } | null;
}

/** One saved revision that changed cards, newest first in the view. */
export interface BoardRevision {
  readonly revisionId: number;
  readonly at: string;
  /** Null for revisions saved before authors were recorded, or by phase and lifecycle saves. */
  readonly author: BoardAuthor | null;
  readonly detail: string;
  readonly cardIds: readonly string[];
}

/** `GET /api/sessions/:session/board`: the Plan as a board and how it got there. */
export interface BoardView {
  readonly plan: Pick<PlanArtifact, "version" | "status" | "summary"> | null;
  readonly cards: readonly BoardCard[];
  readonly history: readonly BoardRevision[];
  readonly pendingChanges: readonly UserChangeRequest[];
}

/** Cards in each column of a board. */
export type BoardColumnCounts = Readonly<Record<CardStatus, number>>;

/** `GET /api/projects/:project/boards`: one conversation's Plan as a board, without its cards. */
export interface ProjectBoard {
  readonly sessionId: string;
  readonly sessionTitle: string | null;
  readonly plan: Pick<PlanArtifact, "version" | "status" | "summary">;
  readonly counts: BoardColumnCounts;
  /** Whether the session's current Goal runs as an active kanban board. */
  readonly kanbanActive: boolean;
  /** When the Plan was last saved. */
  readonly updatedAt: string;
  /** The conversation's place among the project's Goals in the priority tree, from 0. */
  readonly rank: number;
}

/** Revisions read to attribute cards; one more is the baseline of the oldest. */
const revisionWindow = 200;
const historyLimit = 30;

const RevisionRow = Schema.Struct({
  id: Schema.Int,
  state_json: Schema.String,
  author_json: Schema.NullOr(Schema.fromJsonString(BoardAuthor)),
  created_at: Schema.String,
});
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
  state_json: Schema.String,
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

const encodeCard = Schema.encodeEffect(Schema.fromJsonString(PlanStep));

/** Each card's encoded form, compared between consecutive revisions. */
const cardsOf = (state: WorkflowState) =>
  Effect.map(
    Effect.forEach(state.plan?.steps ?? [], (step) =>
      Effect.map(encodeCard(step), (json) => [step.id, json] as const),
    ),
    (entries) => new Map(entries),
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
      const current = SqlSchema.findOneOption({
        Request: Schema.String,
        Result: Schema.Struct({ state_json: Schema.String }),
        execute: (sessionId) =>
          sql`SELECT state_json FROM session_workflows WHERE session_id = ${sessionId}`,
      });
      const revisions = SqlSchema.findAll({
        Request: Schema.String,
        Result: RevisionRow,
        execute: (sessionId) => sql`SELECT id, state_json, author_json, created_at
          FROM workflow_state_revisions
          WHERE session_id = ${sessionId} ORDER BY id DESC LIMIT ${revisionWindow + 1}`,
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
        execute: (projectId) => sql`SELECT w.session_id, s.title, w.state_json, w.updated_at,
          EXISTS(SELECT 1 FROM kanban_goals k JOIN workflow_goal_identities g
            ON g.goal_instance_id = k.goal_instance_id
            WHERE g.session_id = w.session_id AND k.status = 'active') AS kanban_active
          FROM session_workflows w JOIN sessions s ON s.id = w.session_id
          WHERE s.project_id = ${projectId} AND s.archived_at IS NULL
          ORDER BY kanban_active DESC, w.updated_at DESC`,
      });

      return Boards.of({
        list: (projectId) =>
          Effect.gen(function* () {
            const rows = yield* projectBoards(projectId);
            const rankOf = new Map(
              (yield* goalOrder.goals(projectId)).map((sessionId, rank) => [sessionId, rank]),
            );
            const boards = yield* Effect.forEach(rows, (row) =>
              Effect.map(
                decodeWorkflowState(row.state_json),
                ({ plan }): readonly ProjectBoard[] =>
                  plan === null
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
                          rank: rankOf.get(row.session_id) ?? rows.length,
                        },
                      ],
              ),
            );
            return boards.flat();
          }).pipe(Effect.mapError((cause) => WorkflowStorageError.make({ cause }))),
        view: (sessionId) =>
          Effect.gen(function* () {
            const row = yield* current(sessionId);
            const plan = Option.isNone(row)
              ? null
              : (yield* decodeWorkflowState(row.value.state_json)).plan;
            const window = (yield* revisions(sessionId)).toReversed();
            // The oldest row is only the baseline when the window is full.
            const full = window.length > revisionWindow;
            const baseline = full ? window[0] : undefined;
            const changes = full ? window.slice(1) : window;
            let previous =
              baseline === undefined
                ? new Map<string, string>()
                : yield* cardsOf(yield* decodeWorkflowState(baseline.state_json));
            const lastChange = new Map<string, BoardCard["lastChange"]>();
            const history: BoardRevision[] = [];
            for (const revision of changes) {
              const state = yield* decodeWorkflowState(revision.state_json);
              const next = yield* cardsOf(state);
              const cardIds = [
                ...[...next].filter(([id, json]) => previous.get(id) !== json).map(([id]) => id),
                ...[...previous.keys()].filter((id) => !next.has(id)),
              ];
              previous = next;
              if (cardIds.length === 0) continue;
              for (const id of cardIds)
                lastChange.set(id, { author: revision.author_json, at: revision.created_at });
              history.push({
                revisionId: revision.id,
                at: revision.created_at,
                author: revision.author_json,
                detail: state.ledger.at(-1)?.detail ?? "",
                cardIds,
              });
            }
            const view: BoardView = {
              plan:
                plan === null
                  ? null
                  : { version: plan.version, status: plan.status, summary: plan.summary },
              cards: (plan?.steps ?? []).map((card) => ({
                card,
                lastChange: lastChange.get(card.id) ?? null,
              })),
              history: history.toReversed().slice(0, historyLimit),
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
