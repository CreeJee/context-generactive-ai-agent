import { Context, Data, Effect, Layer, Match, Option, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { AppEvents } from "../events/app-events.ts";
import { runTool, type RunTool } from "../tools/run-tool.ts";
import {
  CardDraft,
  CardPatch,
  cardTransitions,
  type BoardEditRefused,
} from "../workflow/board-edit.ts";
import type { PlanDependenciesRejected } from "../workflow/plan-schedule.ts";
import { type PlanOutcomesRejected, unknownStepOutcomeText } from "../workflow/step-outcomes.ts";
import {
  OutcomeLedger,
  outcomeStandings,
  OutcomeStatus,
  type OutcomeStanding,
} from "../workflow/outcome-ledger.ts";
import { Workflows, type WorkflowStorageError } from "../workflow/workflow.ts";
import { Boards } from "../workflow/board.ts";
import { BoardAuthor, CardStatus } from "../workflow/card.ts";
import {
  ChangeDecision,
  GoalChangeVerdict,
  KanbanBoardActions,
  type KanbanActionRefused,
} from "./board-actions.ts";
import type { KanbanStorageFailed } from "./card-attempts.ts";
import type { GoalScheduleStorageFailed } from "./goal-schedules.ts";
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

/*
 * The model writes plain keys (`action`, `verdict`, `decision`), not the app's `_tag`
 * (docs/decisions.md 2026-11-09); the handlers turn them into the board actions' tagged unions.
 */

/** The model's verdict on one card against a changed Goal. */
const VerdictInput = Schema.Union([
  Schema.Struct({ verdict: Schema.Literal("continue"), cardId: CardId }),
  Schema.Struct({
    verdict: Schema.Literal("amend"),
    cardId: CardId,
    patch: CardPatch,
    note: Schema.NonEmptyString,
  }),
  Schema.Struct({ verdict: Schema.Literal("stop"), cardId: CardId, reason: Schema.NonEmptyString }),
  Schema.Struct({ verdict: Schema.Literal("replace"), cardId: CardId, card: CardDraft }),
  Schema.Struct({
    verdict: Schema.Literal("needs_decision"),
    cardId: CardId,
    question: Schema.NonEmptyString,
  }),
]).pipe(Schema.toTaggedUnion("verdict"));

const toVerdict = VerdictInput.match({
  continue: ({ cardId }) => GoalChangeVerdict.cases.Continue.make({ cardId }),
  amend: ({ cardId, patch, note }) => GoalChangeVerdict.cases.Amend.make({ cardId, patch, note }),
  stop: ({ cardId, reason }) => GoalChangeVerdict.cases.Stop.make({ cardId, reason }),
  replace: ({ cardId, card }) => GoalChangeVerdict.cases.Replace.make({ cardId, card }),
  needs_decision: ({ cardId, question }) =>
    GoalChangeVerdict.cases.NeedsDecision.make({ cardId, question }),
});

/** Settling a change request; a rejection carries the reason the user is shown. */
const SettleInput = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("settle_change_request"),
    requestId: Schema.Int,
    decision: Schema.Literals(["apply", "reassign"]),
  }),
  Schema.Struct({
    action: Schema.Literal("settle_change_request"),
    requestId: Schema.Int,
    decision: Schema.Literal("reject"),
    reason: Schema.NonEmptyString,
  }),
]);

const toDecision = (settle: typeof SettleInput.Type): ChangeDecision =>
  Match.value(settle).pipe(
    Match.discriminatorsExhaustive("decision")({
      apply: () => ChangeDecision.cases.Apply.make({}),
      reassign: () => ChangeDecision.cases.Reassign.make({}),
      reject: ({ reason }) => ChangeDecision.cases.Reject.make({ reason }),
    }),
  );

/** One change to the board; the tool description says what each does. */
const KanbanEdit = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("split"),
    cardId: CardId,
    parts: Schema.Array(CardDraft).pipe(Schema.check(Schema.isMinLength(2))),
  }),
  Schema.Struct({
    action: Schema.Literal("merge"),
    cardIds: Schema.Array(CardId).pipe(Schema.check(Schema.isMinLength(2))),
    card: CardDraft,
  }),
  Schema.Struct({ action: Schema.Literal("cancel"), cardId: CardId }),
  Schema.Struct({
    action: Schema.Literal("move"),
    cardId: CardId,
    from: CardStatus.annotate({ description: "The status the board shows for the card now." }),
    to: CardStatus,
  }),
  Schema.Struct({ action: Schema.Literal("requeue"), cardId: CardId }),
  ...SettleInput.members,
  Schema.Struct({
    action: Schema.Literal("apply_goal_change"),
    verdicts: Schema.Array(VerdictInput),
  }),
  Schema.Struct({ action: Schema.Literal("retarget") }),
]);
const EditBoardInput = Schema.Struct({ edit: KanbanEdit });
const ReadBoardInput = Schema.Struct({});

/** What a board change can fail with; refusals are answered to the model, the rest fail the call. */
/** A refused move, with the card's status now and the statuses it may move to from there. */
class MoveRefused extends Data.TaggedError("MoveRefused")<{
  readonly reason: BoardEditRefused["reason"];
  readonly status: CardStatus;
  readonly allowed: readonly CardStatus[];
}> {}

type ActionFailure =
  | KanbanActionRefused
  | BoardEditRefused
  | MoveRefused
  | HumanDecisionRefused
  | PlanDependenciesRejected
  | PlanOutcomesRejected
  | KanbanStorageFailed
  | CardWorktreeFailed
  | GoalScheduleStorageFailed
  | PersistedQueueItemsFailed
  | WorkflowStorageError
  | PlatformError;

const readBoard = {
  name: "read_kanban_board",
  description:
    "Read the kanban board: each card's status and the Goal outcomes it serves, why the loop stopped it (failures, replan requests, conflicts, uncertain effects), users' pending change requests, whether a changed Goal holds new assignments, and each Goal outcome's status: unplanned (no card serves it), in_progress (its cards are not done), awaiting_check (its cards are done and the owner is judging it), met or not_met (the owner's verdict on the Goal branch).",
  parameters: ReadBoardInput,
} as const;

const editBoard = {
  name: "edit_kanban_board",
  description: `Change the kanban board; edit.action picks the change:
- split: replace a card that is not running with smaller cards. The parts keep its dependencies, and cards that depended on it wait for every part.
- merge: replace cards that are not running with one card that does all of their work. Cards that depended on any of them depend on the new card.
- cancel: take a card off the board. A running attempt is stopped; the card's work stays on its branch.
- move: move a card between statuses. Moving a running card stops its attempt. Moving a blocked card back to ready after replanning it starts a new failure streak; the next repeated failure goes to a person. A refused move answers the card's status now and the statuses it may move to.
- requeue: put a blocked card whose deliveries ran out back on the queue. It continues in its worktree with a fresh delivery budget.
- settle_change_request: settle a user's pending change to a running card. decision apply continues the card with the change at once, reassign applies it and restarts the card in a fresh agent conversation, reject keeps the card as it is and records your reason for the user.
- apply_goal_change: after the Goal changed, give one verdict per card that is not done (a card without one continues): continue, amend (change the card and tell its agent), stop (block it with a reason), replace (a new card takes its place) or needs_decision (a person decides). New assignments resume once this is saved.
- retarget: make the branch checked out in the project now the Goal's target (the board's schedule.targetBranch) and restart the Goal branch from it, so new cards start from that branch. Only before the Goal has work of its own; refused with not_worktree, merge_started, detached_head, goal_has_work (the Goal branch has commits neither branch holds) or cards_started (branches ctx/card/<goalInstanceId>/* exist, cancelled cards' included).
A new or changed card names in outcomes the ids of the current Goal outcomes it serves; an id the Goal does not have refuses the change with plan_outcomes_rejected.`,
  parameters: EditBoardInput,
} as const;

/** An outcome's status as the model reads it: plain keys, the status a word. */
const outcomeView = ({ outcomeId, outcomeText, status }: OutcomeStanding) => ({
  id: outcomeId,
  text: outcomeText,
  ...OutcomeStatus.match(status, {
    Unplanned: () => ({ status: "unplanned" as const }),
    InProgress: ({ pending }) => ({ status: "in_progress" as const, pendingCards: pending }),
    AwaitingCheck: ({ stale }) => ({
      status: "awaiting_check" as const,
      earlierVerdictStale: stale,
    }),
    Met: ({ summary }) => ({ status: "met" as const, verdict: summary }),
    NotMet: ({ summary }) => ({ status: "not_met" as const, verdict: summary }),
  }),
});

const make = Effect.gen(function* () {
  const events = yield* AppEvents;
  const boards = yield* Boards;
  const workflows = yield* Workflows;
  const ledger = yield* OutcomeLedger;
  const runtime = yield* Effect.context<KanbanBoardActions | Boards>();

  /** The tools' calls in `sessionId`, each change saved as the run `runId`'s. */
  const callsFor = (sessionId: string, runId: string) => {
    const author: BoardAuthor = BoardAuthor.cases.Orchestrator.make({ runId });
    /**
     * Runs a board change and tells pages the board moved. A refusal changed nothing: it is the
     * call's answer and tells no one.
     */
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
          MoveRefused: ({ reason, status, allowed }) =>
            Effect.succeed({ error: "board_edit_refused" as const, reason, status, allowed }),
          HumanDecisionRefused: (refused) =>
            Effect.succeed({ error: "human_decision_refused" as const, reason: refused.reason }),
          PlanDependenciesRejected: () =>
            Effect.succeed({ error: "plan_dependencies_rejected" as const }),
          PlanOutcomesRejected: ({ unknown }) =>
            Effect.succeed({
              error: "plan_outcomes_rejected" as const,
              issues: unknown.map(unknownStepOutcomeText),
            }),
        }),
        Effect.provideContext(runtime),
      );
    /** A refused move answered with the card's status now and where it may go from there. */
    const refusedMove = (cardId: string) => (refused: BoardEditRefused) =>
      Effect.flatMap(boards.view(sessionId), (board) => {
        const status = board.cards.find(({ card }) => card.id === cardId)?.card.status;
        return Effect.fail(
          status === undefined
            ? refused
            : new MoveRefused({ reason: refused.reason, status, allowed: cardTransitions[status] }),
        );
      });

    return {
      readBoard: () =>
        Effect.gen(function* () {
          return yield* Option.match(yield* (yield* KanbanBoardActions).view(sessionId), {
            onNone: () => Effect.succeed({ error: "not_kanban" as const }),
            onSome: (view) =>
              Effect.gen(function* () {
                const board = yield* boards.view(sessionId);
                const state = yield* workflows.get(sessionId);
                const titles = new Map(board.cards.map(({ card }) => [card.id, card]));
                const outcomes = outcomeStandings({
                  outcomes: state.goal?.outcomes ?? [],
                  steps: state.plan?.steps ?? [],
                  latest: yield* ledger.latest(view.goalInstanceId),
                });
                return {
                  ...view,
                  cards: view.cards.map((card) => ({
                    ...card,
                    title: titles.get(card.cardId)?.title ?? "",
                    dependsOn: titles.get(card.cardId)?.dependsOn ?? [],
                    outcomes: titles.get(card.cardId)?.outcomes ?? [],
                  })),
                  pendingChanges: board.pendingChanges,
                  outcomes: outcomes.map(outcomeView),
                };
              }),
          });
        }).pipe(Effect.provideContext(runtime)),

      editBoard: ({ edit }: typeof EditBoardInput.Type) =>
        change((actions) =>
          Match.value(edit).pipe(
            Match.discriminatorsExhaustive("action")({
              split: ({ cardId, parts }) => actions.splitCard(sessionId, cardId, parts, author),
              merge: ({ cardIds, card }) => actions.mergeCards(sessionId, cardIds, card, author),
              cancel: ({ cardId }) => actions.cancelCard(sessionId, cardId, author),
              move: ({ cardId, from, to }) =>
                actions
                  .moveCard(sessionId, { cardId, from, to }, author)
                  .pipe(Effect.catchTag("BoardEditRefused", refusedMove(cardId))),
              requeue: ({ cardId }) =>
                Effect.map(actions.requeueCard(sessionId, cardId, author), (requeued) => ({
                  requeued,
                })),
              settle_change_request: (settle) =>
                actions.settleChangeRequest(
                  sessionId,
                  settle.requestId,
                  toDecision(settle),
                  author,
                ),
              apply_goal_change: ({ verdicts }) =>
                actions.applyGoalChange(sessionId, verdicts.map(toVerdict), author),
              retarget: () => actions.retarget(sessionId),
            }),
          ),
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
- A blocked card with a replan request: split, merge or cancel it, or change its fields with edit_plan, then move it back to ready.
- A user's change request to a running card: settle_change_request (apply, reassign, or reject with a reason).
- A changed Goal: apply_goal_change for every card that is not done; new assignments wait for it.
- A blocked card whose deliveries ran out: requeue once the cause is understood.
- The user asks the board to target the branch they now have checked out: retarget.
- A Goal outcome that is unplanned or not_met: add cards that serve it (their outcomes name its id), reading a not_met verdict for what is missing.
Cards in human_decision wait for a person; do not move them yourself unless the user tells you to.`;

const reasonText = {
  goal_changed: "The Goal changed: classify the cards with edit_kanban_board apply_goal_change.",
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
