import type { Cause, Schema } from "effect";
import { Effect } from "effect";
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
export const kanbanFailureResponse = (failure: KanbanRouteFailure): Response => {
  switch (failure._tag) {
    case "SessionNotFound":
      return reply(404, "session_not_found");
    case "ProjectNotFound":
      return reply(404, "project_not_found");
    case "KanbanActionRefused":
    case "BoardEditRefused":
    case "KanbanStartRefused":
      return reply(409, failure.reason);
    case "GoalScheduleRefused":
      switch (failure.reason) {
        case "invalid_branch":
          return reply(400, "invalid_kanban_settings");
        case "goal_missing":
        case "self_dependency":
        case "other_project":
        case "dependency_cycle":
          return reply(409, failure.reason);
      }
    case "HumanDecisionRefused":
      switch (failure.reason) {
        case "request_missing":
        case "request_mismatch":
          return reply(404, failure.reason);
        case "answer_invalid":
          return reply(400, failure.reason);
        case "card_missing":
        case "goal_superseded":
        case "request_closed":
        case "answer_conflict":
          return reply(409, failure.reason);
      }
    case "PlanDependenciesRejected":
      return Response.json(
        { error: "plan_dependencies_rejected", issues: failure.issues },
        { status: 422 },
      );
    case "PersistedQueueItemsFailed":
      switch (failure.reason._tag) {
        // The dead letter was requeued or settled meanwhile.
        case "NotFound":
        case "NotDeadLettered":
          return reply(409, "queue_item_changed");
        case "StorageFailed":
          return reply(500, "kanban_storage_failed");
      }
    case "CardWorktreeFailed":
      switch (failure.reason._tag) {
        case "InUse":
          return reply(409, "worktree_in_use");
        default:
          return reply(500, "worktree_failed");
      }
    case "KanbanStorageFailed":
      return reply(500, "kanban_storage_failed");
    case "WorkflowStorageError":
      return reply(500, "workflow_storage_failed");
    case "GoalScheduleStorageFailed":
      return reply(500, "schedule_storage_failed");
    case "GlobalConfigFailed":
      return reply(500, "settings_failed");
    case "KanbanSettingsRefused":
      return reply(400, "invalid_kanban_settings");
    case "SqlError":
    case "SchemaError":
      return reply(500, "storage_failed");
    case "PlatformError":
      return reply(500, "platform_failed");
    case "UnknownError":
      return reply(400, "invalid_json");
  }
};

/** Answers each expected failure of a kanban route; a failure outside the table fails to type. */
export const answerKanbanFailures = <A, E extends KanbanRouteFailure, R>(
  effect: Effect.Effect<A, E, R>,
) => Effect.catch(effect, (failure) => Effect.succeed(kanbanFailureResponse(failure)));
