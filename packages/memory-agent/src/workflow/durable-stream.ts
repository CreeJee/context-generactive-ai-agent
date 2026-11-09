import {
  Array as EffectArray,
  Cause,
  Clock,
  Context,
  Duration,
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
import { finishedLogTtl, RunLogFailed, type RunLog, type RunLogEntry } from "../loop/run-log.ts";

/** The offsets this log mints: `sdk-stream:v1:{runId}:{cursor}`, which pages already hold. */
const namespace = "sdk-stream:v1:";
/**
 * How long a reader at the end of an open log waits for its run's signal before it reads again,
 * so a write that sends no signal still reaches it.
 */
const signalWait = "1 second";
/**
 * How long a woken reader waits before it reads. A model writes many small events close together,
 * and each page a reader sends is one update of the page showing the answer; a frame's worth of
 * events comes in one.
 */
const gatherWindow = "16 millis";

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

const Entry = Schema.Struct({ cursor: Schema.Finite, event_json: Schema.String });
const Closure = Schema.Struct({ closed_at: Schema.Finite });
const encodeEvent = Schema.encodeEffect(Schema.fromJsonString(AgUiEvent));
/** Entries' JSON as one JSON array, which `json_each` reads back in order. */
const encodeTexts = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeEvent = Schema.decodeResult(Schema.fromJsonString(AgUiEvent));

/** Whether a log that closed at `closedAt` is past the time a late page may still read it. */
const expired = (closedAt: number, now: number) =>
  now - closedAt > Duration.toMillis(finishedLogTtl);

/** Drops the entries of every log past its time; their closures stay, so they still read as ended. */
const pruneExpired = (sql: SqlClient.SqlClient, now: number) =>
  sql`DELETE FROM workflow_run_log_entries WHERE run_id IN (
    SELECT run_id FROM workflow_run_log_closures
    WHERE closed_at < ${now - Duration.toMillis(finishedLogTtl)})`;

/**
 * Ends the logs a restart cut, at startup: no run outlives a restart (`ChatState`). A page that
 * reconnects to one still reads the partial output the transcript never got, as after any close,
 * until the log's time is up. The entries of logs already past their time go.
 */
export const endCutRunLogs = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  yield* sql`INSERT INTO workflow_run_log_closures (run_id, closed_at)
    SELECT run_id, ${now} FROM workflow_run_bindings
    WHERE run_id NOT IN (SELECT run_id FROM workflow_run_log_closures)`;
  yield* pruneExpired(sql, now);
});

/** Owner-only delivery log. Offsets are entry cursors, minted only for this run's entries.
 * Authentication belongs to the HTTP route; this log additionally checks the immutable
 * session/run binding. Use the central DB's SqlClient, never a worker-local database.
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
  const closure = SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: Closure,
    execute: () => sql`SELECT closed_at FROM workflow_run_log_closures WHERE run_id = ${runId}`,
  })().pipe(Effect.mapError(stored));
  const closed = Effect.map(closure, Option.isSome);
  /** A log past its time reads as gone, as an in-memory log does once it is swept. */
  const readable = Effect.all([closure, Clock.currentTimeMillis]).pipe(
    Effect.filterOrFail(
      ([ended, now]) =>
        Option.match(ended, {
          onNone: () => true,
          onSome: ({ closed_at }) => !expired(closed_at, now),
        }),
      () => rejected("unknown_run"),
    ),
  );
  const entries = SqlSchema.findAll({
    Request: Schema.Finite,
    Result: Entry,
    execute: (after) => sql`SELECT cursor, event_json FROM workflow_run_log_entries
      WHERE run_id = ${runId} AND cursor > ${after} ORDER BY cursor`,
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
            sql`SELECT cursor FROM workflow_run_log_entries
              WHERE run_id = ${runId} AND cursor = ${cursor}`.pipe(
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
      Effect.andThen(Effect.all({ rows: Effect.mapError(entries(after), stored), closed })),
      sql.withTransaction,
      Effect.catchTag("SqlError", (cause) => Effect.fail(stored(cause))),
    );
  /**
   * The page after `after`. At the end of an open log it then waits until this run writes or
   * `signalWait` passes, and after a write `gatherWindow` more, so what follows comes in one page.
   * It subscribes before reading, so a write right after the read still wakes it.
   */
  const nextPage = (after: number) =>
    Effect.scoped(
      Effect.gen(function* () {
        const writes = yield* signals.subscribe;
        const current = yield* page(after);
        yield* Effect.when(
          PubSub.take(writes).pipe(
            Effect.repeat({ until: (written) => written === runId }),
            Effect.andThen(Effect.sleep(gatherWindow)),
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
  /**
   * Writes the entry in one statement when the binding holds and the log is open; whether it wrote.
   * A model's answer appends an event for every few tokens, tens a second.
   */
  const writeIfOpen = (json: string) =>
    Effect.map(
      sql`INSERT INTO workflow_run_log_entries (run_id, event_json)
        SELECT ${runId}, ${json}
        WHERE EXISTS (SELECT 1 FROM workflow_run_bindings
            WHERE run_id = ${runId} AND session_id = ${sessionId})
          AND NOT EXISTS (SELECT 1 FROM workflow_run_log_closures WHERE run_id = ${runId})
        RETURNING cursor`,
      (rows) => rows.length > 0,
    );
  /**
   * Writes the entries in their order in one statement when the binding holds and the log is open;
   * whether it wrote them. It writes all of them or none.
   */
  const writeAllIfOpen = (texts: ReadonlyArray<string>) =>
    Effect.flatMap(Effect.mapError(encodeTexts(texts), stored), (array) =>
      Effect.map(
        sql`INSERT INTO workflow_run_log_entries (run_id, event_json)
          SELECT ${runId}, value FROM json_each(${array})
          WHERE EXISTS (SELECT 1 FROM workflow_run_bindings
              WHERE run_id = ${runId} AND session_id = ${sessionId})
            AND NOT EXISTS (SELECT 1 FROM workflow_run_log_closures WHERE run_id = ${runId})
          ORDER BY key
          RETURNING cursor`,
        (rows) => rows.length === texts.length,
      ),
    );
  /** Checks the binding, the closure and the event in turn, and writes the entry if all hold. */
  const appendChecked = (event: AgUiEvent) =>
    Effect.gen(function* () {
      yield* check;
      if (yield* closed) return yield* rejected("closed");
      const json = yield* payload(event);
      yield* sql`INSERT INTO workflow_run_log_entries ${sql.insert({ run_id: runId, event_json: json })}`;
    }).pipe(sql.withTransaction);
  yield* check;
  yield* Option.match(Option.fromNullishOr(input.resumeOffset), {
    onNone: () => Effect.void,
    onSome: parse,
  });
  // An entry that was not written goes the checked way, which writes it after all or refuses it
  // with the reason the log has always given first: the binding, then the closure, then the event.
  const append = (event: AgUiEvent) =>
    Effect.option(payload(event)).pipe(
      Effect.flatMap(Option.match({ onNone: () => Effect.succeed(false), onSome: writeIfOpen })),
      Effect.flatMap((written) => Effect.when(appendChecked(event), Effect.succeed(!written))),
      Effect.catchTag("SqlError", (cause) => Effect.fail(stored(cause))),
      Effect.andThen(signals.written(runId)),
    );
  const log: RunLog = {
    append,
    // Events that were not all written go one by one, so each is written or refused as `append`
    // would: those before a refused one stay written.
    appendAll: (events) =>
      Effect.option(Effect.forEach(events, payload)).pipe(
        Effect.flatMap(
          Option.match({ onNone: () => Effect.succeed(false), onSome: writeAllIfOpen }),
        ),
        Effect.catchTag("SqlError", (cause) => Effect.fail(stored(cause))),
        Effect.flatMap((written) =>
          written ? signals.written(runId) : Effect.forEach(events, append, { discard: true }),
        ),
      ),
    // A close also drops the entries of the logs past their time; this one's go in a later one.
    close: Effect.gen(function* () {
      yield* check;
      const now = yield* Clock.currentTimeMillis;
      yield* sql`INSERT INTO workflow_run_log_closures (run_id, closed_at)
        VALUES (${runId}, ${now}) ON CONFLICT (run_id) DO NOTHING`;
      yield* pruneExpired(sql, now);
    }).pipe(
      sql.withTransaction,
      Effect.catchTag("SqlError", (cause) => Effect.fail(stored(cause))),
      Effect.andThen(signals.written(runId)),
    ),
    read: (offset) =>
      Stream.unwrap(
        check.pipe(
          Effect.andThen(readable),
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
          Result.map(decodeEvent(row.event_json), (event): RunLogEntry => ({
            offset: token(row.cursor),
            event,
          })),
        ),
      ),
  };
  return log;
});
