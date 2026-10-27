import { type Cause, Context, Data, Effect, Exit, Layer, Match, Option, Schema } from "effect";
import { SqlClient, type SqlError, SqlSchema } from "effect/sql";

export class OwnerWorkflowStorageError extends Schema.TaggedError<OwnerWorkflowStorageError>()(
  "OwnerWorkflowStorageError",
  {
    operation: Schema.String,
    reason: Schema.Literals(["database", "invalid_state", "execution_conflict", "codec"]),
    cause: Schema.Defect(),
  },
) {}

export const StoredWorkflowResult = Schema.TaggedUnion({
  Suspended: {},
  Complete: { exit: Schema.Json },
});
export type StoredWorkflowResult = typeof StoredWorkflowResult.Type;

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

export type OwnerWorkflowAdmissionResult<A> = Data.TaggedEnum<{
  admitted: { readonly value: A };
  existing: { readonly execution: StoredExecution };
}>;
interface OwnerWorkflowAdmissionResultDefinition extends Data.TaggedEnum.WithGenerics<1> {
  readonly taggedEnum: OwnerWorkflowAdmissionResult<this["A"]>;
}
export const OwnerWorkflowAdmissionResult =
  Data.taggedEnum<OwnerWorkflowAdmissionResultDefinition>();

export type ScheduledClock = {
  readonly workflowName: string;
  readonly executionId: string;
  readonly clockName: string;
  readonly deferredName: string;
  readonly dueAt: number;
};

const ExecutionRow = Schema.Struct({
  execution_id: Schema.String,
  workflow_name: Schema.String,
  payload_json: Schema.String,
  parent_execution_id: Schema.NullOr(Schema.String),
  status: Schema.Literals(["running", "suspended", "completed", "interrupted"]),
  result_json: Schema.NullOr(Schema.String),
});
type ExecutionRow = typeof ExecutionRow.Type;
const ClockRow = Schema.Struct({
  workflow_name: Schema.String,
  execution_id: Schema.String,
  clock_name: Schema.String,
  deferred_name: Schema.String,
  due_at: Schema.Finite,
});
const JsonObject = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const JsonText = Schema.fromJsonString(Schema.Json);

const failure = (operation: string, reason: OwnerWorkflowStorageError["reason"], cause: unknown) =>
  OwnerWorkflowStorageError.make({ operation, reason, cause });

/** A fired clock completes its deferred with a void success, in the engine's encoded Exit shape. */
const firedClockExit = Schema.encodeEffect(
  Schema.toCodecJson(Schema.Exit(Schema.Null, Schema.Never, Schema.Defect())),
)(Exit.succeed(null)).pipe(Effect.mapError((cause) => failure("clock.fire", "codec", cause)));

const encodeJson = (operation: string, value: Schema.Json) =>
  Schema.encodeEffect(JsonText)(value).pipe(
    Effect.mapError((cause) => failure(operation, "codec", cause)),
  );

/** A workflow payload is stored as the JSON object its record fields encode to. */
const encodePayload = (owner: Pick<StoredExecution, "payload">) =>
  Schema.encodeUnknownEffect(JsonObject)(owner.payload).pipe(
    Effect.mapError((cause) => failure("execution.payload", "codec", cause)),
  );

const decodeJson = (operation: string, value: string) =>
  Schema.decodeEffect(JsonText)(value).pipe(
    Effect.mapError((cause) => failure(operation, "codec", cause)),
  );

const storedResult = Effect.fnUntraced(function* (operation: string, value: string | null) {
  if (value === null) return undefined;
  const result = yield* decodeJson(operation, value);
  return yield* Schema.decodeUnknownEffect(StoredWorkflowResult)(result).pipe(
    Effect.mapError((cause) => failure(operation, "invalid_state", cause)),
  );
});

type Stored<A> = Effect.Effect<A, OwnerWorkflowStorageError>;

export interface OwnerWorkflowStorageApi {
  readonly admit: (request: OwnerWorkflowAdmissionRequest) => Stored<StoredExecution>;
  /** Runs `bind` and the first durable request in one transaction; `bind` may refuse with `E`. */
  readonly admitWith: <A, E>(
    request: OwnerWorkflowAdmissionRequest,
    bind: Effect.Effect<A, E>,
  ) => Effect.Effect<OwnerWorkflowAdmissionResult<A>, OwnerWorkflowStorageError | E>;
  readonly execution: (executionId: string) => Stored<Option.Option<StoredExecution>>;
  readonly workflowExecutions: (workflowName: string) => Stored<ReadonlyArray<StoredExecution>>;
  readonly pendingExecutions: (workflowName: string) => Stored<ReadonlyArray<StoredExecution>>;
  readonly setRunning: (executionId: string) => Stored<void>;
  readonly setInterrupted: (executionId: string) => Stored<void>;
  readonly setResult: (executionId: string, result: StoredWorkflowResult) => Stored<void>;
  readonly activityResult: (
    executionId: string,
    activityName: string,
    attempt: number,
  ) => Stored<Option.Option<StoredWorkflowResult>>;
  readonly setActivityResult: (
    executionId: string,
    activityName: string,
    attempt: number,
    result: StoredWorkflowResult,
  ) => Stored<void>;
  readonly deferredResult: (
    executionId: string,
    deferredName: string,
  ) => Stored<Option.Option<Schema.Json>>;
  readonly setDeferredResult: (
    workflowName: string,
    executionId: string,
    deferredName: string,
    exit: Schema.Json,
  ) => Stored<boolean>;
  readonly scheduleClock: (clock: ScheduledClock) => Stored<number>;
  readonly pendingClocks: Stored<ReadonlyArray<ScheduledClock>>;
  readonly fireClock: (executionId: string, clockName: string) => Stored<boolean>;
  readonly cancelClocks: (executionId: string) => Stored<ReadonlyArray<string>>;
}

const makeOwnerWorkflowStorage = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  /** A storage step: database failures and malformed rows keep the operation that met them. */
  const step =
    (operation: string) =>
    <A>(
      effect: Effect.Effect<A, SqlError.SqlError | Schema.SchemaError | Cause.NoSuchElementError>,
    ): Stored<A> =>
      Effect.mapError(effect, (cause) =>
        Match.valueTags(cause, {
          SqlError: (cause) => failure(operation, "database", cause),
          SchemaError: (cause) => failure(operation, "invalid_state", cause),
          NoSuchElementError: (cause) => failure(operation, "invalid_state", cause),
        }),
      );

  const byExecution = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: ExecutionRow,
    execute: (executionId) => sql`
      SELECT execution_id, workflow_name, payload_json, parent_execution_id, status, result_json
      FROM owner_workflow_executions WHERE execution_id = ${executionId}`,
  });
  const allByWorkflow = SqlSchema.findAll({
    Request: Schema.String,
    Result: ExecutionRow,
    execute: (workflowName) => sql`
      SELECT execution_id, workflow_name, payload_json, parent_execution_id, status, result_json
      FROM owner_workflow_executions WHERE workflow_name = ${workflowName} ORDER BY execution_id`,
  });
  const pendingByWorkflow = SqlSchema.findAll({
    Request: Schema.String,
    Result: ExecutionRow,
    execute: (workflowName) => sql`
      SELECT execution_id, workflow_name, payload_json, parent_execution_id, status, result_json
      FROM owner_workflow_executions
      WHERE workflow_name = ${workflowName} AND status IN ('running', 'suspended')
      ORDER BY execution_id`,
  });
  const activityRow = SqlSchema.findOneOption({
    Request: Schema.Struct({
      executionId: Schema.String,
      activityName: Schema.String,
      attempt: Schema.Finite,
    }),
    Result: Schema.Struct({ result_json: Schema.String }),
    execute: ({ executionId, activityName, attempt }) => sql`
      SELECT result_json FROM owner_workflow_activities
      WHERE execution_id = ${executionId} AND activity_name = ${activityName} AND attempt = ${attempt}`,
  });
  const deferredRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ executionId: Schema.String, deferredName: Schema.String }),
    Result: Schema.Struct({ exit_json: Schema.String }),
    execute: ({ executionId, deferredName }) => sql`
      SELECT exit_json FROM owner_workflow_deferreds
      WHERE execution_id = ${executionId} AND deferred_name = ${deferredName}`,
  });
  const clockDue = SqlSchema.findOne({
    Request: Schema.Struct({ executionId: Schema.String, clockName: Schema.String }),
    Result: Schema.Struct({ due_at: Schema.Finite }),
    execute: ({ executionId, clockName }) => sql`
      SELECT due_at FROM owner_workflow_clocks
      WHERE execution_id = ${executionId} AND clock_name = ${clockName}`,
  });
  const scheduledClocks = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ClockRow,
    execute: () => sql`
      SELECT workflow_name, execution_id, clock_name, deferred_name, due_at
      FROM owner_workflow_clocks WHERE status = 'scheduled' ORDER BY due_at`,
  });
  const clockForFire = SqlSchema.findOneOption({
    Request: Schema.Struct({ executionId: Schema.String, clockName: Schema.String }),
    Result: Schema.Struct({
      workflow_name: Schema.String,
      deferred_name: Schema.String,
      status: Schema.Literals(["scheduled", "fired"]),
    }),
    execute: ({ executionId, clockName }) => sql`
      SELECT workflow_name, deferred_name, status FROM owner_workflow_clocks
      WHERE execution_id = ${executionId} AND clock_name = ${clockName}`,
  });
  const cancelScheduled = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({ clock_name: Schema.String }),
    execute: (executionId) => sql`
      DELETE FROM owner_workflow_clocks
      WHERE execution_id = ${executionId} AND status = 'scheduled' RETURNING clock_name`,
  });

  const decodeExecution = Effect.fnUntraced(function* (row: ExecutionRow) {
    const payload: object = yield* Schema.decodeEffect(JsonObject)(row.payload_json).pipe(
      Effect.mapError((cause) => failure("execution.payload", "codec", cause)),
    );
    return {
      executionId: row.execution_id,
      workflowName: row.workflow_name,
      payload,
      parentExecutionId: row.parent_execution_id ?? undefined,
      status: row.status,
      result: yield* storedResult("execution.result", row.result_json),
    } satisfies StoredExecution;
  });

  const readExecution = (executionId: string) =>
    Effect.flatMap(
      step("execution.read")(byExecution(executionId)),
      Option.match({
        onNone: () => Effect.succeedNone,
        onSome: (row) => Effect.asSome(decodeExecution(row)),
      }),
    );

  const admitRaw = Effect.fnUntraced(function* (request: OwnerWorkflowAdmissionRequest) {
    const payloadJson = yield* encodePayload(request);
    const existing = yield* readExecution(request.executionId);
    if (Option.isSome(existing)) {
      if (
        existing.value.workflowName !== request.workflowName ||
        (yield* encodePayload(existing.value)) !== payloadJson ||
        existing.value.parentExecutionId !== request.parentExecutionId
      )
        return yield* failure("execution.admit", "execution_conflict", request.executionId);
      return existing.value;
    }
    yield* step("execution.admit")(sql`
      INSERT INTO owner_workflow_executions
        (execution_id, workflow_name, payload_json, parent_execution_id, status, result_json)
      VALUES (${request.executionId}, ${request.workflowName}, ${payloadJson},
        ${request.parentExecutionId ?? null}, 'running', NULL)`);
    return yield* Effect.fromOption(yield* readExecution(request.executionId), () =>
      failure("execution.admit", "invalid_state", request.executionId),
    );
  });

  const setDeferredRaw = Effect.fnUntraced(function* (
    workflowName: string,
    executionId: string,
    deferredName: string,
    exit: Schema.Json,
  ) {
    const json = yield* encodeJson("deferred.encode", exit);
    const inserted = yield* step("deferred.complete")(sql`
      INSERT INTO owner_workflow_deferreds (execution_id, deferred_name, workflow_name, exit_json)
      VALUES (${executionId}, ${deferredName}, ${workflowName}, ${json})
      ON CONFLICT(execution_id, deferred_name) DO NOTHING RETURNING execution_id`);
    if (inserted.length > 0) return true;
    const row = yield* step("deferred.complete")(deferredRow({ executionId, deferredName }));
    if (Option.getOrUndefined(row)?.exit_json !== json)
      return yield* failure("deferred.complete", "execution_conflict", deferredName);
    return false;
  });

  const transaction =
    (operation: string) =>
    <A, E>(effect: Effect.Effect<A, E>) =>
      sql
        .withTransaction(effect)
        .pipe(
          Effect.catchTag("SqlError", (cause) =>
            Effect.fail(failure(operation, "database", cause)),
          ),
        );

  const storage: OwnerWorkflowStorageApi = {
    admit: (request) => transaction("execution.admit")(admitRaw(request)),
    admitWith: (request, bind) =>
      transaction("execution.admitWith")(
        Effect.gen(function* () {
          const existing = yield* readExecution(request.executionId);
          if (Option.isSome(existing))
            return OwnerWorkflowAdmissionResult.existing({ execution: yield* admitRaw(request) });
          const value = yield* bind;
          yield* admitRaw(request);
          return OwnerWorkflowAdmissionResult.admitted({ value });
        }),
      ),
    execution: readExecution,
    workflowExecutions: (workflowName) =>
      Effect.flatMap(step("execution.list")(allByWorkflow(workflowName)), (rows) =>
        Effect.forEach(rows, decodeExecution),
      ),
    pendingExecutions: (workflowName) =>
      Effect.flatMap(step("execution.pending")(pendingByWorkflow(workflowName)), (rows) =>
        Effect.forEach(rows, decodeExecution),
      ),
    setRunning: (executionId) =>
      step("execution.running")(
        Effect.asVoid(sql`
          UPDATE owner_workflow_executions SET status = 'running', result_json = NULL
          WHERE execution_id = ${executionId} AND status <> 'completed'`),
      ),
    setInterrupted: (executionId) =>
      step("execution.interrupt")(
        Effect.asVoid(sql`
          UPDATE owner_workflow_executions SET status = 'interrupted'
          WHERE execution_id = ${executionId} AND status <> 'completed'`),
      ),
    setResult: Effect.fnUntraced(function* (executionId, result) {
      const status = Match.valueTags(result, {
        Complete: () => "completed" as const,
        Suspended: () => "suspended" as const,
      });
      const json = yield* encodeJson("execution.result", result);
      const changed = yield* step("execution.result")(sql`
        UPDATE owner_workflow_executions SET status = ${status}, result_json = ${json}
        WHERE execution_id = ${executionId} RETURNING execution_id`);
      yield* Effect.when(
        Effect.fail(failure("execution.result", "invalid_state", executionId)),
        Effect.succeed(changed.length !== 1),
      );
    }),
    activityResult: (executionId, activityName, attempt) =>
      step("activity.read")(activityRow({ executionId, activityName, attempt })).pipe(
        Effect.flatMap((row) =>
          Effect.transposeOption(
            Option.map(row, (value) => storedResult("activity.result", value.result_json)),
          ),
        ),
        Effect.map(Option.flatMap(Option.fromNullishOr)),
      ),
    setActivityResult: Effect.fnUntraced(function* (executionId, activityName, attempt, result) {
      const json = yield* encodeJson("activity.result", result);
      const inserted = yield* step("activity.result")(sql`
        INSERT INTO owner_workflow_activities (execution_id, activity_name, attempt, result_json)
        VALUES (${executionId}, ${activityName}, ${attempt}, ${json})
        ON CONFLICT(execution_id, activity_name, attempt) DO NOTHING RETURNING execution_id`);
      if (inserted.length > 0) return;
      const row = yield* step("activity.result")(
        activityRow({ executionId, activityName, attempt }),
      );
      if (Option.getOrUndefined(row)?.result_json !== json)
        return yield* failure("activity.result", "execution_conflict", activityName);
    }),
    deferredResult: (executionId, deferredName) =>
      Effect.flatMap(step("deferred.read")(deferredRow({ executionId, deferredName })), (row) =>
        Effect.transposeOption(
          Option.map(row, (value) => decodeJson("deferred.exit", value.exit_json)),
        ),
      ),
    setDeferredResult: (workflowName, executionId, deferredName, exit) =>
      transaction("deferred.complete")(
        setDeferredRaw(workflowName, executionId, deferredName, exit),
      ),
    scheduleClock: (clock) =>
      transaction("clock.schedule")(
        step("clock.schedule")(
          Effect.andThen(
            sql`
              INSERT INTO owner_workflow_clocks
                (execution_id, clock_name, workflow_name, deferred_name, due_at, status)
              VALUES (${clock.executionId}, ${clock.clockName}, ${clock.workflowName},
                ${clock.deferredName}, ${clock.dueAt}, 'scheduled')
              ON CONFLICT(execution_id, clock_name) DO NOTHING`,
            clockDue({ executionId: clock.executionId, clockName: clock.clockName }),
          ),
        ).pipe(Effect.map((row) => row.due_at)),
      ),
    pendingClocks: Effect.map(step("clock.pending")(scheduledClocks()), (rows) =>
      rows.map((row) => ({
        workflowName: row.workflow_name,
        executionId: row.execution_id,
        clockName: row.clock_name,
        deferredName: row.deferred_name,
        dueAt: row.due_at,
      })),
    ),
    fireClock: (executionId, clockName) =>
      transaction("clock.fire")(
        Effect.gen(function* () {
          const row = yield* step("clock.fire")(clockForFire({ executionId, clockName }));
          if (Option.isNone(row) || row.value.status === "fired") return false;
          yield* setDeferredRaw(
            row.value.workflow_name,
            executionId,
            row.value.deferred_name,
            yield* firedClockExit,
          );
          yield* step("clock.fire")(sql`
            UPDATE owner_workflow_clocks SET status = 'fired'
            WHERE execution_id = ${executionId} AND clock_name = ${clockName}
              AND status = 'scheduled'`);
          return true;
        }),
      ),
    cancelClocks: (executionId) =>
      Effect.map(step("clock.cancel")(cancelScheduled(executionId)), (rows) =>
        rows.map((row) => row.clock_name).toSorted(),
      ),
  };
  return storage;
});

export class OwnerWorkflowStorage extends Context.Service<
  OwnerWorkflowStorage,
  OwnerWorkflowStorageApi
>()("memory-agent/workflow/owner-workflow-storage/OwnerWorkflowStorage") {}

export const ownerWorkflowStorageLayer: Layer.Layer<
  OwnerWorkflowStorage,
  never,
  SqlClient.SqlClient
> = Layer.effect(OwnerWorkflowStorage, makeOwnerWorkflowStorage);

export class OwnerWorkflowAdmission extends Context.Service<
  OwnerWorkflowAdmission,
  {
    readonly admit: <A, E>(
      request: OwnerWorkflowAdmissionRequest,
      bind: Effect.Effect<A, E>,
    ) => Effect.Effect<OwnerWorkflowAdmissionResult<A>, OwnerWorkflowStorageError | E>;
  }
>()("memory-agent/workflow/owner-workflow-storage/OwnerWorkflowAdmission") {}
