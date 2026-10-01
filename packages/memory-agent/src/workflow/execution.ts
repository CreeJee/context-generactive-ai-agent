import { Context, Effect, Layer, Schema } from "effect";
import { Database } from "../db/database.ts";
import type { WorkflowState } from "./workflow.ts";

export const WorkflowBlocker = Schema.Struct({
  reason: Schema.Literals([
    "user_decision",
    "permission",
    "external_dependency",
    "repeated_failure",
  ]),
  detail: Schema.NonEmptyString,
  evidence: Schema.Array(Schema.NonEmptyString).pipe(Schema.check(Schema.isMinLength(1))),
});
export type WorkflowBlocker = typeof WorkflowBlocker.Type;

const Progress = Schema.Struct({
  completedSteps: Schema.Array(Schema.String),
  evidence: Schema.Array(Schema.String),
});
const executionFields = {
  runId: Schema.String,
  goalVersion: Schema.Int,
  planVersion: Schema.Int,
  noProgressRuns: Schema.Int,
  progress: Progress,
};

export const WorkflowExecutionState = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("idle") }),
  Schema.Struct({ kind: Schema.Literal("running"), ...executionFields }),
  Schema.Struct({ kind: Schema.Literal("ready"), ...executionFields }),
  Schema.Struct({
    kind: Schema.Literal("blocked"),
    runId: Schema.String,
    ...WorkflowBlocker.fields,
  }),
  Schema.Struct({
    kind: Schema.Literal("stopped"),
    reason: Schema.Literals(["user", "run_failed", "workflow_changed", "completed"]),
  }),
]);
export type WorkflowExecutionState = typeof WorkflowExecutionState.Type;

export class WorkflowExecutionFailed extends Schema.TaggedError<WorkflowExecutionFailed>()(
  "WorkflowExecutionFailed",
  {
    operation: Schema.Literals(["read", "write"]),
    cause: Schema.Defect(),
  },
) {}

const storage = <A>(operation: "read" | "write", evaluate: () => A) =>
  Effect.try({
    try: evaluate,
    catch: (cause) => new WorkflowExecutionFailed({ operation, cause }),
  });

const namespace = "memory-agent/workflow-execution";
const encode = Schema.encodeSync(Schema.fromJsonString(WorkflowExecutionState));
const decode = Schema.decodeUnknownSync(
  Schema.Struct({ value: Schema.fromJsonString(WorkflowExecutionState) }),
);
const progressOf = (state: WorkflowState): typeof Progress.Type => ({
  completedSteps:
    state.plan?.steps.filter((step) => step.status === "completed").map((step) => step.id) ?? [],
  evidence: [
    ...new Set([
      ...(state.goal?.evidence ?? []),
      ...(state.plan?.evidence ?? []),
      ...(state.plan?.steps.flatMap((step) => step.evidence) ?? []),
      ...(state.plan?.verification.evidence ?? []),
    ]),
  ],
});

const executable = (state: WorkflowState) =>
  (state.phase === "execute" || state.phase === "verify") &&
  state.goal?.status === "active" &&
  state.plan?.status === "executing" &&
  state.plan.goalVersion === state.goal.version;

const make = Effect.gen(function* () {
  const { sqlite } = yield* Database;
  const select = sqlite.prepare("SELECT value FROM chat_metadata WHERE namespace = ? AND key = ?");
  const upsert = sqlite.prepare(`INSERT INTO chat_metadata (namespace, key, value) VALUES (?, ?, ?)
    ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value`);
  const read = (sessionId: string): WorkflowExecutionState => {
    const row = select.get(namespace, sessionId);
    return row ? decode(row).value : { kind: "idle" };
  };
  const save = (sessionId: string, state: WorkflowExecutionState) => {
    upsert.run(namespace, sessionId, encode(state));
    return state;
  };

  return {
    get: Effect.fn("WorkflowExecution.get")((sessionId: string) =>
      storage("read", () => read(sessionId)),
    ),
    readySessions: Effect.fn("WorkflowExecution.readySessions")(() =>
      storage("read", () =>
        sqlite
          .prepare(
            "SELECT key FROM chat_metadata WHERE namespace = ? AND json_extract(value, '$.kind') = 'ready'",
          )
          .all(namespace)
          .map((row) => Schema.decodeUnknownSync(Schema.Struct({ key: Schema.String }))(row).key),
      ),
    ),

    canContinue: Effect.fn("WorkflowExecution.canContinue")(
      (sessionId: string, runId: string, state: WorkflowState) =>
        storage("read", () => {
          const execution = read(sessionId);
          return (
            execution.kind === "ready" &&
            execution.runId === runId &&
            executable(state) &&
            execution.goalVersion === state.goal?.version &&
            execution.planVersion === state.plan?.version &&
            !state.plan.steps.some((step) => step.status === "blocked")
          );
        }),
    ),

    start: Effect.fn("WorkflowExecution.start")(
      (sessionId: string, runId: string, state: WorkflowState, userTurn: boolean) =>
        storage("write", () => {
          if (!executable(state) || state.goal === null || state.plan === null) return;
          const previous = read(sessionId);
          if (previous.kind === "running" && previous.runId === runId) return;
          save(sessionId, {
            kind: "running",
            runId,
            goalVersion: state.goal.version,
            planVersion: state.plan.version,
            noProgressRuns: !userTurn && previous.kind === "ready" ? previous.noProgressRuns : 0,
            progress: progressOf(state),
          });
        }),
    ),

    finish: Effect.fn("WorkflowExecution.finish")(
      (sessionId: string, runId: string, state: WorkflowState) =>
        storage("write", () => {
          const previous = read(sessionId);
          if (previous.kind !== "running" || previous.runId !== runId) return;
          if (
            !executable(state) ||
            state.goal?.version !== previous.goalVersion ||
            state.plan?.version !== previous.planVersion
          ) {
            save(sessionId, {
              kind: "stopped",
              reason: state.goal?.status === "completed" ? "completed" : "workflow_changed",
            });
            return;
          }
          const progress = progressOf(state);
          const advanced =
            progress.completedSteps.some((id) => !previous.progress.completedSteps.includes(id)) ||
            progress.evidence.some((item) => !previous.progress.evidence.includes(item));
          const noProgressRuns = advanced ? 0 : previous.noProgressRuns + 1;
          save(
            sessionId,
            noProgressRuns >= 2
              ? {
                  kind: "blocked",
                  runId,
                  reason: "repeated_failure",
                  detail: "두 턴 연속 완료된 단계나 새로운 진행 근거가 없어 자동 진행을 멈췄어요.",
                  evidence: [
                    previous.runId,
                    "Two consecutive runs without new workflow evidence or completed steps",
                  ],
                }
              : { ...previous, kind: "ready", progress, noProgressRuns },
          );
        }),
    ),

    block: Effect.fn("WorkflowExecution.block")(
      (sessionId: string, runId: string, blocker: WorkflowBlocker) =>
        storage("write", () => {
          const current = read(sessionId);
          if (current.kind !== "running" || current.runId !== runId)
            return { error: "execution_not_running" as const };
          return save(sessionId, { kind: "blocked", runId, ...blocker });
        }),
    ),

    blockPending: Effect.fn("WorkflowExecution.blockPending")(
      (sessionId: string, runId: string, blocker: WorkflowBlocker) =>
        storage("write", () => {
          const current = read(sessionId);
          if (current.kind !== "ready" || current.runId !== runId) return;
          save(sessionId, { kind: "blocked", runId, ...blocker });
        }),
    ),

    stop: Effect.fn("WorkflowExecution.stop")(
      (sessionId: string, reason: "user" | "run_failed" = "user", runId?: string) =>
        storage("write", () => {
          const current = read(sessionId);
          if (runId !== undefined && (current.kind !== "running" || current.runId !== runId))
            return;
          save(sessionId, { kind: "stopped", reason });
        }),
    ),
  };
});

/** Durable continuation intent; model text ending a turn does not complete a Plan. */
export class WorkflowExecution extends Context.Service<
  WorkflowExecution,
  Effect.Success<typeof make>
>()("memory-agent/WorkflowExecution") {
  static readonly layer = Layer.effect(WorkflowExecution, make);
}
