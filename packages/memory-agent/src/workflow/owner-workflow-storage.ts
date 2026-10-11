/* Native SQLite and Effect's encoded workflow boundary necessarily accept parsed unknown values. */
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/require-safety-comment-for-type-assertion */
import { Context, Effect, Layer, Option, Result, Schema } from "effect";
import { Function as EffectFunction } from "effect";
import { Database } from "../db/database.ts";

export class OwnerWorkflowStorageError extends Schema.TaggedError<OwnerWorkflowStorageError>()(
  "OwnerWorkflowStorageError",
  {
    operation: Schema.String,
    reason: Schema.Literals(["database", "invalid_state", "execution_conflict", "codec"]),
    cause: Schema.Defect(),
  },
) {}

export type StoredWorkflowResult =
  | { readonly _tag: "Suspended" }
  | { readonly _tag: "Complete"; readonly exit: unknown };

export type StoredExecution = {
  readonly executionId: string;
  readonly workflowName: string;
  readonly payload: object;
  readonly parentExecutionId: string | undefined;
  readonly status: "running" | "suspended" | "completed" | "interrupted";
  readonly result: StoredWorkflowResult | undefined;
};

export type OwnerWorkflowAdmissionRequest = {
  readonly workflowName: string;
  readonly executionId: string;
  readonly payload: object;
  readonly parentExecutionId?: string | undefined;
};

export type OwnerWorkflowAdmissionResult<A> =
  | { readonly type: "admitted"; readonly value: A }
  | { readonly type: "existing"; readonly execution: StoredExecution };

const ExecutionRow = Schema.Struct({
  execution_id: Schema.String,
  workflow_name: Schema.String,
  payload_json: Schema.String,
  parent_execution_id: Schema.NullOr(Schema.String),
  status: Schema.Literals(["running", "suspended", "completed", "interrupted"]),
  result_json: Schema.NullOr(Schema.String),
});
type ExecutionRow = typeof ExecutionRow.Type;

const JsonObject = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const JsonUnknown = Schema.fromJsonString(Schema.Unknown);

const failure = (operation: string, reason: OwnerWorkflowStorageError["reason"], cause: unknown) =>
  OwnerWorkflowStorageError.make({ operation, reason, cause });

const encodeJson = (operation: string, value: unknown): string => {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw failure(operation, "codec", value);
    return encoded;
  } catch (cause) {
    if (Schema.is(OwnerWorkflowStorageError)(cause)) throw cause;
    throw failure(operation, "codec", cause);
  }
};

const decodeUnknown = (operation: string, value: string): unknown => {
  const result = Schema.decodeResult(JsonUnknown)(value);
  if (Result.isFailure(result)) throw failure(operation, "codec", result.failure);
  return result.success;
};

const decodeObject = (operation: string, value: string): object => {
  const result = Schema.decodeResult(JsonObject)(value);
  if (Result.isFailure(result)) throw failure(operation, "codec", result.failure);
  return result.success;
};

const optionalRow = (operation: string, value: unknown): ExecutionRow | undefined => {
  const result = Schema.decodeUnknownResult(Schema.UndefinedOr(ExecutionRow))(value);
  if (Result.isFailure(result)) throw failure(operation, "invalid_state", result.failure);
  return result.success;
};

const executionRows = (operation: string, value: unknown): ReadonlyArray<ExecutionRow> => {
  const result = Schema.decodeUnknownResult(Schema.Array(ExecutionRow))(value);
  if (Result.isFailure(result)) throw failure(operation, "invalid_state", result.failure);
  return result.success;
};

const storedResult = (
  operation: string,
  value: string | null,
): StoredWorkflowResult | undefined => {
  if (value === null) return undefined;
  const result = decodeUnknown(operation, value);
  const decoded = Schema.decodeUnknownResult(
    Schema.Union([
      Schema.TaggedStruct("Suspended", {}),
      Schema.TaggedStruct("Complete", { exit: Schema.Unknown }),
    ]),
  )(result);
  if (Result.isFailure(decoded)) throw failure(operation, "invalid_state", decoded.failure);
  return decoded.success;
};

export interface OwnerWorkflowStorageApi {
  readonly admit: (request: OwnerWorkflowAdmissionRequest) => StoredExecution;
  readonly admitWith: <A>(
    request: OwnerWorkflowAdmissionRequest,
    bind: () => A,
  ) => OwnerWorkflowAdmissionResult<A>;
  readonly execution: (executionId: string) => Option.Option<StoredExecution>;
  readonly workflowExecutions: (workflowName: string) => ReadonlyArray<StoredExecution>;
  readonly pendingExecutions: (workflowName: string) => ReadonlyArray<StoredExecution>;
  readonly setRunning: (executionId: string) => void;
  readonly setInterrupted: (executionId: string) => void;
  readonly setResult: (executionId: string, result: StoredWorkflowResult) => void;
  readonly activityResult: (
    executionId: string,
    activityName: string,
    attempt: number,
  ) => Option.Option<StoredWorkflowResult>;
  readonly setActivityResult: (
    executionId: string,
    activityName: string,
    attempt: number,
    result: StoredWorkflowResult,
  ) => void;
  readonly deferredResult: (executionId: string, deferredName: string) => Option.Option<unknown>;
  readonly setDeferredResult: (
    workflowName: string,
    executionId: string,
    deferredName: string,
    exit: unknown,
  ) => boolean;
  readonly scheduleClock: (clock: {
    readonly workflowName: string;
    readonly executionId: string;
    readonly clockName: string;
    readonly deferredName: string;
    readonly dueAt: number;
  }) => number;
  readonly pendingClocks: () => ReadonlyArray<{
    readonly workflowName: string;
    readonly executionId: string;
    readonly clockName: string;
    readonly deferredName: string;
    readonly dueAt: number;
  }>;
  readonly fireClock: (executionId: string, clockName: string) => boolean;
  readonly cancelClocks: (executionId: string) => ReadonlyArray<string>;
}

function makeOwnerWorkflowStorage(database: Database["Service"]): OwnerWorkflowStorageApi {
  const { atomic, sqlite } = database;
  const byExecution = sqlite.prepare(`
    SELECT execution_id, workflow_name, payload_json, parent_execution_id, status, result_json
    FROM owner_workflow_executions WHERE execution_id = ?
  `);
  const allByWorkflow = sqlite.prepare(`
    SELECT execution_id, workflow_name, payload_json, parent_execution_id, status, result_json
    FROM owner_workflow_executions WHERE workflow_name = ? ORDER BY execution_id
  `);
  const pendingByWorkflow = sqlite.prepare(`
    SELECT execution_id, workflow_name, payload_json, parent_execution_id, status, result_json
    FROM owner_workflow_executions
    WHERE workflow_name = ? AND status IN ('running', 'suspended')
    ORDER BY execution_id
  `);
  const insertExecution = sqlite.prepare(`
    INSERT INTO owner_workflow_executions
      (execution_id, workflow_name, payload_json, parent_execution_id, status, result_json)
    VALUES (?, ?, ?, ?, 'running', NULL)
  `);
  const updateRunning = sqlite.prepare(`
    UPDATE owner_workflow_executions SET status = 'running', result_json = NULL
    WHERE execution_id = ? AND status <> 'completed'
  `);
  const updateInterrupted = sqlite.prepare(`
    UPDATE owner_workflow_executions SET status = 'interrupted'
    WHERE execution_id = ? AND status <> 'completed'
  `);
  const updateResult = sqlite.prepare(`
    UPDATE owner_workflow_executions SET status = ?, result_json = ? WHERE execution_id = ?
  `);
  const getActivity = sqlite.prepare(`
    SELECT result_json FROM owner_workflow_activities
    WHERE execution_id = ? AND activity_name = ? AND attempt = ?
  `);
  const putActivity = sqlite.prepare(`
    INSERT INTO owner_workflow_activities (execution_id, activity_name, attempt, result_json)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(execution_id, activity_name, attempt) DO NOTHING
  `);
  const getDeferred = sqlite.prepare(`
    SELECT exit_json FROM owner_workflow_deferreds
    WHERE execution_id = ? AND deferred_name = ?
  `);
  const putDeferred = sqlite.prepare(`
    INSERT INTO owner_workflow_deferreds
      (execution_id, deferred_name, workflow_name, exit_json)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(execution_id, deferred_name) DO NOTHING
  `);
  const putClock = sqlite.prepare(`
    INSERT INTO owner_workflow_clocks
      (execution_id, clock_name, workflow_name, deferred_name, due_at, status)
    VALUES (?, ?, ?, ?, ?, 'scheduled')
    ON CONFLICT(execution_id, clock_name) DO NOTHING
  `);
  const getClock = sqlite.prepare(`
    SELECT due_at FROM owner_workflow_clocks WHERE execution_id = ? AND clock_name = ?
  `);
  const listClocks = sqlite.prepare(`
    SELECT workflow_name, execution_id, clock_name, deferred_name, due_at
    FROM owner_workflow_clocks WHERE status = 'scheduled' ORDER BY due_at
  `);
  const clockForFire = sqlite.prepare(`
    SELECT workflow_name, deferred_name, status FROM owner_workflow_clocks
    WHERE execution_id = ? AND clock_name = ?
  `);
  const markClockFired = sqlite.prepare(`
    UPDATE owner_workflow_clocks SET status = 'fired'
    WHERE execution_id = ? AND clock_name = ? AND status = 'scheduled'
  `);
  const scheduledClocks = sqlite.prepare(`
    SELECT clock_name FROM owner_workflow_clocks
    WHERE execution_id = ? AND status = 'scheduled' ORDER BY clock_name
  `);
  const deleteScheduledClocks = sqlite.prepare(`
    DELETE FROM owner_workflow_clocks WHERE execution_id = ? AND status = 'scheduled'
  `);

  const run = <A>(operation: string, work: () => A): A => {
    try {
      return work();
    } catch (cause) {
      if (Schema.is(OwnerWorkflowStorageError)(cause)) throw cause;
      throw failure(operation, "database", cause);
    }
  };

  const decodeExecution = (row: ExecutionRow): StoredExecution => ({
    executionId: row.execution_id,
    workflowName: row.workflow_name,
    payload: decodeObject("execution.payload", row.payload_json),
    parentExecutionId: row.parent_execution_id ?? undefined,
    status: row.status,
    result: storedResult("execution.result", row.result_json),
  });

  const readExecution = (executionId: string): StoredExecution | undefined => {
    const row = optionalRow("execution.read", byExecution.get(executionId));
    return row === undefined ? undefined : decodeExecution(row);
  };

  const admitRaw = (request: OwnerWorkflowAdmissionRequest): StoredExecution => {
    const payloadJson = encodeJson("execution.payload", request.payload);
    const existing = readExecution(request.executionId);
    if (existing !== undefined) {
      if (
        existing.workflowName !== request.workflowName ||
        encodeJson("execution.payload", existing.payload) !== payloadJson ||
        existing.parentExecutionId !== request.parentExecutionId
      )
        throw failure("execution.admit", "execution_conflict", request.executionId);
      return existing;
    }
    insertExecution.run(
      request.executionId,
      request.workflowName,
      payloadJson,
      request.parentExecutionId ?? null,
    );
    return (
      readExecution(request.executionId) ??
      (() => {
        throw failure("execution.admit", "invalid_state", request.executionId);
      })()
    );
  };

  const setDeferredRaw = (
    workflowName: string,
    executionId: string,
    deferredName: string,
    exit: unknown,
  ) => {
    const json = encodeJson("deferred.encode", exit);
    const result = putDeferred.run(executionId, deferredName, workflowName, json);
    if (result.changes === 0) {
      const row = getDeferred.get(executionId, deferredName) as { exit_json?: unknown } | undefined;
      if (row?.exit_json !== json)
        throw failure("deferred.complete", "execution_conflict", deferredName);
      return false;
    }
    return true;
  };

  return {
    admit: (request) => run("execution.admit", () => atomic(() => admitRaw(request))),
    admitWith: (request, bind) =>
      run("execution.admitWith", () =>
        atomic(() => {
          const existing = readExecution(request.executionId);
          if (existing !== undefined)
            return { type: "existing" as const, execution: admitRaw(request) };
          const value = bind();
          admitRaw(request);
          return { type: "admitted" as const, value };
        }),
      ),
    execution: (executionId) =>
      run("execution.read", () => Option.fromNullishOr(readExecution(executionId))),
    workflowExecutions: (workflowName) =>
      run("execution.list", () =>
        executionRows("execution.list", allByWorkflow.all(workflowName)).map(decodeExecution),
      ),
    pendingExecutions: (workflowName) =>
      run("execution.pending", () =>
        executionRows("execution.pending", pendingByWorkflow.all(workflowName)).map(
          decodeExecution,
        ),
      ),
    setRunning: (executionId) =>
      run("execution.running", () => void updateRunning.run(executionId)),
    setInterrupted: (executionId) =>
      run("execution.interrupt", () => void updateInterrupted.run(executionId)),
    setResult: (executionId, result) =>
      run("execution.result", () => {
        const status = result._tag === "Complete" ? "completed" : "suspended";
        const changed = updateResult.run(
          status,
          encodeJson("execution.result", result),
          executionId,
        );
        if (changed.changes !== 1) throw failure("execution.result", "invalid_state", executionId);
      }),
    activityResult: (executionId, activityName, attempt) =>
      run("activity.read", () => {
        const row = getActivity.get(executionId, activityName, attempt) as
          | { result_json?: unknown }
          | undefined;
        if (row === undefined) return Option.none();
        if (!Schema.is(Schema.String)(row.result_json))
          throw failure("activity.read", "invalid_state", row);
        return Option.fromNullishOr(storedResult("activity.result", row.result_json));
      }),
    setActivityResult: (executionId, activityName, attempt, result) =>
      run("activity.result", () => {
        const json = encodeJson("activity.result", result);
        const inserted = putActivity.run(executionId, activityName, attempt, json);
        if (inserted.changes === 0) {
          const row = getActivity.get(executionId, activityName, attempt) as
            | { result_json?: unknown }
            | undefined;
          if (row?.result_json !== json)
            throw failure("activity.result", "execution_conflict", activityName);
        }
      }),
    deferredResult: (executionId, deferredName) =>
      run("deferred.read", () => {
        const row = getDeferred.get(executionId, deferredName) as
          | { exit_json?: unknown }
          | undefined;
        if (row === undefined) return Option.none();
        if (!Schema.is(Schema.String)(row.exit_json))
          throw failure("deferred.read", "invalid_state", row);
        return Option.some(decodeUnknown("deferred.exit", row.exit_json));
      }),
    setDeferredResult: (workflowName, executionId, deferredName, exit) =>
      run("deferred.complete", () =>
        atomic(() => setDeferredRaw(workflowName, executionId, deferredName, exit)),
      ),
    scheduleClock: (clock) =>
      run("clock.schedule", () =>
        atomic(() => {
          putClock.run(
            clock.executionId,
            clock.clockName,
            clock.workflowName,
            clock.deferredName,
            clock.dueAt,
          );
          const row = getClock.get(clock.executionId, clock.clockName) as
            | { due_at?: unknown }
            | undefined;
          if (!Schema.is(Schema.Finite)(row?.due_at))
            throw failure("clock.schedule", "invalid_state", row);
          return row.due_at;
        }),
      ),
    pendingClocks: () =>
      run("clock.pending", () => {
        const Row = Schema.Struct({
          workflow_name: Schema.String,
          execution_id: Schema.String,
          clock_name: Schema.String,
          deferred_name: Schema.String,
          due_at: Schema.Finite,
        });
        return EffectFunction.flow(
          Schema.decodeUnknownResult(Schema.Array(Row)),
          Result.getOrThrow,
        )(listClocks.all()).map((row) => ({
          workflowName: row.workflow_name,
          executionId: row.execution_id,
          clockName: row.clock_name,
          deferredName: row.deferred_name,
          dueAt: row.due_at,
        }));
      }),
    fireClock: (executionId, clockName) =>
      run("clock.fire", () =>
        atomic(() => {
          const row = clockForFire.get(executionId, clockName) as
            | { workflow_name?: unknown; deferred_name?: unknown; status?: unknown }
            | undefined;
          if (row === undefined || row.status === "fired") return false;
          if (
            !Schema.is(Schema.String)(row.workflow_name) ||
            !Schema.is(Schema.String)(row.deferred_name) ||
            row.status !== "scheduled"
          )
            throw failure("clock.fire", "invalid_state", row);
          setDeferredRaw(row.workflow_name, executionId, row.deferred_name, {
            _tag: "Success",
            value: null,
          });
          markClockFired.run(executionId, clockName);
          return true;
        }),
      ),
    cancelClocks: (executionId) =>
      run("clock.cancel", () =>
        atomic(() => {
          const decoded = Schema.decodeUnknownResult(
            Schema.Array(Schema.Struct({ clock_name: Schema.String })),
          )(scheduledClocks.all(executionId));
          if (decoded._tag === "Failure")
            throw failure("clock.cancel", "invalid_state", decoded.failure);
          const rows = decoded.success;
          deleteScheduledClocks.run(executionId);
          return rows.map((row) => row.clock_name);
        }),
      ),
  };
}

export class OwnerWorkflowStorage extends Context.Service<
  OwnerWorkflowStorage,
  OwnerWorkflowStorageApi
>()("memory-agent/workflow/owner-workflow-storage/OwnerWorkflowStorage") {}

export const ownerWorkflowStorageLayer: Layer.Layer<OwnerWorkflowStorage, never, Database> =
  Layer.effect(
    OwnerWorkflowStorage,
    Effect.gen(function* () {
      return makeOwnerWorkflowStorage(yield* Database);
    }),
  );

export class OwnerWorkflowAdmission extends Context.Service<
  OwnerWorkflowAdmission,
  {
    readonly admit: <A>(
      request: OwnerWorkflowAdmissionRequest,
      bind: () => A,
    ) => Effect.Effect<OwnerWorkflowAdmissionResult<A>, OwnerWorkflowStorageError>;
  }
>()("memory-agent/workflow/owner-workflow-storage/OwnerWorkflowAdmission") {}
