import {
  Array as EffectArray,
  Clock,
  Context,
  Effect,
  Layer,
  Option,
  Schema,
  Struct,
} from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { PlanSchedule, planSchedule, stalledEvidence } from "./plan-schedule.ts";
import { endedWithKnownEffectsSql } from "./run-bindings.ts";
import { type WorkflowBlocker, WorkflowExecutionState } from "./contracts.ts";
import type { WorkflowState } from "./workflow.ts";

export { WorkflowBlocker, WorkflowExecutionState } from "./contracts.ts";

const { cases } = WorkflowExecutionState;
const isRunning = WorkflowExecutionState.isAnyOf(["running"]);
const isRetrying = WorkflowExecutionState.isAnyOf(["retrying"]);
/** A run that ended with its Plan left to continue. */
const isPending = WorkflowExecutionState.isAnyOf(["ready", "retrying"]);
const isReconciled = (state: WorkflowExecutionState) =>
  state._tag === "stopped" && state.reason === "state_reconciled";
const executionKeys = Struct.keys(Struct.omit(cases.running.fields, ["_tag"]));

export class WorkflowExecutionFailed extends Schema.TaggedError<
  WorkflowExecutionFailed,
  { readonly brand: unique symbol }
>()("WorkflowExecutionFailed", {
  operation: Schema.Literals(["read", "write"]),
  cause: Schema.Defect(),
}) {}

const namespace = "memory-agent/workflow-execution";
const encode = Schema.encodeEffect(Schema.fromJsonString(WorkflowExecutionState));
const progressOf = (
  state: WorkflowState,
  toolResults: readonly string[] = [],
): typeof cases.running.fields.progress.Type => ({
  toolResults,
  completedSteps:
    state.plan?.steps.filter((step) => step.status === "done").map((step) => step.id) ?? [],
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
  const sql = yield* SqlClient.SqlClient;
  const failed = (operation: "read" | "write") => (cause: unknown) =>
    WorkflowExecutionFailed.make({ operation, cause });
  /** Reads run as one statement sequence; writes read and replace the state in one transaction. */
  const reading = <A, E>(effect: Effect.Effect<A, E>) => Effect.mapError(effect, failed("read"));
  const writing = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.mapError(sql.withTransaction(effect), failed("write"));
  const select = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ value: Schema.fromJsonString(WorkflowExecutionState) }),
    execute: (sessionId) =>
      sql`SELECT value FROM chat_metadata WHERE namespace = ${namespace} AND key = ${sessionId}`,
  });
  const sessionsOf = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({ key: Schema.String }),
    execute: (kind) => sql`SELECT key FROM chat_metadata
      WHERE namespace = ${namespace} AND json_extract(value, '$._tag') = ${kind}`,
  });
  const endedWithKnownEffects = (runId: string) =>
    sql`SELECT 1 AS ended FROM chat_runs r
      WHERE r.run_id = ${runId} AND ${sql.literal(endedWithKnownEffectsSql("r"))}`.pipe(
      Effect.map((rows) => rows.length > 0),
    );
  const read = (sessionId: string) =>
    select(sessionId).pipe(
      Effect.map(
        Option.match({
          onNone: (): WorkflowExecutionState => cases.idle.make({}),
          onSome: (row) => row.value,
        }),
      ),
    );
  const save = Effect.fnUntraced(function* (sessionId: string, state: WorkflowExecutionState) {
    const value = yield* encode(state);
    yield* sql`INSERT INTO chat_metadata (namespace, key, value) VALUES (${namespace}, ${sessionId}, ${value})
      ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value`;
    return state;
  });
  const sessionsIn = (kind: keyof typeof cases) =>
    sessionsOf(kind).pipe(Effect.map((rows) => rows.map((row) => row.key)));
  const current = Effect.fnUntraced(function* (
    sessionId: string,
    runId: string,
    state: WorkflowState,
    kind: "ready" | "retrying",
  ) {
    const execution = yield* read(sessionId);
    return (
      WorkflowExecutionState.isAnyOf([kind])(execution) &&
      execution.runId === runId &&
      executable(state) &&
      execution.goalVersion === state.goal?.version &&
      execution.planVersion === state.plan?.version &&
      !PlanSchedule.$is("stalled")(planSchedule(state.plan.steps))
    );
  });

  return {
    get: Effect.fn("WorkflowExecution.get")((sessionId: string) => reading(read(sessionId))),
    readySessions: Effect.fn("WorkflowExecution.readySessions")(() => reading(sessionsIn("ready"))),

    /** Sessions whose restarted run continues at its `retryAt`, with that run. */
    retryingSessions: Effect.fn("WorkflowExecution.retryingSessions")(() =>
      reading(
        sessionsIn("retrying").pipe(
          Effect.flatMap((sessions) =>
            Effect.forEach(sessions, (sessionId) =>
              read(sessionId).pipe(
                Effect.map((execution) =>
                  isRetrying(execution) ? [{ sessionId, runId: execution.runId }] : [],
                ),
              ),
            ),
          ),
          Effect.map((found) => found.flat()),
        ),
      ),
    ),

    canContinue: Effect.fn("WorkflowExecution.canContinue")(
      (sessionId: string, runId: string, state: WorkflowState) =>
        reading(current(sessionId, runId, state, "ready")),
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
      return yield* reading(
        Effect.gen(function* () {
          const execution = yield* read(sessionId);
          return (
            isRetrying(execution) &&
            execution.retryAt <= now &&
            (yield* current(sessionId, runId, state, "retrying")) &&
            (yield* endedWithKnownEffects(runId))
          );
        }),
      );
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
      return yield* writing(
        Effect.gen(function* () {
          const previous = yield* read(sessionId);
          if (!isRunning(previous) || previous.runId !== runId) return previous;
          return (yield* endedWithKnownEffects(runId))
            ? yield* save(
                sessionId,
                cases.retrying.make({
                  ...Struct.pick(previous, executionKeys),
                  retryAt: resumeAt ?? now,
                }),
              )
            : yield* save(
                sessionId,
                cases.blocked.make({
                  runId,
                  reason: "server_restarted",
                  detail:
                    "결과가 확인되지 않은 도구 실행 중 서버가 다시 시작돼 자동으로 이어가지 않았어요. 실행 결과를 확인한 뒤 다시 보내 주세요.",
                  evidence: [
                    runId,
                    "Owner tool operation without a recorded result before the restart",
                  ],
                }),
              );
        }),
      );
    }),

    /** Stops the automatic runs of a session the startup check repaired. */
    stopReconciled: Effect.fn("WorkflowExecution.stopReconciled")((sessionId: string) =>
      writing(save(sessionId, cases.stopped.make({ reason: "state_reconciled" }))),
    ),

    start: Effect.fn("WorkflowExecution.start")(
      (sessionId: string, runId: string, state: WorkflowState, userTurn: boolean) =>
        writing(
          Effect.gen(function* () {
            const previous = yield* read(sessionId);
            // A user turn is what the repair notice asks for, also in a Goal that does not run.
            if (!executable(state) || state.goal === null || state.plan === null) {
              yield* Effect.when(
                save(sessionId, cases.idle.make({})),
                Effect.succeed(userTurn && isReconciled(previous)),
              );
              return;
            }
            if (isRunning(previous) && previous.runId === runId) return;
            const continued = isPending(previous);
            yield* save(
              sessionId,
              cases.running.make({
                runId,
                goalVersion: state.goal.version,
                planVersion: state.plan.version,
                noProgressRuns: !userTurn && continued ? previous.noProgressRuns : 0,
                progress: progressOf(
                  state,
                  !userTurn && continued ? previous.progress.toolResults : [],
                ),
              }),
            );
          }),
        ),
    ),

    finish: Effect.fn("WorkflowExecution.finish")(
      (
        sessionId: string,
        runId: string,
        state: WorkflowState,
        toolResults: readonly string[] = [],
      ) =>
        writing(
          Effect.gen(function* () {
            const previous = yield* read(sessionId);
            if (!isRunning(previous) || previous.runId !== runId) return;
            if (
              !executable(state) ||
              state.goal?.version !== previous.goalVersion ||
              state.plan?.version !== previous.planVersion
            ) {
              yield* save(
                sessionId,
                cases.stopped.make({
                  reason: state.goal?.status === "completed" ? "completed" : "workflow_changed",
                }),
              );
              return;
            }
            const progress = progressOf(
              state,
              EffectArray.dedupe([...previous.progress.toolResults, ...toolResults]),
            );
            const advanced =
              progress.toolResults.some((item) => !previous.progress.toolResults.includes(item)) ||
              progress.completedSteps.some(
                (id) => !previous.progress.completedSteps.includes(id),
              ) ||
              progress.evidence.some((item) => !previous.progress.evidence.includes(item));
            const noProgressRuns = advanced ? 0 : previous.noProgressRuns + 1;
            const schedule = planSchedule(state.plan?.steps ?? []);
            yield* save(
              sessionId,
              PlanSchedule.$is("stalled")(schedule)
                ? cases.blocked.make({
                    runId,
                    reason: "dependency_stalled",
                    detail:
                      "남은 단계가 모두 막혔거나 끝나지 않은 단계를 기다리고 있어 바로 시작할 단계가 없어요. 막힌 단계나 단계 의존 관계를 확인해 주세요.",
                    evidence: stalledEvidence(schedule),
                  })
                : noProgressRuns >= 2
                  ? cases.blocked.make({
                      runId,
                      reason: "repeated_failure",
                      detail:
                        "두 턴 연속 완료된 단계, 새로운 진행 근거 또는 유의미한 도구 결과가 없어 자동 진행을 멈췄어요.",
                      evidence: [
                        previous.runId,
                        "Two consecutive runs without new workflow evidence, completed steps or substantive successful tool results",
                      ],
                    })
                  : cases.ready.make({
                      ...Struct.pick(previous, executionKeys),
                      progress,
                      noProgressRuns,
                    }),
            );
          }),
        ),
    ),

    block: Effect.fn("WorkflowExecution.block")(
      (sessionId: string, runId: string, blocker: WorkflowBlocker) =>
        writing(
          Effect.gen(function* () {
            const current = yield* read(sessionId);
            if (!isRunning(current) || current.runId !== runId)
              return { error: "execution_not_running" as const };
            return yield* save(sessionId, cases.blocked.make({ runId, ...blocker }));
          }),
        ),
    ),

    blockPending: Effect.fn("WorkflowExecution.blockPending")(
      (sessionId: string, runId: string, blocker: WorkflowBlocker) =>
        writing(
          Effect.gen(function* () {
            const current = yield* read(sessionId);
            if (!isPending(current) || current.runId !== runId) return;
            yield* save(sessionId, cases.blocked.make({ runId, ...blocker }));
          }),
        ),
    ),

    stop: Effect.fn("WorkflowExecution.stop")(
      (sessionId: string, reason: "user" | "run_failed" = "user", runId?: string) =>
        writing(
          Effect.gen(function* () {
            const current = yield* read(sessionId);
            if (runId !== undefined && (!isRunning(current) || current.runId !== runId)) return;
            yield* save(sessionId, cases.stopped.make({ reason }));
          }),
        ),
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
