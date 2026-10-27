import { Context, Effect, Layer, Match, Option, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { AppEvents } from "../events/app-events.ts";
import { runTool, type RunTool } from "../tools/run-tool.ts";
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

/** One change to the board; the tool description says what each does. */
const KanbanEdit = Schema.TaggedUnion({
  Split: {
    cardId: CardId,
    parts: Schema.Array(CardDraft).pipe(Schema.check(Schema.isMinLength(2))),
  },
  Merge: {
    cardIds: Schema.Array(CardId).pipe(Schema.check(Schema.isMinLength(2))),
    card: CardDraft,
  },
  Cancel: { cardId: CardId },
  Move: {
    cardId: CardId,
    from: CardStatus.annotate({ description: "The status the board shows for the card now." }),
    to: CardStatus,
  },
  Requeue: { cardId: CardId },
  SettleChangeRequest: { requestId: Schema.Int, decision: ChangeDecision },
  ApplyGoalChange: { verdicts: Schema.Array(GoalChangeVerdict) },
});
const EditBoardInput = Schema.Struct({ edit: KanbanEdit });
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

const readBoard = {
  name: "read_kanban_board",
  description:
    "Read the kanban board: each card's status, why the loop stopped it (failures, replan requests, conflicts, uncertain effects), users' pending change requests, and whether a changed Goal holds new assignments.",
  parameters: ReadBoardInput,
} as const;

const editBoard = {
  name: "edit_kanban_board",
  description: `Change the kanban board; edit._tag picks the change:
- Split: replace a card that is not running with smaller cards. The parts keep its dependencies, and cards that depended on it wait for every part.
- Merge: replace cards that are not running with one card that does all of their work. Cards that depended on any of them depend on the new card.
- Cancel: take a card off the board. A running attempt is stopped; the card's work stays on its branch.
- Move: move a card between statuses. Moving a running card stops its attempt. Moving a blocked card back to ready after replanning it starts a new failure streak; the next repeated failure goes to a person.
- Requeue: put a blocked card whose deliveries ran out back on the queue. It continues in its worktree with a fresh delivery budget.
- SettleChangeRequest: settle a user's pending change to a running card. Apply continues the card with the change at once, Reassign applies it and restarts the card in a fresh agent conversation, Reject keeps the card as it is and records your reason for the user.
- ApplyGoalChange: after the Goal changed, give one verdict per card that is not done (a card without one continues): Continue, Amend (change the card and tell its agent), Stop (block it with a reason), Replace (a new card takes its place) or NeedsDecision (a person decides). New assignments resume once this is saved.`,
  parameters: EditBoardInput,
} as const;

const make = Effect.gen(function* () {
  const events = yield* AppEvents;
  const runtime = yield* Effect.context<KanbanBoardActions | Boards>();

  /** The tools' calls in `sessionId`, each change saved as the run `runId`'s. */
  const callsFor = (sessionId: string, runId: string) => {
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
        Effect.provideContext(runtime),
      );

    return {
      readBoard: () =>
        Effect.gen(function* () {
          const boards = yield* Boards;
          return yield* Option.match(yield* (yield* KanbanBoardActions).view(sessionId), {
            onNone: () => Effect.succeed({ error: "not_kanban" as const }),
            onSome: (view) =>
              Effect.map(boards.view(sessionId), (board) => {
                const titles = new Map(board.cards.map(({ card }) => [card.id, card]));
                return {
                  ...view,
                  cards: view.cards.map((card) => ({
                    ...card,
                    title: titles.get(card.cardId)?.title ?? "",
                    dependsOn: titles.get(card.cardId)?.dependsOn ?? [],
                  })),
                  pendingChanges: board.pendingChanges,
                };
              }),
          });
        }).pipe(Effect.provideContext(runtime)),

      editBoard: ({ edit }: typeof EditBoardInput.Type) =>
        change((actions) =>
          Match.valueTags(edit, {
            Split: ({ cardId, parts }) => actions.splitCard(sessionId, cardId, parts, author),
            Merge: ({ cardIds, card }) => actions.mergeCards(sessionId, cardIds, card, author),
            Cancel: ({ cardId }) => actions.cancelCard(sessionId, cardId, author),
            Move: ({ cardId, from, to }) =>
              actions.moveCard(sessionId, { cardId, from, to }, author),
            Requeue: ({ cardId }) =>
              Effect.map(actions.requeueCard(sessionId, cardId, author), (requeued) => ({
                requeued,
              })),
            SettleChangeRequest: ({ requestId, decision }) =>
              actions.settleChangeRequest(sessionId, requestId, decision, author),
            ApplyGoalChange: ({ verdicts }) => actions.applyGoalChange(sessionId, verdicts, author),
          }),
        ),
    };
  };

  return {
    /** The board tools of a run in `sessionId`. */
    toolsFor(sessionId: string, runId: string): RunTool[] {
      const calls = callsFor(sessionId, runId);
      return [
        runTool({ ...readBoard, handler: calls.readBoard }),
        runTool({ ...editBoard, handler: calls.editBoard }),
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
Your part is what the loop cannot decide. Read the board with read_kanban_board, then change it with edit_kanban_board:
- A blocked card with a replan request: Split, Merge, edit or Cancel it, then Move it back to ready.
- A user's change request to a running card: SettleChangeRequest (Apply, Reassign or Reject with a reason).
- A changed Goal: ApplyGoalChange for every card that is not done; new assignments wait for it.
- A blocked card whose deliveries ran out: Requeue once the cause is understood.
Cards in human_decision wait for a person; do not move them yourself unless the user tells you to.`;

const reasonText = {
  goal_changed: "The Goal changed: classify the cards with edit_kanban_board ApplyGoalChange.",
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
