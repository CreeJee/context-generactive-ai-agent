import { toolDefinition, type AnyServerTool } from "@tanstack/ai";
import { Context, Effect, Layer, Option, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { AppEvents } from "../events/app-events.ts";
import { toToolSchema } from "../tools/schema.ts";
import { CardDraft, type BoardEditRefused } from "../workflow/board-edit.ts";
import type { PlanDependenciesRejected } from "../workflow/plan-schedule.ts";
import type { WorkflowStorageError } from "../workflow/workflow.ts";
import { Boards } from "../workflow/board.ts";
import { BoardAuthor, CardStatus } from "../workflow/card.ts";
import {
  ChangeDecision,
  GoalChangeVerdict,
  KanbanBoardActions,
  type KanbanActionRefused,
} from "./board-actions.ts";
import type { KanbanStorageFailed } from "./card-attempts.ts";
import type { HumanDecisionRefused } from "./human-decision.ts";
import type { PersistedQueueItemsFailed } from "./persisted-queue-store.ts";
import type { CardWorktreeFailed } from "./worktree.ts";
import type { KanbanAttentionReason } from "./orchestrator.ts";

/**
 * The orchestrator model's kanban tools (docs/kanban-orchestration.md "수정 권한"). The loop runs
 * the cards; the model answers what the loop cannot decide: replanning, users' change requests
 * and a changed Goal. Each change is saved with the calling run as its `Orchestrator` author.
 */

const CardId = Schema.String.annotate({ description: "A card id on the board." });

const SplitCardInput = Schema.Struct({
  cardId: CardId,
  parts: Schema.Array(CardDraft).pipe(Schema.check(Schema.isMinLength(2))),
});
const MergeCardsInput = Schema.Struct({
  cardIds: Schema.Array(CardId).pipe(Schema.check(Schema.isMinLength(2))),
  card: CardDraft,
});
const CardInput = Schema.Struct({ cardId: CardId });
const MoveCardInput = Schema.Struct({
  cardId: CardId,
  from: CardStatus.annotate({ description: "The status the board shows for the card now." }),
  to: CardStatus,
});
const SettleChangeRequestInput = Schema.Struct({
  requestId: Schema.Int,
  decision: ChangeDecision,
});
const ApplyGoalChangeInput = Schema.Struct({
  verdicts: Schema.Array(GoalChangeVerdict).annotate({
    description: "One verdict per card that is not done; a card without one continues.",
  }),
});
const ReadBoardInput = Schema.Struct({});

/** What a board change can fail with; refusals are answered to the model, the rest fail the call. */
type ActionFailure =
  | KanbanActionRefused
  | BoardEditRefused
  | HumanDecisionRefused
  | PlanDependenciesRejected
  | KanbanStorageFailed
  | CardWorktreeFailed
  | PersistedQueueItemsFailed
  | WorkflowStorageError
  | PlatformError;

const make = Effect.gen(function* () {
  const events = yield* AppEvents;
  const runtime = yield* Effect.context<KanbanBoardActions | Boards>();
  const run = Effect.runPromiseWith(runtime);

  return {
    forSession(sessionId: string, runId: string): AnyServerTool[] {
      const author: BoardAuthor = BoardAuthor.cases.Orchestrator.make({ runId });
      /** Runs a board change and tells pages the board moved; a refusal is the call's answer. */
      const change = <A>(
        effect: (actions: KanbanBoardActions["Service"]) => Effect.Effect<A, ActionFailure>,
      ) =>
        Effect.flatMap(KanbanBoardActions, effect).pipe(
          Effect.tap(() => events.publishSession(sessionId, "run-state")),
          Effect.catchTags({
            KanbanActionRefused: (refused) =>
              Effect.succeed({ error: "kanban_action_refused" as const, reason: refused.reason }),
            BoardEditRefused: (refused) =>
              Effect.succeed({ error: "board_edit_refused" as const, reason: refused.reason }),
            HumanDecisionRefused: (refused) =>
              Effect.succeed({ error: "human_decision_refused" as const, reason: refused.reason }),
            PlanDependenciesRejected: () =>
              Effect.succeed({ error: "plan_dependencies_rejected" as const }),
          }),
          run,
        );

      const readBoard = toolDefinition({
        name: "read_kanban_board",
        description:
          "Read the kanban board: each card's status, why the loop stopped it (failures, replan requests, conflicts, uncertain effects), users' pending change requests, and whether a changed Goal holds new assignments.",
        inputSchema: toToolSchema(ReadBoardInput),
      }).server(() =>
        run(
          Effect.gen(function* () {
            const view = yield* (yield* KanbanBoardActions).view(sessionId);
            if (Option.isNone(view)) return { error: "not_kanban" as const };
            const board = yield* (yield* Boards).view(sessionId);
            const titles = new Map(board.cards.map(({ card }) => [card.id, card]));
            return {
              ...view.value,
              cards: view.value.cards.map((card) => ({
                ...card,
                title: titles.get(card.cardId)?.title ?? "",
                dependsOn: titles.get(card.cardId)?.dependsOn ?? [],
              })),
              pendingChanges: board.pendingChanges,
            };
          }),
        ),
      );

      const splitCard = toolDefinition({
        name: "split_card",
        description:
          "Replace a card that is not running with smaller cards. The parts keep the card's dependencies, and cards that depended on it wait for every part.",
        inputSchema: toToolSchema(SplitCardInput),
      }).server((input) =>
        change((actions) => actions.splitCard(sessionId, input.cardId, input.parts, author)),
      );
      const mergeCards = toolDefinition({
        name: "merge_cards",
        description:
          "Replace cards that are not running with one card that does all of their work. Cards that depended on any of them depend on the new card.",
        inputSchema: toToolSchema(MergeCardsInput),
      }).server((input) =>
        change((actions) => actions.mergeCards(sessionId, input.cardIds, input.card, author)),
      );
      const cancelCard = toolDefinition({
        name: "cancel_card",
        description:
          "Take a card off the board. A running attempt is stopped; the card's work stays on its branch.",
        inputSchema: toToolSchema(CardInput),
      }).server((input) =>
        change((actions) => actions.cancelCard(sessionId, input.cardId, author)),
      );
      const moveCard = toolDefinition({
        name: "move_card",
        description:
          "Move a card between statuses. Moving a running card stops its attempt. Moving a blocked card back to ready after replanning it starts a new failure streak; the next repeated failure goes to a person.",
        inputSchema: toToolSchema(MoveCardInput),
      }).server((input) =>
        change((actions) =>
          actions.moveCard(
            sessionId,
            { cardId: input.cardId, from: input.from, to: input.to },
            author,
          ),
        ),
      );
      const settleChangeRequest = toolDefinition({
        name: "settle_change_request",
        description:
          "Settle a user's pending change to a running card: Apply continues the card with the change at once, Reassign applies it and restarts the card in a fresh agent conversation, Reject keeps the card as it is and records your reason for the user.",
        inputSchema: toToolSchema(SettleChangeRequestInput),
      }).server((input) =>
        change((actions) =>
          actions.settleChangeRequest(sessionId, input.requestId, input.decision, author),
        ),
      );
      const applyGoalChange = toolDefinition({
        name: "apply_goal_change",
        description:
          "After the Goal changed, classify every card that is not done against the new Goal: Continue, Amend (change the card and tell its agent), Stop (block it with a reason), Replace (a new card takes its place) or NeedsDecision (a person decides). New assignments resume once this is saved.",
        inputSchema: toToolSchema(ApplyGoalChangeInput),
      }).server((input) =>
        change((actions) => actions.applyGoalChange(sessionId, input.verdicts, author)),
      );
      const requeueCard = toolDefinition({
        name: "requeue_card",
        description:
          "Put a blocked card whose deliveries ran out back on the queue. It continues in its worktree with a fresh delivery budget.",
        inputSchema: toToolSchema(CardInput),
      }).server((input) =>
        change((actions) =>
          Effect.map(actions.requeueCard(sessionId, input.cardId, author), (requeued) => ({
            requeued,
          })),
        ),
      );
      return [
        readBoard,
        splitCard,
        mergeCards,
        cancelCard,
        moveCard,
        settleChangeRequest,
        applyGoalChange,
        requeueCard,
      ];
    },
  };
});

/** Board tools of a session whose Goal runs as a kanban board. */
export class KanbanTools extends Context.Service<KanbanTools, Effect.Success<typeof make>>()(
  "memory-agent/kanban/tools/KanbanTools",
) {
  static readonly layer = Layer.effect(KanbanTools, make);
}

export const kanbanInstructions = `This Goal runs as a kanban board. The owner's loop assigns ready cards to card agents in separate git worktrees, verifies each finished card and squashes it into the Goal branch; you do not execute cards yourself and do not mark card progress with update_workflow_progress.
Your part is what the loop cannot decide. Read the board with read_kanban_board, then:
- A blocked card with a replan request: split, merge, edit or cancel it, then move it back to ready.
- A user's change request to a running card: settle it with settle_change_request (Apply, Reassign or Reject with a reason).
- A changed Goal: classify every card that is not done with apply_goal_change; new assignments wait for it.
- A blocked card whose deliveries ran out: requeue_card once the cause is understood.
Cards in human_decision wait for a person; do not move them yourself unless the user tells you to.`;

const reasonText = {
  goal_changed: "The Goal changed: classify the cards with apply_goal_change.",
  replan_requested: "A card keeps failing and asks to be replanned.",
  change_requested: "A user asked to change a running card: settle it.",
  cards_done:
    "Every card is done: the owner checks the whole Goal branch and merges it into the user's branch; read the board's merge state and record the Goal's verification from it.",
  file_overlap:
    "A card's expected files overlap a running card of another Goal; the later card waits. Reorder or split cards if waiting is not right.",
  goal_unverified:
    "The Goal-level check of the Goal branch failed: add or replan cards to fix it; the merge is checked again once they are done.",
  upstream_regressed:
    "Another Goal merged into this Goal's target and a finished card no longer passes: add cards to fix it.",
} as const satisfies { readonly [Reason in KanbanAttentionReason]: string };

/** The automatic follow-up prompt when the loop needs the model. */
export const kanbanAttentionPrompt = (reasons: readonly KanbanAttentionReason[]) =>
  [
    "This is an automatic kanban board follow-up, not a new user request or approval. Read the board with read_kanban_board and handle:",
    ...reasons.map((reason) => `- ${reasonText[reason]}`),
  ].join("\n");
