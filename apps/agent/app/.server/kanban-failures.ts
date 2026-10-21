import type { Cause, Schema } from "effect";
import { Effect, Match, Predicate } from "effect";
import type { PlatformError } from "effect/PlatformError";
import type { SqlError } from "effect/sql";
import type {
  BoardEditRefused,
  CardWorktreeFailed,
  GlobalConfigFailed,
  GoalScheduleRefused,
  GoalScheduleStorageFailed,
  HumanDecisionRefused,
  KanbanActionRefused,
  KanbanSettingsRefused,
  KanbanStartRefused,
  KanbanStorageFailed,
  PersistedQueueItemsFailed,
  PlanDependenciesRejected,
  ProjectNotFound,
  SessionNotFound,
  WorkflowStorageError,
} from "memory-agent";

/** Every expected failure a kanban, board, decision or kanban settings route answers. */
export type KanbanRouteFailure =
  | SessionNotFound
  | ProjectNotFound
  | KanbanActionRefused
  | BoardEditRefused
  | KanbanStartRefused
  | GoalScheduleRefused
  | HumanDecisionRefused
  | PlanDependenciesRejected
  | PersistedQueueItemsFailed
  | CardWorktreeFailed
  | KanbanStorageFailed
  | WorkflowStorageError
  | GoalScheduleStorageFailed
  | GlobalConfigFailed
  | KanbanSettingsRefused
  /** Sessions and projects read their rows with these. */
  | SqlError.SqlError
  | Schema.SchemaError
  /** Naming a new card (`Crypto`) failed. */
  | PlatformError
  /** The only promise these routes await is reading the request body. */
  | Cause.UnknownError;

const reply = (status: number, error: string) => Response.json({ error }, { status });

/**
 * The response for an expected kanban failure, chosen by tag and reason: refusals and conflicts are
 * 4xx with their reason, storage and git failures 5xx with a fixed code. The cause (SQL, paths,
 * command output) never leaves the server.
 */
/** The status for each reason a human decision is refused; the reason itself is the error. */
const humanDecisionStatus: Record<HumanDecisionRefused["reason"], number> = {
  request_missing: 404,
  request_mismatch: 404,
  answer_invalid: 400,
  card_missing: 409,
  goal_superseded: 409,
  request_closed: 409,
  answer_conflict: 409,
};

export const kanbanFailureResponse = (failure: KanbanRouteFailure): Response =>
  Match.valueTags(failure, {
    SessionNotFound: () => reply(404, "session_not_found"),
    ProjectNotFound: () => reply(404, "project_not_found"),
    KanbanActionRefused: ({ reason }) => reply(409, reason),
    BoardEditRefused: ({ reason }) => reply(409, reason),
    KanbanStartRefused: ({ reason }) => reply(409, reason),
    GoalScheduleRefused: ({ reason }) =>
      reason === "invalid_branch" ? reply(400, "invalid_kanban_settings") : reply(409, reason),
    HumanDecisionRefused: ({ reason }) => reply(humanDecisionStatus[reason], reason),
    PlanDependenciesRejected: ({ issues }) =>
      Response.json({ error: "plan_dependencies_rejected", issues }, { status: 422 }),
    PersistedQueueItemsFailed: ({ reason }) =>
      Match.valueTags(reason, {
        // The dead letter was requeued or settled meanwhile.
        NotFound: () => reply(409, "queue_item_changed"),
        NotDeadLettered: () => reply(409, "queue_item_changed"),
        StorageFailed: () => reply(500, "kanban_storage_failed"),
      }),
    CardWorktreeFailed: ({ reason }) =>
      Predicate.isTagged(reason, "InUse")
        ? reply(409, "worktree_in_use")
        : reply(500, "worktree_failed"),
    KanbanStorageFailed: () => reply(500, "kanban_storage_failed"),
    WorkflowStorageError: () => reply(500, "workflow_storage_failed"),
    GoalScheduleStorageFailed: () => reply(500, "schedule_storage_failed"),
    GlobalConfigFailed: () => reply(500, "settings_failed"),
    KanbanSettingsRefused: () => reply(400, "invalid_kanban_settings"),
    SqlError: () => reply(500, "storage_failed"),
    SchemaError: () => reply(500, "storage_failed"),
    PlatformError: () => reply(500, "platform_failed"),
    UnknownError: () => reply(400, "invalid_json"),
  });

/** Answers each expected failure of a kanban route; a failure outside the table fails to type. */
export const answerKanbanFailures = <A, E extends KanbanRouteFailure, R>(
  effect: Effect.Effect<A, E, R>,
) => Effect.catch(effect, (failure) => Effect.succeed(kanbanFailureResponse(failure)));
