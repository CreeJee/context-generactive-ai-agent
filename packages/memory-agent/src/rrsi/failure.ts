import { Schema } from "effect";

export const CancellationReason = Schema.Literals([
  "user_activity",
  "time_limit",
  "manual_stop",
  "disabled",
  "profile_restored",
  "app_shutdown",
  "activity_check_failed",
]);
export const EvaluationReason = Schema.Literals([
  "gateway_request_failed",
  "gateway_memory_limit",
  "gateway_protocol_mismatch",
  "protocol_invalid",
  "worker_failed",
  "evaluation_container_failed",
  "evaluation_incomplete",
  "usage_unknown",
]);
export class EvaluationFailed extends Schema.TaggedError<EvaluationFailed>()("EvaluationFailed", {
  reason: EvaluationReason,
}) {}
export class ActivityFailed extends Schema.TaggedError<ActivityFailed>()("ActivityFailed", {}) {}

// Persist only known categories. Provider errors and abort reasons may contain credentials or text.
export function experimentFailure(error: Error | null, signal: AbortSignal): string {
  if (signal.aborted)
    return Schema.is(CancellationReason)(signal.reason) ? signal.reason : "experiment_stopped";
  if (error instanceof EvaluationFailed) return error.reason;
  if (error instanceof Error && error.message === "usage_unknown") return "usage_unknown";
  return "evaluation_failed";
}
