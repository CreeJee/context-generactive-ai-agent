import { Effect, Schema } from "effect";
import { BoardAuthor, CardRisk, CardStatus, cardContractFields, cardHoldFields } from "./card.ts";

/**
 * Workflow state, Plans and boards as the page reads and changes them. This module imports no
 * server code, so the browser bundle can use it; `workflow.ts`, `completion-evidence.ts`,
 * `board-edit.ts` and `board.ts` keep them.
 */

export const PlanStatus = Schema.Literals([
  "draft",
  "ready",
  "executing",
  "completed",
  "blocked",
  "closed",
]);
export type PlanStatus = typeof PlanStatus.Type;

/** A Plan without its steps, as boards show it. */
export const PlanSummary = Schema.Struct({
  version: Schema.Int,
  status: PlanStatus,
  summary: Schema.String,
});
export type PlanSummary = typeof PlanSummary.Type;

/** `GET /api/projects/:project/boards`: one conversation's Plan as a board, without its cards. */
export const ProjectBoard = Schema.Struct({
  sessionId: Schema.String,
  sessionTitle: Schema.NullOr(Schema.String),
  plan: PlanSummary,
  /** Cards in each column. */
  counts: Schema.Record(CardStatus, Schema.Finite),
  /** Whether the session's current Goal runs as an active kanban board. */
  kanbanActive: Schema.Boolean,
  /** When the Plan was last saved. */
  updatedAt: Schema.String,
  /** The conversation's place among the project's Goals in the priority tree, from 0. */
  rank: Schema.Finite,
});
export type ProjectBoard = typeof ProjectBoard.Type;

/** Only the current Plan version is supported; historical Plan mappings are not adopted. */
export const CriterionMapping = Schema.Struct({
  outcomeIndex: Schema.Int,
  outcomeText: Schema.String,
  stepId: Schema.String,
  acceptanceIndex: Schema.Int,
  acceptanceText: Schema.String,
  runId: Schema.String,
  evidenceNodeIds: Schema.Array(Schema.String),
});
const RunProvenance = Schema.Struct({
  runId: Schema.String,
  workflowRevisionId: Schema.Int,
  dispatchGeneration: Schema.NullOr(Schema.String),
  // Additive for 0.0.13 snapshots; source-bound runs always populate it.
  durableExecutionId: Schema.optionalKey(Schema.String),
});
export const CompletionSnapshot = Schema.Struct({
  sessionId: Schema.String,
  projectId: Schema.String,
  goalInstanceId: Schema.String,
  goalVersion: Schema.Int,
  planVersion: Schema.Int,
  recorderRunId: Schema.String,
  recorderRevisionId: Schema.Int,
  sourceGeneration: Schema.NullOr(Schema.String),
  manifestHash: Schema.NullOr(Schema.String),
  nativeRegistration: Schema.NullOr(
    Schema.Struct({
      artifactHash: Schema.String,
      sourceHash: Schema.String,
      contractVersion: Schema.String,
    }),
  ),
  mappings: Schema.Array(CriterionMapping),
  runs: Schema.Array(RunProvenance),
});
export type CompletionSnapshot = typeof CompletionSnapshot.Type;
export type CriterionMapping = typeof CriterionMapping.Type;

/** A proposal is never completion evidence; the owner validates it after durable settlement. */
export const CompletionRequest = Schema.Struct({
  recorderRunId: Schema.String,
  goalVersion: Schema.Int,
  planVersion: Schema.Int,
  mappings: Schema.Array(CriterionMapping),
});

export const WorkflowPhase = Schema.Literals([
  "chat",
  "goal",
  "plan",
  "execute",
  "verify",
  "completed",
]);
export type WorkflowPhase = typeof WorkflowPhase.Type;

export const WorkflowAction = Schema.Literals(["pause", "resume", "stop"]);
export type WorkflowAction = typeof WorkflowAction.Type;

export const GoalQuestion = Schema.Struct({
  id: Schema.String,
  question: Schema.String,
  blocking: Schema.Boolean,
});

export const VerificationStatus = Schema.Literals([
  "not_run",
  "passed",
  "failed",
  "invalid_hypothesis",
  "invalid_criterion",
  "inconclusive",
  "blocked",
]);
export type VerificationStatus = typeof VerificationStatus.Type;

const Verification = Schema.Struct({
  status: VerificationStatus,
  summary: Schema.String,
  evidence: Schema.Array(Schema.String),
  recoveryPhase: Schema.NullOr(Schema.Literals(["goal", "plan"])).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed(null)),
  ),
  updatedAt: Schema.NullOr(Schema.String),
});
export type Verification = typeof Verification.Type;

export const verificationDefault: Verification = {
  status: "not_run",
  summary: "",
  evidence: [],
  recoveryPhase: null,
  updatedAt: null,
};

const goalFields = {
  completion: Schema.optionalKey(CompletionSnapshot),
  completionRequest: Schema.optionalKey(CompletionRequest),
  version: Schema.Int,
  statement: Schema.String,
  outcomes: Schema.Array(Schema.String),
  constraints: Schema.Array(Schema.String),
  nonGoals: Schema.Array(Schema.String),
  assumptions: Schema.Array(Schema.String),
  openQuestions: Schema.Array(GoalQuestion),
  evidence: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed([]))),
  verification: Verification.pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed(verificationDefault)),
  ),
  updatedAt: Schema.String,
} as const;

export const GoalArtifact = Schema.Struct({
  ...goalFields,
  status: Schema.Literals(["draft", "active", "paused", "completed", "failed"]),
});
export type GoalArtifact = typeof GoalArtifact.Type;

export const planStepFields = {
  id: Schema.String,
  title: Schema.String,
  description: Schema.String,
  dependsOn: Schema.Array(Schema.String),
  acceptanceCriteria: Schema.Array(Schema.String),
  ruleRefs: Schema.Array(Schema.String),
} as const;

const recordedEvidence = Schema.Array(Schema.String).pipe(
  Schema.withDecodingDefaultTypeKey(Effect.succeed([])),
);

export const PlanStep = Schema.Struct({
  ...planStepFields,
  ...cardContractFields,
  ...cardHoldFields,
  status: CardStatus,
  evidence: recordedEvidence,
});
export type PlanStep = typeof PlanStep.Type;

const planFields = {
  version: Schema.Int,
  goalVersion: Schema.Int,
  summary: Schema.String,
  steps: Schema.Array(PlanStep),
  risks: Schema.Array(Schema.String),
  openQuestions: Schema.Array(Schema.String),
  evidence: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed([]))),
  verification: Verification.pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed(verificationDefault)),
  ),
  updatedAt: Schema.String,
} as const;

export const PlanArtifact = Schema.Struct({
  ...planFields,
  status: PlanStatus,
});
export type PlanArtifact = typeof PlanArtifact.Type;

export const LedgerEvent = Schema.Struct({
  sequence: Schema.Int,
  at: Schema.String,
  kind: Schema.Literals([
    "phase_changed",
    "goal_updated",
    "plan_updated",
    "plan_replanned",
    "progress_updated",
    "goal_paused",
    "goal_resumed",
    "workflow_stopped",
    "verification_recorded",
    "verification_invalidated",
    "board_updated",
    "plan_closed",
  ]),
  detail: Schema.String,
});

export const WorkflowState = Schema.Struct({
  phase: WorkflowPhase,
  goal: Schema.NullOr(GoalArtifact),
  plan: Schema.NullOr(PlanArtifact),
  ledger: Schema.Array(LedgerEvent),
});
export type WorkflowState = typeof WorkflowState.Type;

const CardText = Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isMinLength(1)));

/** A card the user adds; the owner gives it its id and status. */
export const CardDraft = Schema.Struct({
  title: CardText,
  description: Schema.String,
  dependsOn: Schema.Array(Schema.String),
  acceptanceCriteria: Schema.Array(Schema.String),
  outcome: Schema.optionalKey(Schema.String),
  boundaries: Schema.optionalKey(Schema.Array(Schema.String)),
  risk: Schema.optionalKey(CardRisk),
  requiredEvidence: Schema.optionalKey(Schema.Array(Schema.String)),
  humanDecision: Schema.optionalKey(Schema.String),
  // A tool that takes several cards states the shape once, as a JSON Schema definition.
}).annotate({ identifier: "CardDraft" });
export type CardDraft = typeof CardDraft.Type;

/** Fields the user changes on a card. An absent key keeps the value; null clears a contract field. */
export const CardPatch = Schema.Struct({
  title: Schema.optionalKey(CardText),
  description: Schema.optionalKey(Schema.String),
  dependsOn: Schema.optionalKey(Schema.Array(Schema.String)),
  acceptanceCriteria: Schema.optionalKey(Schema.Array(Schema.String)),
  outcome: Schema.optionalKey(Schema.NullOr(Schema.String)),
  boundaries: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  risk: Schema.optionalKey(Schema.NullOr(CardRisk)),
  requiredEvidence: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  humanDecision: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type CardPatch = typeof CardPatch.Type;

const Index = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));

/** A user's board change. `planVersion` is the Plan the user saw; a newer one refuses it. */
export const BoardEdit = Schema.TaggedUnion({
  AddCard: {
    planVersion: Schema.Int,
    card: CardDraft,
    index: Schema.optionalKey(Index),
  },
  EditCard: {
    planVersion: Schema.Int,
    cardId: Schema.String,
    patch: CardPatch,
  },
  MoveCard: { planVersion: Schema.Int, cardId: Schema.String, index: Index },
  CancelCard: { planVersion: Schema.Int, cardId: Schema.String },
  /** Ends the Plan without completing it, for work that settled elsewhere or is no longer wanted. */
  ClosePlan: { planVersion: Schema.Int },
});
export type BoardEdit = typeof BoardEdit.Type;

/** What a user asked of an executing card; the orchestrator settles it. */
export const UserChange = Schema.TaggedUnion({
  Edit: { patch: CardPatch },
  Cancel: {},
});
export type UserChange = typeof UserChange.Type;

export const UserChangeRequestStatus = Schema.Literals([
  "pending",
  "applied",
  "reassigned",
  "rejected",
]);

export const UserChangeRequest = Schema.Struct({
  id: Schema.Int,
  cardId: Schema.String,
  planVersion: Schema.Int,
  change: UserChange,
  status: UserChangeRequestStatus,
  reason: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
export type UserChangeRequest = typeof UserChangeRequest.Type;

/**
 * What a person means by dragging a card on the board. The board turns a drop into one of these;
 * the owner decides the card's status from it.
 */
export const BoardIntent = Schema.TaggedUnion({
  /** Same column: the card takes the place of `at`, which ranks it in its Goal's queue. */
  Reorder: { cardId: Schema.String, at: Schema.String },
  /** A blocked card goes back on the queue with a fresh attempt record. */
  Requeue: { cardId: Schema.String },
  Hold: { cardId: Schema.String },
  Release: { cardId: Schema.String },
  /** A change to an executing card, which the orchestrator settles. */
  ChangeRequest: { cardId: Schema.String, patch: CardPatch },
  Cancel: { cardId: Schema.String },
  /**
   * The card leaves this Plan for another conversation's Plan of the same project, placed before
   * `at` there (or last). It keeps its contract, loses its dependencies and starts over there.
   */
  Transfer: { cardId: Schema.String, toSessionId: Schema.String, at: Schema.NullOr(Schema.String) },
});
export type BoardIntent = typeof BoardIntent.Type;

/** A card with the author of the latest revision that changed it, when one is recorded. */
export const BoardCard = Schema.Struct({
  card: PlanStep,
  lastChange: Schema.NullOr(
    Schema.Struct({ author: Schema.NullOr(BoardAuthor), at: Schema.String }),
  ),
});
export type BoardCard = typeof BoardCard.Type;

/** One saved revision that changed cards, newest first in the view. */
export const BoardRevision = Schema.Struct({
  revisionId: Schema.Int,
  at: Schema.String,
  /** Null for revisions saved before authors were recorded, or by phase and lifecycle saves. */
  author: Schema.NullOr(BoardAuthor),
  detail: Schema.String,
  cardIds: Schema.Array(Schema.String),
});
export type BoardRevision = typeof BoardRevision.Type;

/** `GET /api/sessions/:session/board`: the Plan as a board and how it got there. */
export const BoardView = Schema.Struct({
  plan: Schema.NullOr(PlanSummary),
  cards: Schema.Array(BoardCard),
  history: Schema.Array(BoardRevision),
  pendingChanges: Schema.Array(UserChangeRequest),
});
export type BoardView = typeof BoardView.Type;

/** A board change saved: the workflow state after it. */
export const BoardEditApplied = Schema.TaggedStruct("Applied", { state: WorkflowState });

/** A change to an executing card, stored as a request the orchestrator settles. */
export const BoardEditRequested = Schema.TaggedStruct("Requested", { request: UserChangeRequest });

/** Answer to a board change: the saved state, or the request stored for an executing card. */
export type BoardEditResultCases = typeof BoardEditApplied.Type | typeof BoardEditRequested.Type;

const blockerFields = {
  detail: Schema.NonEmptyString,
  evidence: Schema.Array(Schema.NonEmptyString).pipe(Schema.check(Schema.isMinLength(1))),
};

/** Blockers the model may record; dependency stalls are decided only by the server. */
export const WorkflowBlocker = Schema.Struct({
  reason: Schema.Literals([
    "user_decision",
    "permission",
    "external_dependency",
    "repeated_failure",
  ]),
  ...blockerFields,
});
export type WorkflowBlocker = typeof WorkflowBlocker.Type;

const Progress = Schema.Struct({
  completedSteps: Schema.Array(Schema.String),
  evidence: Schema.Array(Schema.String),
  toolResults: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed([])),
  ),
});
const executionFields = {
  runId: Schema.String,
  goalVersion: Schema.Int,
  planVersion: Schema.Int,
  noProgressRuns: Schema.Int,
  progress: Progress,
};

export const WorkflowExecutionState = Schema.TaggedUnion({
  idle: {},
  running: executionFields,
  ready: executionFields,
  /**
   * A run cut off by a server restart before it ran any tool. A new run continues the Plan at
   * `retryAt`: the time of the provider retry it was waiting for, or the restart itself.
   */
  retrying: { ...executionFields, retryAt: Schema.Finite },
  blocked: {
    runId: Schema.String,
    reason: Schema.Literals([
      ...WorkflowBlocker.fields.reason.literals,
      "dependency_stalled",
      "server_restarted",
    ]),
    ...blockerFields,
  },
  stopped: {
    /** `state_reconciled`: the startup check repaired a Goal no transition makes, or one not running. */
    reason: Schema.Literals([
      "user",
      "run_failed",
      "workflow_changed",
      "completed",
      "state_reconciled",
    ]),
  },
});
export type WorkflowExecutionState = typeof WorkflowExecutionState.Type;

/** A note the page shows beside the workflow state; see `Workflows.display`. */
export const WorkflowDisplay = Schema.Literal("card_reclassifying");
export type WorkflowDisplay = typeof WorkflowDisplay.Type;

export const WorkflowActionReason = Schema.Literals([
  "session_in_use",
  "run_in_progress",
  "goal_missing",
  "goal_not_active",
  "goal_not_paused",
  "goal_terminal",
  "plan_not_ready",
  "plan_outdated",
]);
export type WorkflowActionReason = typeof WorkflowActionReason.Type;

export const WorkflowActionDecision = Schema.Union([
  Schema.Struct({
    allowed: Schema.Literal(true),
    intent: Schema.optionalKey(Schema.Literals(["start", "continue"])),
  }),
  Schema.Struct({ allowed: Schema.Literal(false), reason: WorkflowActionReason }),
]);
export type WorkflowActionDecision = typeof WorkflowActionDecision.Type;

/** What the page may ask of the workflow now: each phase and each control, allowed or why not. */
export const WorkflowActions = Schema.Struct({
  phases: Schema.Record(WorkflowPhase, WorkflowActionDecision),
  controls: Schema.Record(WorkflowAction, WorkflowActionDecision),
});
export type WorkflowActions = typeof WorkflowActions.Type;

/** A wait still pending before resending a provider request, for the session's run state. */
export const ProviderRetryView = Schema.Struct({
  runId: Schema.String,
  retry: Schema.Finite,
  retryAt: Schema.Finite,
});
export type ProviderRetryView = typeof ProviderRetryView.Type;

/**
 * How a tool of an ended run left its outcome unknown: its owner operation never settled
 * (`pending`, `uncertain`, `rejected`), or it succeeded but its result never reached the history a
 * later run reads (`unrecorded`).
 */
export const UncertainToolState = Schema.Literals([
  "pending",
  "uncertain",
  "rejected",
  "unrecorded",
]);
export type UncertainToolState = typeof UncertainToolState.Type;

export const UncertainTool = Schema.Struct({
  toolCallId: Schema.NullOr(Schema.String),
  name: Schema.NullOr(Schema.String),
  /** The recorded call with secrets hidden; null when the run stopped before recording it. */
  call: Schema.NullOr(Schema.String),
  state: UncertainToolState,
});
export type UncertainTool = typeof UncertainTool.Type;

/** A bound Goal run that keeps later runs from starting until the user decides about it. */
export const UncertainRun = Schema.Struct({
  runId: Schema.String,
  tools: Schema.Array(UncertainTool),
});
export type UncertainRun = typeof UncertainRun.Type;

/** The runs the user saw listed, all of which the continue covers. */
export const UncertainContinueRequest = Schema.Struct({ runIds: Schema.Array(Schema.String) });
export type UncertainContinueRequest = typeof UncertainContinueRequest.Type;
