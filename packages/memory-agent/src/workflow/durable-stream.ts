import { Cause, DateTime, Effect, Stream } from "effect";
import { nativePromise, runNativeEffect } from "../runtime/native-effect.ts";
import { nativeStream } from "../runtime/native-stream.ts";
import { isTruthy } from "../truthy.ts";
import type { StreamChunk, StreamDurability } from "@tanstack/ai";
import type { DatabaseSync } from "node:sqlite";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { setTimeout } from "node:timers/promises";

const namespace = "sdk-stream:v1:";
const closedKey = `${namespace}closed`;
type Row = { cursor: number; payload_json: string };

/** Owner-only SDK delivery log. Receipt cursors are NOT SDK offsets: only this
 * namespace's persisted chunks mint resumable tokens. Authentication belongs to
 * the HTTP route; this adapter additionally checks the immutable session/run binding.
 * Supply the central DB's transaction wrapper, never a worker-local database.
 */
export function sqliteStreamDurability(input: {
  sqlite: DatabaseSync;
  atomic: <T>(work: () => T) => T;
  sessionId: string;
  runId: string;
  resumeOffset?: string | null;
}): StreamDurability {
  const { sqlite, atomic, sessionId, runId } = input;
  const binding = sqlite.prepare("SELECT session_id FROM workflow_run_bindings WHERE run_id = ?");
  const check = () => {
    // SAFETY: this projection reads the schema's NOT NULL TEXT session_id, or no row.
    const row = binding.get(runId) as { session_id: string } | undefined;
    if (row?.session_id !== sessionId) throw new Error("Stream owner binding denied");
  };
  const rows = sqlite.prepare(`SELECT cursor, payload_json FROM workflow_run_events
    WHERE run_id = ? AND kind = 'chunk' AND event_key LIKE 'sdk-stream:v1:chunk:%'
    AND cursor > ? ORDER BY cursor`);
  const terminal = sqlite.prepare(
    "SELECT cursor FROM workflow_run_events WHERE run_id = ? AND event_key = ?",
  );
  const insert = sqlite.prepare(`INSERT INTO workflow_run_events
    (run_id, event_key, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?)`);
  const token = (cursor: number) => `${namespace}${encodeURIComponent(runId)}:${cursor}`;
  const parse = (offset: string): number => {
    if (offset === "-1") return 0;
    const prefix = `${namespace}${encodeURIComponent(runId)}:`;
    if (!offset.startsWith(prefix)) throw new Error("Invalid stream offset");
    const suffix = offset.slice(prefix.length);
    const cursor = Number(suffix);
    if (!/^[1-9]\d*$/.test(suffix) || !Number.isSafeInteger(cursor))
      throw new Error("Invalid stream offset");
    const row = sqlite
      .prepare(`SELECT cursor FROM workflow_run_events WHERE run_id = ?
      AND cursor = ? AND kind = 'chunk' AND event_key LIKE 'sdk-stream:v1:chunk:%'`)
      .get(runId, cursor);
    if (!isTruthy(row)) throw new Error("Unknown stream offset");
    return cursor;
  };
  const entries = (after: number) => {
    // SAFETY: projection selects INTEGER primary-key cursor and NOT NULL JSON text.
    const stored = rows.all(runId, after) as Row[];
    return stored.map((row) => ({
      offset: token(row.cursor),
      // SAFETY: this reserved namespace contains only SDK chunks written by append below.
      chunk: JSON.parse(row.payload_json) as StreamChunk,
    }));
  };
  check();
  if (input.resumeOffset != null) parse(input.resumeOffset);
  return {
    resumeFrom: () => input.resumeOffset ?? null,
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    append: (chunks) =>
      runNativeEffect(
        Effect.try({
          try: () =>
            atomic(() => {
              check();
              if (isTruthy(terminal.get(runId, closedKey))) throw new Error("Stream is closed");
              // Validate every entry before any write, including sparse arrays.
              const payloads: string[] = [];
              for (let i = 0; i < chunks.length; i++) {
                const chunk = chunks[i];
                if (!isTruthy(chunk)) throw new Error("Missing stream chunk");
                // AG-UI message/tool events and SDK RUN_ACCEPTED have no runId.
                // Reject explicit cross-run lifecycle events; otherwise the owner binding scopes them.
                switch (chunk.type) {
                  case "RUN_STARTED":
                  case "RUN_FINISHED":
                  case "RUN_ERROR":
                    if (chunk.runId !== undefined && chunk.runId !== runId)
                      throw new Error("Stream chunk run mismatch");
                    if (chunk.threadId !== undefined && chunk.threadId !== sessionId)
                      throw new Error("Stream chunk session mismatch");
                    break;
                }
                payloads.push(JSON.stringify(chunk));
              }
              const offsets: string[] = [];
              for (const payload of payloads) {
                // SAFETY: aggregate always returns one row; COALESCE yields an INTEGER cursor or zero.
                const sequence = Number(
                  (
                    sqlite
                      .prepare(`SELECT COALESCE(MAX(cursor), 0) AS cursor
          FROM workflow_run_events WHERE run_id = ?`)
                      .get(runId) as { cursor: number }
                  ).cursor,
                );
                const result = insert.run(
                  runId,
                  `${namespace}chunk:${sequence + 1}`,
                  "chunk",
                  payload,
                  DateTime.formatIso(DateTime.nowUnsafe()),
                );
                offsets.push(token(Number(result.lastInsertRowid)));
              }
              return offsets;
            }),
          catch: (cause) => new Cause.UnknownError(cause),
        }),
      ),
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    snapshot: () =>
      runNativeEffect(
        Effect.try({
          try: () =>
            atomic(() => {
              check();
              return entries(0);
            }),
          catch: (cause) => new Cause.UnknownError(cause),
        }),
      ),
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    close: () =>
      runNativeEffect(
        Effect.try({
          try: () =>
            atomic(() => {
              check();
              if (!isTruthy(terminal.get(runId, closedKey)))
                insert.run(
                  runId,
                  closedKey,
                  "run_completed",
                  JSON.stringify({ deliveryClosed: true }),
                  DateTime.formatIso(DateTime.nowUnsafe()),
                );
            }),
          catch: (cause) => new Cause.UnknownError(cause),
        }),
      ),
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    read: (offset, signal) =>
      nativeStream(
        Stream.fromPull(
          Effect.try({
            try: () => {
              check();
              return parse(offset);
            },
            catch: (cause) => new Cause.UnknownError(cause),
          }).pipe(
            Effect.map((initialCursor) => {
              let cursor = initialCursor;
              let pending: ReturnType<typeof entries> = [];
              let closed = false;
              return Effect.gen(function* () {
                while (!signal?.aborted) {
                  const entry = pending.shift();
                  if (entry !== undefined) {
                    cursor = yield* Effect.try({
                      try: () => parse(entry.offset),
                      catch: (cause) => new Cause.UnknownError(cause),
                    });
                    return [entry] as const;
                  }
                  if (closed) return yield* Cause.done();
                  const page = yield* Effect.try({
                    try: () =>
                      atomic(() => {
                        check();
                        return {
                          entries: entries(cursor),
                          closed: !!isTruthy(terminal.get(runId, closedKey)),
                        };
                      }),
                    catch: (cause) => new Cause.UnknownError(cause),
                  });
                  pending = page.entries;
                  closed = page.closed;
                  if (pending.length > 0 || closed) continue;
                  yield* nativePromise(() => setTimeout(20, undefined, { signal })).pipe(
                    Effect.catch((error) =>
                      Effect.gen(function* () {
                        if (signal?.aborted) return yield* Cause.done();
                        return yield* error;
                      }),
                    ),
                  );
                }
                return yield* Cause.done();
              });
            }),
          ),
        ),
      ),
  };
}
