import { Effect, Match, Predicate } from "effect";
import type {
  BoardEditRefused,
  CardWorktreeFailed,
  GoalScheduleRefused,
  HumanDecisionRefused,
  KanbanActionRefused,
  KanbanStartRefused,
  PersistedQueueItemsFailed,
  PlanDependenciesRejected,
} from "memory-agent";

/**
 * The app API refusal for each expected kanban failure, by tag: refusals and conflicts carry their
 * reason, storage and git failures a fixed code. The cause (SQL, paths, command output) never
 * leaves the server. A handler passes the entries for the tags it can fail with to
 * `Effect.catchTags`.
 */
export const kanbanRefusal = {
  SessionNotFound: () => Effect.fail({ error: "session_not_found" } as const),
  ProjectNotFound: () => Effect.fail({ error: "project_not_found" } as const),
  GoalScheduleRefused: ({ reason }: GoalScheduleRefused) =>
    Effect.fail(
      reason === "invalid_branch"
        ? ({ error: "invalid_kanban_settings" } as const)
        : { error: reason },
    ),
  HumanDecisionRefused: ({ reason }: HumanDecisionRefused) => Effect.fail({ error: reason }),
  KanbanActionRefused: ({ reason }: KanbanActionRefused) => Effect.fail({ error: reason }),
  BoardEditRefused: ({ reason }: BoardEditRefused) => Effect.fail({ error: reason }),
  KanbanStartRefused: ({ reason }: KanbanStartRefused) => Effect.fail({ error: reason }),
  PlanDependenciesRejected: ({ issues }: PlanDependenciesRejected) =>
    Effect.fail({ error: "plan_dependencies_rejected", issues } as const),
  PersistedQueueItemsFailed: ({ reason }: PersistedQueueItemsFailed) =>
    Effect.fail(
      Match.valueTags(reason, {
        // The dead letter was requeued or settled meanwhile.
        NotFound: () => ({ error: "queue_item_changed" }) as const,
        NotDeadLettered: () => ({ error: "queue_item_changed" }) as const,
        StorageFailed: () => ({ error: "kanban_storage_failed" }) as const,
      }),
    ),
  CardWorktreeFailed: ({ reason }: CardWorktreeFailed) =>
    Effect.fail(
      Predicate.isTagged(reason, "InUse")
        ? ({ error: "worktree_in_use" } as const)
        : ({ error: "worktree_failed" } as const),
    ),
  KanbanStorageFailed: () => Effect.fail({ error: "kanban_storage_failed" } as const),
  WorkflowStorageError: () => Effect.fail({ error: "workflow_storage_failed" } as const),
  GoalScheduleStorageFailed: () => Effect.fail({ error: "schedule_storage_failed" } as const),
  SqlError: () => Effect.fail({ error: "storage_failed" } as const),
  SchemaError: () => Effect.fail({ error: "storage_failed" } as const),
  PlatformError: () => Effect.fail({ error: "platform_failed" } as const),
};
