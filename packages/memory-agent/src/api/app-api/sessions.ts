import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import {
  DecisionAnswer,
  HumanDecisionRequest,
  KanbanBoardView,
  KanbanStarted,
} from "../../kanban/contracts.ts";
import { Session } from "../../sessions/contracts.ts";
import {
  BoardEdit,
  BoardEditApplied,
  BoardEditRequested,
  BoardIntent,
  BoardView,
} from "../../workflow/contracts.ts";
import { PlanDependencyIssue } from "../../workflow/plan-schedule.ts";
import { sessionHolderHeaders } from "../chat-api.ts";
import { appRefusalFields, refusalWith, SameSite } from "../refusal.ts";

const appRefusal = refusalWith(appRefusalFields);

/** A conversation to start in a project, with the app's model or a trusted external agent. */
export const CreateSession = Schema.Struct({
  projectId: Schema.NonEmptyString,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  /** Talk directly to this trusted external ACP agent instead of the app's model. */
  agent: Schema.optional(Schema.NullOr(Schema.NonEmptyString)),
});
export type CreateSession = typeof CreateSession.Type;

/** A person's answer to a card's decision, for the facts they saw. */
export const DecisionAnswerInput = Schema.Struct({
  goalInstanceId: Schema.String,
  cardId: Schema.String,
  /** The facts the person saw; the request's latest are answered only. */
  factsSeq: Schema.Int,
  answer: DecisionAnswer,
});
export type DecisionAnswerInput = typeof DecisionAnswerInput.Type;

/** The board's own commands; a `BoardIntent` is what a person meant by dragging a card. */
export const KanbanCommand = Schema.TaggedUnion({
  /** Runs the executing Plan as a kanban board. */
  Start: {},
  /** Runs the board's loop again after it stopped on exhausted retries or a defect. */
  RestartLoop: {},
  /** The Goals this Goal waits for; an empty list lifts the wait. */
  SetDependencies: { dependsOn: Schema.Array(Schema.String) },
});
export type KanbanCommand = typeof KanbanCommand.Type;

/** Whether the session's Goal runs as a kanban board, and what its loop knows about the cards. */
export const KanbanView = Schema.Union([
  Schema.Struct({ active: Schema.Literal(false) }),
  Schema.Struct({ active: Schema.Literal(true), ...KanbanBoardView.fields }),
]);
export type KanbanView = typeof KanbanView.Type;

/** The board's loop runs again. */
export const KanbanLoopRestarted = Schema.Struct({ restarted: Schema.Literal(true) });

/** The Goals the board's Goal now waits for. */
export const GoalDependencies = Schema.Struct({ dependsOn: Schema.Array(Schema.String) });

/** The project the request names is not registered. */
const UnknownProject = appRefusal(404, ["project_not_found"]);

/** The session the path names does not exist. */
const UnknownSession = appRefusal(404, ["session_not_found"]);

/** Another page holds the session. */
const SessionInUse = appRefusal(423, ["session_in_use"]);

/** The external agent is not configured, trusted and running for the project. */
const AgentUnavailable = appRefusal(409, ["external_agent_unavailable"]);

/**
 * A decision answer refused with its reason: the request is unknown or another card's (404), the
 * answer does not fit the question (400), or the request, card or facts moved on (409).
 */
const DecisionRefusals = [
  appRefusal(404, ["request_missing", "request_mismatch"]),
  appRefusal(400, ["answer_invalid"]),
  appRefusal(409, [
    "card_missing",
    "goal_superseded",
    "request_closed",
    "answer_conflict",
    "facts_changed",
  ]),
] as const;

/** A board change refused because the Plan or the card moved on; the code is the reason. */
const BoardEditRefused = appRefusal(409, [
  "plan_missing",
  "plan_closed",
  "plan_version_conflict",
  "card_missing",
  "card_finished",
  "card_status_changed",
  "card_transition_invalid",
  "card_not_waiting",
  "card_held",
  "card_not_held",
]);

/** The change would break the Plan's dependencies; `issues` says how. */
const PlanDependenciesRejected = refusalWith({ issues: Schema.NonEmptyArray(PlanDependencyIssue) })(
  422,
  ["plan_dependencies_rejected"],
);

/**
 * A kanban action the board's state does not fit, the reason as the code. `request_missing` is
 * also a decision's 404; only the orchestrator's tools raise it here, so it never reaches the page.
 */
const KanbanActionRefused = appRefusal(409, [
  "not_kanban",
  "card_missing",
  "card_running",
  "request_missing",
  "request_settled",
  "reassign_needs_edit",
  "no_goal_change",
  "card_not_blocked",
  "card_not_running",
  "reorder_across_columns",
  "card_waiting",
  "card_has_dependents",
  "transfer_target_invalid",
]);

/** The Goal cannot start as a board: no Goal, no executing Plan, or no usable worktree. */
const KanbanStartRefused = appRefusal(409, [
  "goal_missing",
  "plan_not_executing",
  "worktree_unavailable",
]);

/** The Goal's dependencies were refused; the code is the reason. */
const GoalScheduleRefused = appRefusal(409, [
  "goal_missing",
  "self_dependency",
  "other_project",
  "dependency_cycle",
]);

/** A branch name the scheduler refuses. */
const InvalidKanbanSettings = appRefusal(400, ["invalid_kanban_settings"]);

/** The dead-lettered card was requeued or settled meanwhile, or its worktree is in use. */
const KanbanStateChanged = appRefusal(409, ["queue_item_changed", "worktree_in_use"]);

/** Reading or writing the session's decisions, board or kanban failed; the cause stays on the server. */
const SessionStorageFailed = appRefusal(500, [
  "storage_failed",
  "kanban_storage_failed",
  "workflow_storage_failed",
  "schedule_storage_failed",
  "worktree_failed",
  "platform_failed",
]);

/** Every refusal of the group, for `appRefusalStatus`. */
export const sessionsRefusals = [
  UnknownProject,
  UnknownSession,
  SessionInUse,
  AgentUnavailable,
  ...DecisionRefusals,
  BoardEditRefused,
  PlanDependenciesRejected,
  KanbanActionRefused,
  KanbanStartRefused,
  GoalScheduleRefused,
  InvalidKanbanSettings,
  KanbanStateChanged,
  SessionStorageFailed,
];

const session = { session: Schema.String };

/** A project's conversations and what each one runs (`/api/sessions/*`). */
export class SessionsGroup extends HttpApiGroup.make("sessions")
  .add(
    /** The project's conversations, newest first; `archived=1` lists only the archived ones. */
    HttpApiEndpoint.get("list", "/api/sessions", {
      query: { project: Schema.NonEmptyString, archived: Schema.optional(Schema.Literal("1")) },
      success: Schema.Array(Session),
    }),
    /** Starts a conversation in a project. */
    HttpApiEndpoint.post("create", "/api/sessions", {
      payload: CreateSession,
      success: Session.pipe(HttpApiSchema.status(201)),
      error: [UnknownProject, AgentUnavailable],
    }),
    /** The board's cards waiting for a person's decision. */
    HttpApiEndpoint.get("decisions", "/api/sessions/:session/decisions", {
      params: session,
      success: Schema.Array(HumanDecisionRequest),
      error: [UnknownSession, SessionStorageFailed],
    }),
    /**
     * A person answers a card's decision, from its board or the project inbox. The same answer
     * again is accepted.
     */
    HttpApiEndpoint.post("answerDecision", "/api/sessions/:session/decisions/:decision", {
      params: { ...session, decision: Schema.String },
      headers: sessionHolderHeaders,
      payload: DecisionAnswerInput,
      success: HumanDecisionRequest,
      error: [SessionInUse, ...DecisionRefusals, SessionStorageFailed],
    }),
    /** The Plan as cards, who changed them, and the changes waiting for the orchestrator. */
    HttpApiEndpoint.get("board", "/api/sessions/:session/board", {
      params: session,
      success: BoardView,
      error: [UnknownSession, SessionStorageFailed],
    }),
    /**
     * The user adds, edits, moves or cancels a card, or closes the Plan. A change to an executing
     * card is stored as a request (202) instead.
     */
    HttpApiEndpoint.post("editBoard", "/api/sessions/:session/board", {
      params: session,
      headers: sessionHolderHeaders,
      payload: BoardEdit,
      success: [BoardEditApplied, BoardEditRequested.pipe(HttpApiSchema.status(202))],
      error: [
        SessionInUse,
        UnknownSession,
        BoardEditRefused,
        PlanDependenciesRejected,
        SessionStorageFailed,
      ],
    }),
    /** Whether the Goal runs as a kanban board, and why its cards stopped. */
    HttpApiEndpoint.get("kanban", "/api/sessions/:session/kanban", {
      params: session,
      success: KanbanView,
      error: [UnknownSession, SessionStorageFailed],
    }),
    /**
     * Starts the board, restarts its loop, sets the Goals it waits for, or carries out what a
     * person meant by dragging a card. The owner decides the card's status and refuses an intent
     * the card's state does not fit; a change request to an executing card is stored (202).
     */
    HttpApiEndpoint.post("kanbanAction", "/api/sessions/:session/kanban", {
      params: session,
      headers: sessionHolderHeaders,
      payload: Schema.Union([KanbanCommand, BoardIntent]),
      success: [
        KanbanStarted,
        KanbanLoopRestarted,
        GoalDependencies,
        BoardEditApplied,
        BoardEditRequested.pipe(HttpApiSchema.status(202)),
      ],
      error: [
        SessionInUse,
        UnknownProject,
        UnknownSession,
        BoardEditRefused,
        PlanDependenciesRejected,
        KanbanActionRefused,
        KanbanStartRefused,
        GoalScheduleRefused,
        InvalidKanbanSettings,
        KanbanStateChanged,
        SessionStorageFailed,
      ],
    }),
  )
  .middleware(SameSite) {}
