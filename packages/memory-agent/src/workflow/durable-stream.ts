import { Cause, DateTime, Effect, Option, Schema, Stream } from "effect";
import { SqlClient, type SqlError, SqlSchema } from "effect/sql";
import { runNativeEffect } from "../runtime/native-effect.ts";
import { nativeStream } from "../runtime/native-stream.ts";
import { isTruthy } from "../truthy.ts";
import type { StreamChunk, StreamDurability } from "@tanstack/ai";

const namespace = "sdk-stream:v1:";
const closedKey = `${namespace}closed`;

export class StreamDurabilityError extends Schema.TaggedError<StreamDurabilityError>()(
  "StreamDurabilityError",
  {
    reason: Schema.Literals([
      "binding_denied",
      "invalid_offset",
      "unknown_offset",
      "closed",
      "missing_chunk",
      "run_mismatch",
      "session_mismatch",
      "storage",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
type Rejection = Exclude<StreamDurabilityError["reason"], "storage">;

const rejected = (reason: Rejection) => StreamDurabilityError.make({ reason });
const stored = (cause: SqlError.SqlError | Schema.SchemaError | Cause.NoSuchElementError) =>
  StreamDurabilityError.make({ reason: "storage", cause });

const Entry = Schema.Struct({
  cursor: Schema.Finite,
  payload_json: Schema.fromJsonString(Schema.Unknown),
});
const Cursor = Schema.Struct({ cursor: Schema.Finite });

/** Owner-only SDK delivery log. Receipt cursors are NOT SDK offsets: only this
 * namespace's persisted chunks mint resumable tokens. Authentication belongs to
 * the HTTP route; this adapter additionally checks the immutable session/run binding.
 * Use the central DB's SqlClient, never a worker-local database.
 */
export const sqliteStreamDurability = Effect.fn("sqliteStreamDurability")(function* (input: {
  readonly sessionId: string;
  readonly runId: string;
  readonly resumeOffset?: string | null;
}) {
  const { sessionId, runId } = input;
  const sql = yield* SqlClient.SqlClient;
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
  const entries = (after: number) =>
    chunkRows(after).pipe(
      Effect.mapError(stored),
      Effect.map((rows) =>
        rows.map((row) => ({
          offset: token(row.cursor),
          // SAFETY: this reserved namespace contains only SDK chunks written by append below.
          chunk: row.payload_json as StreamChunk,
        })),
      ),
    );
  // AG-UI message/tool events and SDK RUN_ACCEPTED have no runId.
  // Reject explicit cross-run lifecycle events; otherwise the owner binding scopes them.
  const payload = (chunk: StreamChunk | undefined) => {
    if (!isTruthy(chunk)) return Effect.fail(rejected("missing_chunk"));
    switch (chunk.type) {
      case "RUN_STARTED":
      case "RUN_FINISHED":
      case "RUN_ERROR":
        if (chunk.runId !== undefined && chunk.runId !== runId)
          return Effect.fail(rejected("run_mismatch"));
        if (chunk.threadId !== undefined && chunk.threadId !== sessionId)
          return Effect.fail(rejected("session_mismatch"));
    }
    return Effect.succeed(JSON.stringify(chunk));
  };
  const record = (event_key: string, kind: string, payload_json: string) =>
    insert({ event_key, kind, payload_json }).pipe(Effect.mapError(stored));
  yield* check;
  yield* Option.match(Option.fromNullishOr(input.resumeOffset), {
    onNone: () => Effect.void,
    onSome: parse,
  });
  const durability: StreamDurability = {
    resumeFrom: () => input.resumeOffset ?? null,
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    append: (chunks) =>
      runNativeEffect(
        Effect.gen(function* () {
          yield* check;
          if (yield* closed) return yield* rejected("closed");
          // Validate every entry before any write, including sparse arrays.
          const payloads = yield* Effect.forEach(
            Array.from({ length: chunks.length }, (_, index) => chunks[index]),
            payload,
          );
          return yield* Effect.forEach(payloads, (json) =>
            lastCursor().pipe(
              Effect.mapError(stored),
              Effect.flatMap(({ cursor }) =>
                record(`${namespace}chunk:${cursor + 1}`, "chunk", json),
              ),
              Effect.map(({ cursor }) => token(cursor)),
            ),
          );
        }).pipe(
          sql.withTransaction,
          Effect.catchTag("SqlError", (cause) => Effect.fail(stored(cause))),
        ),
      ),
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    snapshot: () =>
      runNativeEffect(
        check.pipe(
          Effect.andThen(entries(0)),
          sql.withTransaction,
          Effect.catchTag("SqlError", (cause) => Effect.fail(stored(cause))),
        ),
      ),
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    close: () =>
      runNativeEffect(
        check.pipe(
          Effect.andThen(closed),
          Effect.flatMap((done) =>
            done
              ? Effect.void
              : record(closedKey, "run_completed", JSON.stringify({ deliveryClosed: true })),
          ),
          Effect.asVoid,
          sql.withTransaction,
          Effect.catchTag("SqlError", (cause) => Effect.fail(stored(cause))),
        ),
      ),
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    read: (offset, signal) =>
      nativeStream(
        Stream.fromPull(
          check.pipe(
            Effect.andThen(parse(offset)),
            Effect.map((initialCursor) => {
              let cursor = initialCursor;
              let pending: Effect.Success<ReturnType<typeof entries>> = [];
              let ended = false;
              return Effect.gen(function* () {
                while (signal?.aborted !== true) {
                  const entry = pending.shift();
                  if (entry !== undefined) {
                    cursor = yield* parse(entry.offset);
                    return [entry] as const;
                  }
                  if (ended) return yield* Cause.done();
                  const page = yield* check.pipe(
                    Effect.andThen(Effect.all({ entries: entries(cursor), closed })),
                    sql.withTransaction,
                    Effect.catchTag("SqlError", (cause) => Effect.fail(stored(cause))),
                  );
                  pending = [...page.entries];
                  ended = page.closed;
                  if (pending.length > 0 || ended) continue;
                  const pause = Effect.sleep("20 millis");
                  if (signal === undefined) yield* pause;
                  else
                    yield* Effect.raceFirst(
                      pause,
                      Effect.callback<never, Cause.Done>((resume) => {
                        const abort = () => resume(Cause.done());
                        signal.addEventListener("abort", abort, { once: true });
                        if (signal.aborted) abort();
                        return Effect.sync(() => signal.removeEventListener("abort", abort));
                      }),
                    );
                }
                return yield* Cause.done();
              });
            }),
          ),
        ),
      ),
  };
  return durability;
});
