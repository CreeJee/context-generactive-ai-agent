import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { CancelResult, CompactResult, SessionRunState } from "../../agent/run-state.ts";
import { RelayedApprovalView } from "../../approvals/relayed-state.ts";
import { StoredMessage } from "../../chat-store/schema.ts";
import {
  DecisionAnswer,
  HumanDecisionRequest,
  KanbanBoardView,
  KanbanStarted,
} from "../../kanban/contracts.ts";
import {
  QueuedMessage,
  QueueEditRequest,
  QueueRequest,
  QueueSnapshot,
} from "../../queue/queue-state.ts";
import { LeaseView, Session } from "../../sessions/contracts.ts";
import { SubagentView } from "../../subagents/subagent-state.ts";
import {
  BoardEdit,
  BoardEditApplied,
  BoardEditRequested,
  BoardIntent,
  BoardView,
  UncertainContinueRequest,
  WorkflowAction,
  WorkflowPhase,
  WorkflowState,
} from "../../workflow/contracts.ts";
import { LifecycleResult } from "../../work-trace/contracts.ts";
import { PlanDependencyIssue } from "../../workflow/plan-schedule.ts";
import { sessionHolderHeaders } from "../chat-api.ts";
import { appRefusalFields, refusalWith, SameSite } from "../refusal.ts";
import { SelectedProviderUnavailable } from "./providers.ts";

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

/** One subagent and its saved conversation. */
export const SubagentTranscript = Schema.Struct({
  subagent: SubagentView,
  messages: Schema.Array(StoredMessage),
});
export type SubagentTranscript = typeof SubagentTranscript.Type;

/** A page claims (or renews) the right to change the session, or gives it up. */
export const LeaseRequest = Schema.Struct({
  holder: Schema.NonEmptyString,
  action: Schema.Literals(["claim", "release"]),
});
export type LeaseRequest = typeof LeaseRequest.Type;

/**
 * What the page asks of one conversation: archive or restore it, delete it, or move or pause its
 * workflow. A retried change with the same `idempotencyKey` answers the first one's operation.
 */
export const SessionChange = Schema.TaggedUnion({
  Archive: { archived: Schema.Boolean, idempotencyKey: Schema.optional(Schema.String) },
  Delete: { idempotencyKey: Schema.String },
  Phase: { phase: WorkflowPhase },
  Control: { workflowAction: WorkflowAction },
});
export type SessionChange = typeof SessionChange.Type;

/** How many approvals were discarded. */
export const InterruptsDiscarded = Schema.Struct({ discarded: Schema.Finite });

/** The user continues past the runs left unknown; none of them is replayed. */
export const UncertainAcknowledged = Schema.TaggedStruct("acknowledged", {});

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

/** An empty message, or one with an attachment the server does not have. */
const InvalidQueuedMessage = appRefusal(400, ["empty_message", "unknown_attachment"]);

/** Nothing is answering: the page sends the message as a normal turn instead. */
const NotRunning = appRefusal(409, ["not_running"]);

/** The queued message is gone, delivered or being delivered, or not held when confirmed. */
const QueueChangeRefused = appRefusal(409, [
  "queue_not_found",
  "queue_delivered",
  "queue_not_held",
  "queue_reserved",
]);

/** The session is answering; the change waits until it ends. */
const RunInProgress = appRefusal(409, ["run_in_progress"]);

/** Nothing in the session is running to cancel. */
const NoRunningRun = appRefusal(409, ["no_running_run"]);

/** The runs left unknown changed since the page showed them. */
const UncertainRunsChanged = appRefusal(409, ["uncertain_runs_changed"]);

/**
 * The workflow cannot move or pause that way now; the code is the reason. A `session_in_use` or
 * `run_in_progress` reason is answered as `SessionInUse` or `RunInProgress`.
 */
const WorkflowChangeRefused = appRefusal(409, [
  "goal_missing",
  "goal_not_active",
  "goal_not_paused",
  "goal_terminal",
  "plan_not_ready",
  "plan_outdated",
  "plan_missing",
  "unknown_step",
  "step_evidence_required",
  "verification_required",
  "steps_incomplete",
  "phase_not_executable",
  "goal_completion_required",
  "completion_evidence_required",
  "completion_evidence_invalid",
  "completion_snapshot_conflict",
]);

/** The archive, restore or delete cannot start; `blocker` says why. */
const LifecycleBlocked = LifecycleResult.cases.blocked.pipe(HttpApiSchema.status(409));

/** The session has no such subagent. */
const UnknownSubagent = appRefusal(404, ["subagent_not_found"]);

/** The approval is unknown, another session's, timed out, or answered the other way. */
const ApprovalNotPending = appRefusal(404, ["approval_not_pending"]);

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
  InvalidQueuedMessage,
  NotRunning,
  QueueChangeRefused,
  RunInProgress,
  NoRunningRun,
  UncertainRunsChanged,
  WorkflowChangeRefused,
  UnknownSubagent,
  ApprovalNotPending,
  SessionStorageFailed,
];

const session = { session: Schema.String };

/** A project's conversations and what each one runs (`/api/sessions/*`). */
export class SessionsGroup extends HttpApiGroup.make("sessions")
  .add(
    /**
     * Run state the transcript does not carry: whether a run is still producing, how the last one
     * ended, and whether the asking page (`holder`) holds the session.
     */
    HttpApiEndpoint.get("status", "/api/sessions/:session", {
      params: session,
      query: { holder: Schema.optional(Schema.String) },
      success: SessionRunState,
      error: [UnknownSession, SelectedProviderUnavailable],
    }),
    /**
     * Archives, restores or deletes the conversation, or moves or pauses its workflow. An archive
     * or restore answers the session; a delete its operation. Either one still waiting for a live
     * attempt to stop, or blocked on the way, is answered 202; one that cannot start, 409.
     */
    HttpApiEndpoint.post("change", "/api/sessions/:session", {
      params: session,
      headers: sessionHolderHeaders,
      payload: SessionChange,
      success: [
        Session,
        WorkflowState,
        LifecycleResult.cases.completed,
        LifecycleResult.cases.waiting_for_stop.pipe(HttpApiSchema.status(202)),
        LifecycleResult.cases.blocked.pipe(HttpApiSchema.status(202)),
      ],
      error: [SessionInUse, UnknownSession, RunInProgress, WorkflowChangeRefused, LifecycleBlocked],
    }),
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
    /** Messages waiting to reach the agent, and those the latest run delivered. */
    HttpApiEndpoint.get("queue", "/api/sessions/:session/queue", {
      params: session,
      success: QueueSnapshot,
      error: UnknownSession,
    }),
    /**
     * A message written while a run answers: `queue` goes at the next tool-call boundary, or as
     * the next turn the page sends; `steer` also cuts the answer being written and the server
     * sends it next. `not_running` means the page sends a normal turn instead.
     */
    HttpApiEndpoint.post("enqueue", "/api/sessions/:session/queue", {
      params: session,
      headers: sessionHolderHeaders,
      payload: QueueRequest,
      success: QueuedMessage.pipe(HttpApiSchema.status(201)),
      error: [UnknownSession, SessionInUse, InvalidQueuedMessage, NotRunning],
    }),
    /** Edits, saves, removes or confirms one queued message; a removed one answers null. */
    HttpApiEndpoint.post("editQueued", "/api/sessions/:session/queue/:message", {
      params: { ...session, message: Schema.String },
      headers: sessionHolderHeaders,
      payload: QueueEditRequest,
      success: Schema.NullOr(QueuedMessage),
      error: [SessionInUse, QueueChangeRefused],
    }),
    /** The session's subagents. */
    HttpApiEndpoint.get("subagents", "/api/sessions/:session/subagents", {
      params: session,
      success: Schema.Array(SubagentView),
      error: UnknownSession,
    }),
    /** One subagent's saved conversation. */
    HttpApiEndpoint.get("subagentTranscript", "/api/sessions/:session/subagents/:subagent", {
      params: { ...session, subagent: Schema.String },
      success: SubagentTranscript,
      error: UnknownSubagent,
    }),
    /**
     * Calls waiting for the user that could not pause the run: a subagent's, or an external
     * agent's own permission requests.
     */
    HttpApiEndpoint.get("approvals", "/api/sessions/:session/approvals", {
      params: session,
      success: Schema.Array(RelayedApprovalView),
      error: UnknownSession,
    }),
    /** Answers a waiting call; the calls still waiting come back. */
    HttpApiEndpoint.post("answerApproval", "/api/sessions/:session/approvals/:approval", {
      params: { ...session, approval: Schema.String },
      headers: sessionHolderHeaders,
      payload: Schema.Struct({ approved: Schema.Boolean }),
      success: Schema.Array(RelayedApprovalView),
      error: [SessionInUse, ApprovalNotPending],
    }),
    /**
     * Stops the session's running run and its subagents. Closing or reloading the page never does;
     * this is the only way to end a run early. `stopped` is false when it had not ended in time.
     */
    HttpApiEndpoint.post("cancel", "/api/sessions/:session/cancel", {
      params: session,
      headers: sessionHolderHeaders,
      success: CancelResult,
      error: [SessionInUse, NoRunningRun],
    }),
    /**
     * `/compact`: the model is no longer sent the tool output it has already answered from; each
     * cleared output keeps a pointer to its memory node.
     */
    HttpApiEndpoint.post("compact", "/api/sessions/:session/compact", {
      params: session,
      headers: sessionHolderHeaders,
      success: CompactResult,
      error: [SessionInUse, UnknownSession, RunInProgress, SelectedProviderUnavailable],
    }),
    /** Abandons approvals whose continuation was lost; the gated tools never run. */
    HttpApiEndpoint.post("discardInterrupts", "/api/sessions/:session/interrupts/discard", {
      params: session,
      headers: sessionHolderHeaders,
      success: InterruptsDiscarded,
      error: [SessionInUse, UnknownSession, RunInProgress],
    }),
    /**
     * The user saw the Goal runs whose tools left their outcome unknown and continues without
     * replaying them. Refused while something runs, or when the listed runs changed.
     */
    HttpApiEndpoint.post("continuePastUncertain", "/api/sessions/:session/uncertain", {
      params: session,
      headers: sessionHolderHeaders,
      payload: UncertainContinueRequest,
      success: UncertainAcknowledged,
      error: [UnknownSession, SessionInUse, RunInProgress, UncertainRunsChanged],
    }),
    /**
     * A page claims (or renews) the session, or gives it up, also as a beacon when it closes. The
     * answer says who holds the session from that page's point of view.
     */
    HttpApiEndpoint.post("lease", "/api/sessions/:session/lease", {
      params: session,
      payload: LeaseRequest,
      success: LeaseView,
      error: UnknownSession,
    }),
  )
  .middleware(SameSite) {}
