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

/** The lists of an execution, by the `workflow_execution_entries` list that keeps them. */
type EntryList = "completed_step" | "progress_evidence" | "tool_result" | "blocker_evidence";
const Entries = Schema.fromJsonString(Schema.Array(Schema.String));
const encodeEntries = Schema.encodeEffect(Entries);
const ExecutionRow = Schema.Struct({
  state: Schema.String,
  run_id: Schema.NullOr(Schema.String),
  goal_version: Schema.NullOr(Schema.Finite),
  plan_version: Schema.NullOr(Schema.Finite),
  no_progress_runs: Schema.NullOr(Schema.Finite),
  retry_at: Schema.NullOr(Schema.Finite),
  reason: Schema.NullOr(Schema.String),
  detail: Schema.NullOr(Schema.String),
  completed_step: Entries,
  progress_evidence: Entries,
  tool_result: Entries,
  blocker_evidence: Entries,
});
/** A stored execution as its case: a field of another case is not read. */
const stateOf = (row: typeof ExecutionRow.Type) =>
  Schema.decodeUnknownEffect(WorkflowExecutionState)({
    _tag: row.state,
    runId: row.run_id,
    goalVersion: row.goal_version,
    planVersion: row.plan_version,
    noProgressRuns: row.no_progress_runs,
    progress: {
      completedSteps: row.completed_step,
      evidence: row.progress_evidence,
      toolResults: row.tool_result,
    },
    retryAt: row.retry_at,
    reason: row.reason,
    detail: row.detail,
    evidence: row.blocker_evidence,
  });

/** The columns a case fills; the table's CHECKs keep the others empty. */
const noColumns = {
  run_id: null,
  goal_version: null,
  plan_version: null,
  no_progress_runs: null,
  retry_at: null,
  reason: null,
  detail: null,
};
/** The fields every case of a continuing execution has. */
type Execution = Omit<typeof cases.running.Type, "_tag">;
const executionColumns = (state: Execution) => ({
  ...noColumns,
  run_id: state.runId,
  goal_version: state.goalVersion,
  plan_version: state.planVersion,
  no_progress_runs: state.noProgressRuns,
});
type Lists = ReadonlyArray<readonly [EntryList, readonly string[]]>;
const progressLists = (state: Execution): Lists => [
  ["completed_step", state.progress.completedSteps],
  ["progress_evidence", state.progress.evidence],
  ["tool_result", state.progress.toolResults],
];
const rowOf = (state: WorkflowExecutionState) =>
  WorkflowExecutionState.match(state, {
    idle: () => ({ columns: noColumns, lists: [] }),
    running: (running) => ({ columns: executionColumns(running), lists: progressLists(running) }),
    ready: (ready) => ({ columns: executionColumns(ready), lists: progressLists(ready) }),
    retrying: (retrying) => ({
      columns: { ...executionColumns(retrying), retry_at: retrying.retryAt },
      lists: progressLists(retrying),
    }),
    blocked: (blocked) => ({
      columns: {
        ...noColumns,
        run_id: blocked.runId,
        reason: blocked.reason,
        detail: blocked.detail,
      },
      lists: [["blocker_evidence", blocked.evidence]] satisfies Lists,
    }),
    stopped: (stopped) => ({ columns: { ...noColumns, reason: stopped.reason }, lists: [] }),
  });
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
  state.phase === "running" &&
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
  const entries = (list: EntryList) =>
    sql.literal(`(SELECT json_group_array(x.value ORDER BY x.position)
      FROM workflow_execution_entries x
      WHERE x.session_id = e.session_id AND x.list = '${list}') AS ${list}`);
  const select = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: ExecutionRow,
    execute: (sessionId) => sql`SELECT e.state, e.run_id, e.goal_version, e.plan_version,
        e.no_progress_runs, e.retry_at, e.reason, e.detail, ${entries("completed_step")},
        ${entries("progress_evidence")}, ${entries("tool_result")}, ${entries("blocker_evidence")}
      FROM workflow_executions e WHERE e.session_id = ${sessionId}`,
  });
  const sessionsOf = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({ session_id: Schema.String }),
    execute: (kind) => sql`SELECT session_id FROM workflow_executions WHERE state = ${kind}`,
  });
  const endedWithKnownEffects = (runId: string) =>
    sql`SELECT 1 AS ended FROM chat_runs r
      WHERE r.run_id = ${runId} AND ${sql.literal(endedWithKnownEffectsSql("r"))}`.pipe(
      Effect.map((rows) => rows.length > 0),
    );
  const read = (sessionId: string) =>
    select(sessionId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed<WorkflowExecutionState>(cases.idle.make({})),
          onSome: stateOf,
        }),
      ),
    );
  /** Replaces the session's execution and its lists; callers run it inside `writing`. */
  const save = Effect.fnUntraced(function* (sessionId: string, state: WorkflowExecutionState) {
    const { columns, lists } = rowOf(state);
    yield* sql`INSERT INTO workflow_executions
        (session_id, state, run_id, goal_version, plan_version, no_progress_runs, retry_at, reason,
         detail)
      VALUES (${sessionId}, ${state._tag}, ${columns.run_id}, ${columns.goal_version},
        ${columns.plan_version}, ${columns.no_progress_runs}, ${columns.retry_at}, ${columns.reason},
        ${columns.detail})
      ON CONFLICT (session_id) DO UPDATE SET state = excluded.state, run_id = excluded.run_id,
        goal_version = excluded.goal_version, plan_version = excluded.plan_version,
        no_progress_runs = excluded.no_progress_runs, retry_at = excluded.retry_at,
        reason = excluded.reason, detail = excluded.detail`;
    yield* sql`DELETE FROM workflow_execution_entries WHERE session_id = ${sessionId}`;
    yield* Effect.forEach(
      lists,
      ([list, values]) =>
        Effect.flatMap(
          encodeEntries(values),
          (
            encoded,
          ) => sql`INSERT INTO workflow_execution_entries (session_id, list, position, value)
            SELECT ${sessionId}, ${list}, key, value FROM json_each(${encoded})`,
        ),
      { discard: true },
    );
    return state;
  });
  const sessionsIn = (kind: keyof typeof cases) =>
    sessionsOf(kind).pipe(Effect.map((rows) => rows.map((row) => row.session_id)));
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
