import { Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { UserChange, UserChangeRequestStatus, type UserChangeRequest } from "./board-edit.ts";
import { BoardAuthor } from "./card.ts";
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
  }
>()("memory-agent/workflow/board/Boards") {
  static readonly layer = Layer.effect(
    Boards,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
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

      return Boards.of({
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
