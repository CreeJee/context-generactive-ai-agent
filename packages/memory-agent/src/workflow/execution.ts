import { Result, Function as EffectFunction } from "effect";
import { isTruthy } from "../truthy.ts";
import { Array as EffectArray, Clock, Context, Effect, Layer, Schema } from "effect";
import { Database } from "../db/database.ts";
import { planSchedule, stalledEvidence } from "./plan-schedule.ts";
import { endedWithKnownEffectsSql } from "./run-bindings.ts";
import type { WorkflowState } from "./workflow.ts";

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
    Schema.withDecodingDefaultTypeKey(Effect.sync(() => [])),
  ),
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
  /**
   * A run cut off by a server restart before it ran any tool. A new run continues the Plan at
   * `retryAt`: the time of the provider retry it was waiting for, or the restart itself.
   */
  Schema.Struct({ kind: Schema.Literal("retrying"), ...executionFields, retryAt: Schema.Finite }),
  Schema.Struct({
    kind: Schema.Literal("blocked"),
    runId: Schema.String,
    reason: Schema.Literals([
      ...WorkflowBlocker.fields.reason.literals,
      "dependency_stalled",
      "server_restarted",
    ]),
    ...blockerFields,
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
    catch: (cause) => WorkflowExecutionFailed.make({ operation, cause }),
  });

const namespace = "memory-agent/workflow-execution";
// Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
const encode = EffectFunction.flow(
  Schema.encodeResult(Schema.fromJsonString(WorkflowExecutionState)),
  Result.getOrThrow,
);
// Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
const decode = EffectFunction.flow(
  Schema.decodeUnknownResult(
    Schema.Struct({ value: Schema.fromJsonString(WorkflowExecutionState) }),
  ),
  Result.getOrThrow,
);
const progressOf = (
  state: WorkflowState,
  toolResults: readonly string[] = [],
): typeof Progress.Type => ({
  toolResults,
  completedSteps:
    state.plan?.steps.filter((step) => step.status === "completed").map((step) => step.id) ?? [],
  evidence: EffectArray.dedupe([
    ...(state.goal?.evidence ?? []),
    ...(state.plan?.evidence ?? []),
    ...(state.plan?.steps.flatMap((step) => step.evidence) ?? []),
    ...(state.plan?.verification.evidence ?? []),
  ]),
});

const executable = (state: WorkflowState) =>
  (state.phase === "execute" || state.phase === "verify") &&
  state.goal?.status === "active" &&
  state.plan?.status === "executing" &&
  state.plan.goalVersion === state.goal.version;

const make = Effect.gen(function* () {
  const { sqlite } = yield* Database;
  const select = sqlite.prepare("SELECT value FROM chat_metadata WHERE namespace = ? AND key = ?");
  const endedWithKnownEffects = sqlite.prepare(
    `SELECT 1 AS ended FROM chat_runs r WHERE r.run_id = ? AND ${endedWithKnownEffectsSql("r")}`,
  );
  const upsert = sqlite.prepare(`INSERT INTO chat_metadata (namespace, key, value) VALUES (?, ?, ?)
    ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value`);
  const read = (sessionId: string): WorkflowExecutionState => {
    const row = select.get(namespace, sessionId);
    return isTruthy(row) ? decode(row).value : { kind: "idle" };
  };
  const save = (sessionId: string, state: WorkflowExecutionState) => {
    upsert.run(namespace, sessionId, encode(state));
    return state;
  };
  const sessionsIn = (kind: WorkflowExecutionState["kind"]) =>
    sqlite
      .prepare(
        "SELECT key FROM chat_metadata WHERE namespace = ? AND json_extract(value, '$.kind') = ?",
      )
      .all(namespace, kind)
      // Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
      .map(
        (row) =>
          EffectFunction.flow(
            Schema.decodeUnknownResult(Schema.Struct({ key: Schema.String })),
            Result.getOrThrow,
          )(row).key,
      );
  const current = (
    sessionId: string,
    runId: string,
    state: WorkflowState,
    kind: "ready" | "retrying",
  ) => {
    const execution = read(sessionId);
    return (
      execution.kind === kind &&
      execution.runId === runId &&
      executable(state) &&
      execution.goalVersion === state.goal?.version &&
      execution.planVersion === state.plan?.version &&
      planSchedule(state.plan.steps).kind !== "stalled"
    );
  };

  return {
    get: Effect.fn("WorkflowExecution.get")((sessionId: string) =>
      storage("read", () => read(sessionId)),
    ),
    readySessions: Effect.fn("WorkflowExecution.readySessions")(() =>
      storage("read", () => sessionsIn("ready")),
    ),

    /** Sessions whose restarted run continues at its `retryAt`, with that run. */
    retryingSessions: Effect.fn("WorkflowExecution.retryingSessions")(() =>
      storage("read", () =>
        sessionsIn("retrying").flatMap((sessionId) => {
          const execution = read(sessionId);
          return execution.kind === "retrying" ? [{ sessionId, runId: execution.runId }] : [];
        }),
      ),
    ),

    canContinue: Effect.fn("WorkflowExecution.canContinue")(
      (sessionId: string, runId: string, state: WorkflowState) =>
        storage("read", () => current(sessionId, runId, state, "ready")),
    ),

    /**
     * Whether a new run continues the Plan after `runId` was cut off by a restart: a later run
     * knows everything it did and its `retryAt` has passed. The ended run is not replayed.
     */
    canResume: Effect.fn("WorkflowExecution.canResume")(function* (
      sessionId: string,
      runId: string,
      state: WorkflowState,
    ) {
      const now = yield* Clock.currentTimeMillis;
      return yield* storage("read", () => {
        const execution = read(sessionId);
        return (
          execution.kind === "retrying" &&
          execution.retryAt <= now &&
          current(sessionId, runId, state, "retrying") &&
          endedWithKnownEffects.get(runId) !== undefined
        );
      });
    }),

    /**
     * Continuation of a running Goal whose run the previous process left unfinished. A run whose
     * effects a later run knows, by the same rule that admits a later run, continues at `resumeAt`
     * (now when absent); otherwise the run may have changed something a new run could repeat, so
     * the session waits behind a blocker.
     */
    afterRestart: Effect.fn("WorkflowExecution.afterRestart")(function* (
      sessionId: string,
      runId: string,
      resumeAt: number | undefined,
    ) {
      const now = yield* Clock.currentTimeMillis;
      return yield* storage("write", () => {
        const previous = read(sessionId);
        if (previous.kind !== "running" || previous.runId !== runId) return previous;
        return endedWithKnownEffects.get(runId) !== undefined
          ? save(sessionId, { ...previous, kind: "retrying", retryAt: resumeAt ?? now })
          : save(sessionId, {
              kind: "blocked",
              runId,
              reason: "server_restarted",
              detail:
                "결과가 확인되지 않은 도구 실행 중 서버가 다시 시작돼 자동으로 이어가지 않았어요. 실행 결과를 확인한 뒤 다시 보내 주세요.",
              evidence: [
                runId,
                "Owner tool operation without a recorded result before the restart",
              ],
            });
      });
    }),

    start: Effect.fn("WorkflowExecution.start")(
      (sessionId: string, runId: string, state: WorkflowState, userTurn: boolean) =>
        storage("write", () => {
          if (!executable(state) || state.goal === null || state.plan === null) return;
          const previous = read(sessionId);
          if (previous.kind === "running" && previous.runId === runId) return;
          const continued = previous.kind === "ready" || previous.kind === "retrying";
          save(sessionId, {
            kind: "running",
            runId,
            goalVersion: state.goal.version,
            planVersion: state.plan.version,
            noProgressRuns: !userTurn && continued ? previous.noProgressRuns : 0,
            progress: progressOf(
              state,
              !userTurn && continued ? previous.progress.toolResults : [],
            ),
          });
        }),
    ),

    finish: Effect.fn("WorkflowExecution.finish")(
      (
        sessionId: string,
        runId: string,
        state: WorkflowState,
        toolResults: readonly string[] = [],
      ) =>
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
          const progress = progressOf(
            state,
            EffectArray.dedupe([...previous.progress.toolResults, ...toolResults]),
          );
          const advanced =
            progress.toolResults.some((item) => !previous.progress.toolResults.includes(item)) ||
            progress.completedSteps.some((id) => !previous.progress.completedSteps.includes(id)) ||
            progress.evidence.some((item) => !previous.progress.evidence.includes(item));
          const noProgressRuns = advanced ? 0 : previous.noProgressRuns + 1;
          const schedule = planSchedule(state.plan?.steps ?? []);
          save(
            sessionId,
            schedule.kind === "stalled"
              ? {
                  kind: "blocked",
                  runId,
                  reason: "dependency_stalled",
                  detail:
                    "남은 단계가 모두 막혔거나 끝나지 않은 단계를 기다리고 있어 바로 시작할 단계가 없어요. 막힌 단계나 단계 의존 관계를 확인해 주세요.",
                  evidence: stalledEvidence(schedule),
                }
              : noProgressRuns >= 2
                ? {
                    kind: "blocked",
                    runId,
                    reason: "repeated_failure",
                    detail:
                      "두 턴 연속 완료된 단계, 새로운 진행 근거 또는 유의미한 도구 결과가 없어 자동 진행을 멈췄어요.",
                    evidence: [
                      previous.runId,
                      "Two consecutive runs without new workflow evidence, completed steps or substantive successful tool results",
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
          if ((current.kind !== "ready" && current.kind !== "retrying") || current.runId !== runId)
            return;
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
>()("memory-agent/workflow/execution/WorkflowExecution") {
  static readonly layer = Layer.effect(WorkflowExecution, make);
}
