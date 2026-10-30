import {
  Array as EffectArray,
  Cause,
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  PubSub,
  Result,
  Schema,
  type Scope,
  Stream,
} from "effect";
import { SqlClient, type SqlError, SqlSchema } from "effect/sql";
import { AgUiEvent } from "../loop/chunks.ts";
import { RunLogFailed, type RunLog, type RunLogEntry } from "../loop/run-log.ts";

const namespace = "sdk-stream:v1:";
const closedKey = `${namespace}closed`;
/**
 * How long a reader at the end of an open log waits for its run's signal before it reads again,
 * so a write that sends no signal still reaches it.
 */
const signalWait = "1 second";

/**
 * Wakes the readers of open run logs: a log sends its run id once an append or its close has
 * committed, and a reader at the end of the log waits for its own run's id.
 */
export class RunLogSignals extends Context.Service<
  RunLogSignals,
  {
    readonly written: (runId: string) => Effect.Effect<void>;
    readonly subscribe: Effect.Effect<PubSub.Subscription<string>, never, Scope.Scope>;
  }
>()("memory-agent/workflow/durable-stream/RunLogSignals") {
  static readonly layer = Layer.effect(
    RunLogSignals,
    Effect.map(PubSub.unbounded<string>(), (written) =>
      RunLogSignals.of({
        written: (runId) => Effect.asVoid(PubSub.publish(written, runId)),
        subscribe: PubSub.subscribe(written),
      }),
    ),
  );
}

type Rejection = Exclude<RunLogFailed["reason"], "storage">;

const rejected = (reason: Rejection) => RunLogFailed.make({ reason });
const stored = (cause: SqlError.SqlError | Schema.SchemaError | Cause.NoSuchElementError) =>
  RunLogFailed.make({ reason: "storage", cause });

const Entry = Schema.Struct({ cursor: Schema.Finite, payload_json: Schema.String });
const Cursor = Schema.Struct({ cursor: Schema.Finite });
const encodeEvent = Schema.encodeEffect(Schema.fromJsonString(AgUiEvent));
const decodeEvent = Schema.decodeResult(Schema.fromJsonString(AgUiEvent));

/** Owner-only delivery log. Receipt cursors are NOT log offsets: only this
 * namespace's persisted chunks mint resumable tokens. Authentication belongs to
 * the HTTP route; this log additionally checks the immutable session/run binding.
 * Use the central DB's SqlClient, never a worker-local database.
 */
export const sqliteRunLog = Effect.fn("sqliteRunLog")(function* (input: {
  readonly sessionId: string;
  readonly runId: string;
  readonly resumeOffset?: string | null;
}) {
  const { sessionId, runId } = input;
  const sql = yield* SqlClient.SqlClient;
  const signals = yield* RunLogSignals;
  const check = SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: Schema.Struct({ session_id: Schema.String }),
    execute: () => sql`SELECT session_id FROM workflow_run_bindings WHERE run_id = ${runId}`,
  })().pipe(
    Effect.mapError(stored),
    Effect.filterOrFail(
      (row) => Option.isSome(row) && row.value.session_id === sessionId,
      () => rejected("binding_denied"),
    ),
  );
  const closed = sql`SELECT cursor FROM workflow_run_events
    WHERE run_id = ${runId} AND event_key = ${closedKey}`.pipe(
    Effect.map((rows) => rows.length > 0),
    Effect.mapError(stored),
  );
  const chunkRows = SqlSchema.findAll({
    Request: Schema.Finite,
    Result: Entry,
    execute: (after) => sql`SELECT cursor, payload_json FROM workflow_run_events
      WHERE run_id = ${runId} AND kind = 'chunk' AND event_key LIKE 'sdk-stream:v1:chunk:%'
      AND cursor > ${after} ORDER BY cursor`,
  });
  const lastCursor = SqlSchema.findOne({
    Request: Schema.Void,
    Result: Cursor,
    execute: () => sql`SELECT COALESCE(MAX(cursor), 0) AS cursor
      FROM workflow_run_events WHERE run_id = ${runId}`,
  });
  const insert = SqlSchema.findOne({
    Request: Schema.Struct({
      event_key: Schema.String,
      kind: Schema.String,
      payload_json: Schema.String,
    }),
    Result: Cursor,
    execute: (event) =>
      DateTime.now.pipe(
        Effect.flatMap(
          (now) =>
            sql`INSERT INTO workflow_run_events ${sql.insert({
              run_id: runId,
              ...event,
              created_at: DateTime.formatIso(now),
            })} RETURNING cursor`,
        ),
      ),
  });
  const token = (cursor: number) => `${namespace}${encodeURIComponent(runId)}:${cursor}`;
  const minted = (offset: string): Option.Option<number> => {
    const prefix = `${namespace}${encodeURIComponent(runId)}:`;
    const suffix = offset.startsWith(prefix) ? offset.slice(prefix.length) : "";
    const cursor = Number(suffix);
    return /^[1-9]\d*$/.test(suffix) && Number.isSafeInteger(cursor)
      ? Option.some(cursor)
      : Option.none();
  };
  const parse = (offset: string) =>
    offset === "-1"
      ? Effect.succeed(0)
      : Option.match(minted(offset), {
          onNone: () => Effect.fail(rejected("invalid_offset")),
          onSome: (cursor) =>
            sql`SELECT cursor FROM workflow_run_events WHERE run_id = ${runId}
              AND cursor = ${cursor} AND kind = 'chunk' AND event_key LIKE 'sdk-stream:v1:chunk:%'`.pipe(
              Effect.mapError(stored),
              Effect.filterOrFail(
                (rows) => rows.length > 0,
                () => rejected("unknown_offset"),
              ),
              Effect.as(cursor),
            ),
        });
  /** What the log holds after `after`, and whether it is closed, read at one moment. */
  const page = (after: number) =>
    check.pipe(
      Effect.andThen(Effect.all({ rows: Effect.mapError(chunkRows(after), stored), closed })),
      sql.withTransaction,
      Effect.catchTag("SqlError", (cause) => Effect.fail(stored(cause))),
    );
  /**
   * The page after `after`. At the end of an open log it then waits until this run writes or
   * `signalWait` passes. It subscribes before reading, so a write right after the read still wakes it.
   */
  const nextPage = (after: number) =>
    Effect.scoped(
      Effect.gen(function* () {
        const writes = yield* signals.subscribe;
        const current = yield* page(after);
        yield* Effect.when(
          PubSub.take(writes).pipe(
            Effect.repeat({ until: (written) => written === runId }),
            Effect.timeoutOption(signalWait),
          ),
          Effect.succeed(current.rows.length === 0 && !current.closed),
        );
        return current;
      }),
    );
  // AG-UI message/tool/error events and the accepted marker have no runId.
  // Reject explicit cross-run lifecycle events; otherwise the owner binding scopes them.
  const named = (event: { readonly runId: string; readonly threadId: string }) =>
    Effect.succeed(event).pipe(
      Effect.filterOrFail(
        (lifecycle) => lifecycle.runId === runId,
        () => rejected("run_mismatch"),
      ),
      Effect.filterOrFail(
        ({ threadId }) => threadId === sessionId,
        () => rejected("session_mismatch"),
      ),
    );
  const payload = (event: AgUiEvent) =>
    Effect.andThen(
      AgUiEvent.isAnyOf(["RUN_STARTED", "RUN_FINISHED"])(event) ? named(event) : Effect.void,
      Effect.mapError(encodeEvent(event), stored),
    );
  const record = (event_key: string, kind: string, payload_json: string) =>
    insert({ event_key, kind, payload_json }).pipe(Effect.mapError(stored));
  yield* check;
  yield* Option.match(Option.fromNullishOr(input.resumeOffset), {
    onNone: () => Effect.void,
    onSome: parse,
  });
  const log: RunLog = {
    append: (event) =>
      Effect.gen(function* () {
        yield* check;
        if (yield* closed) return yield* rejected("closed");
        const json = yield* payload(event);
        const { cursor } = yield* Effect.mapError(lastCursor(), stored);
        yield* record(`${namespace}chunk:${cursor + 1}`, "chunk", json);
      }).pipe(
        sql.withTransaction,
        Effect.catchTag("SqlError", (cause) => Effect.fail(stored(cause))),
        Effect.andThen(signals.written(runId)),
      ),
    close: check.pipe(
      Effect.andThen(closed),
      Effect.flatMap((done) =>
        done
          ? Effect.void
          : record(closedKey, "run_completed", JSON.stringify({ deliveryClosed: true })),
      ),
      Effect.asVoid,
      sql.withTransaction,
      Effect.catchTag("SqlError", (cause) => Effect.fail(stored(cause))),
      Effect.andThen(signals.written(runId)),
    ),
    // Entries written before the log held only AG-UI events, which no page reads, are left out.
    read: (offset) =>
      Stream.unwrap(
        check.pipe(
          Effect.andThen(parse(offset)),
          Effect.map((start) =>
            Stream.paginate(start, (after) =>
              Effect.map(
                nextPage(after),
                ({ rows, closed: ended }) =>
                  [
                    rows,
                    ended
                      ? Option.none()
                      : Option.some(
                          Option.getOrElse(
                            Option.map(EffectArray.last(rows), ({ cursor }) => cursor),
                            () => after,
                          ),
                        ),
                  ] as const,
              ),
            ),
          ),
        ),
      ).pipe(
        Stream.filterMap((row) =>
          Result.map(decodeEvent(row.payload_json), (event): RunLogEntry => ({
            offset: token(row.cursor),
            event,
          })),
        ),
      ),
  };
  return log;
});
