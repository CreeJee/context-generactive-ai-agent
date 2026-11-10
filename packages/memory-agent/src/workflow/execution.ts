import { Clock, Context, Effect, Layer, Option, Schema, Struct } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { endedWithKnownEffectsSql } from "./run-bindings.ts";
import { type WorkflowBlocker, WorkflowExecutionState } from "./contracts.ts";
import type { WorkflowState } from "./workflow.ts";
import { msg } from "@lingui/core/runtime-macro";
import { i18n } from "../i18n.ts";

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

/** A blocked execution's evidence, as `workflow_blocker_evidence` keeps it in order. */
const Evidence = Schema.fromJsonString(Schema.Array(Schema.String));
const encodeEvidence = Schema.encodeEffect(Evidence);
const ExecutionRow = Schema.Struct({
  state: Schema.String,
  run_id: Schema.NullOr(Schema.String),
  goal_version: Schema.NullOr(Schema.Finite),
  plan_version: Schema.NullOr(Schema.Finite),
  retry_at: Schema.NullOr(Schema.Finite),
  reason: Schema.NullOr(Schema.String),
  detail: Schema.NullOr(Schema.String),
  evidence: Evidence,
});
/** A stored execution as its case: a field of another case is not read. */
const stateOf = (row: typeof ExecutionRow.Type) =>
  Schema.decodeUnknownEffect(WorkflowExecutionState)({
    _tag: row.state,
    runId: row.run_id,
    goalVersion: row.goal_version,
    planVersion: row.plan_version,
    retryAt: row.retry_at,
    reason: row.reason,
    detail: row.detail,
    evidence: row.evidence,
  });

/** The columns a case fills; the table's CHECKs keep the others empty. */
const noColumns = {
  run_id: null,
  goal_version: null,
  plan_version: null,
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
});
const rowOf = (state: WorkflowExecutionState) =>
  WorkflowExecutionState.match(state, {
    idle: () => ({ columns: noColumns, evidence: [] }),
    running: (running) => ({ columns: executionColumns(running), evidence: [] }),
    ready: (ready) => ({ columns: executionColumns(ready), evidence: [] }),
    retrying: (retrying) => ({
      columns: { ...executionColumns(retrying), retry_at: retrying.retryAt },
      evidence: [],
    }),
    blocked: (blocked) => ({
      columns: {
        ...noColumns,
        run_id: blocked.runId,
        reason: blocked.reason,
        detail: blocked.detail,
      },
      evidence: blocked.evidence,
    }),
    stopped: (stopped) => ({ columns: { ...noColumns, reason: stopped.reason }, evidence: [] }),
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
  const select = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: ExecutionRow,
    execute: (sessionId) => sql`SELECT e.state, e.run_id, e.goal_version, e.plan_version,
        e.retry_at, e.reason, e.detail,
        (SELECT json_group_array(x.value ORDER BY x.position) FROM workflow_blocker_evidence x
          WHERE x.session_id = e.session_id) AS evidence
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
  /** Replaces the session's execution and its evidence; callers run it inside `writing`. */
  const save = Effect.fnUntraced(function* (sessionId: string, state: WorkflowExecutionState) {
    const { columns, evidence } = rowOf(state);
    yield* sql`INSERT INTO workflow_executions
        (session_id, state, run_id, goal_version, plan_version, retry_at, reason, detail)
      VALUES (${sessionId}, ${state._tag}, ${columns.run_id}, ${columns.goal_version},
        ${columns.plan_version}, ${columns.retry_at}, ${columns.reason}, ${columns.detail})
      ON CONFLICT (session_id) DO UPDATE SET state = excluded.state, run_id = excluded.run_id,
        goal_version = excluded.goal_version, plan_version = excluded.plan_version,
        retry_at = excluded.retry_at, reason = excluded.reason, detail = excluded.detail`;
    yield* sql`DELETE FROM workflow_blocker_evidence WHERE session_id = ${sessionId}`;
    const encoded = yield* encodeEvidence(evidence);
    yield* sql`INSERT INTO workflow_blocker_evidence (session_id, position, value)
      SELECT ${sessionId}, key, value FROM json_each(${encoded})`;
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
                  detail: i18n._(
                    msg`결과가 확인되지 않은 도구 실행 중 서버가 다시 시작돼 자동으로 이어가지 않았습니다. 실행 결과를 확인한 뒤 다시 보내 주십시오.`,
                  ),
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
            yield* save(
              sessionId,
              cases.running.make({
                runId,
                goalVersion: state.goal.version,
                planVersion: state.plan.version,
              }),
            );
          }),
        ),
    ),

    /**
     * A run that ended cleanly leaves its executing Plan to the board, `ready` until the board takes
     * it. A Goal or Plan the run changed, or one that no longer runs, ends the continuation.
     */
    finish: Effect.fn("WorkflowExecution.finish")(
      (sessionId: string, runId: string, state: WorkflowState) =>
        writing(
          Effect.gen(function* () {
            const previous = yield* read(sessionId);
            if (!isRunning(previous) || previous.runId !== runId) return;
            yield* save(
              sessionId,
              executable(state) &&
                state.goal?.version === previous.goalVersion &&
                state.plan?.version === previous.planVersion
                ? cases.ready.make(Struct.pick(previous, executionKeys))
                : cases.stopped.make({
                    reason: state.goal?.status === "completed" ? "completed" : "workflow_changed",
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

    /**
     * A Plan the user just approved whose board did not take it: the session shows why until the
     * user acts, whatever ran before. `runId` is the session's last run.
     */
    blockApproval: Effect.fn("WorkflowExecution.blockApproval")(
      (sessionId: string, runId: string, blocker: WorkflowBlocker) =>
        writing(save(sessionId, cases.blocked.make({ runId, ...blocker }))),
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
