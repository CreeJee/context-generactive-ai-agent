import type { ModelMessage } from "@tanstack/ai";
import type { MessagePage } from "@tanstack/ai-persistence";
import { Function as EffectFunction, Result, Schema } from "effect";
import type { Database } from "../db/database.ts";
import { groupHistoryMessages, historyProjectionMessages } from "./history-groups.ts";
import { HistoryPageRequest, HistorySnapshotRows } from "./history-projection-reader.ts";
import {
  historyProjectionSchema,
  historyProjectionSnapshots,
  historyProjectionSql as sql,
} from "./history-projection-sql.ts";

export class HistoryPageUnavailable extends Schema.TaggedError<HistoryPageUnavailable>()(
  "HistoryPageUnavailable",
  {
    reason: Schema.Literals(["not-ready", "id-collision", "invalid-transcript"]),
  },
) {}
const decodeRequest = EffectFunction.flow(
  Schema.decodeUnknownResult(HistoryPageRequest),
  Result.getOrThrow,
);
const decodeRows = EffectFunction.flow(
  Schema.decodeUnknownResult(HistorySnapshotRows),
  Result.getOrThrow,
);
const Thread = Schema.Struct({ thread_id: Schema.String, messages: Schema.String });
const decodeThread = EffectFunction.flow(Schema.decodeUnknownResult(Thread), Result.getOrThrow);
const validateStored = EffectFunction.flow(
  Schema.decodeUnknownResult(
    Schema.fromJsonString(
      Schema.Array(
        Schema.Struct({
          role: Schema.Literals(["user", "assistant", "tool"]),
          id: Schema.optional(Schema.String),
        }),
      ),
    ),
  ),
  Result.mapError(() => HistoryPageUnavailable.make({ reason: "invalid-transcript" })),
  Result.getOrThrow,
);

/** Synchronous SQLite/SDK edge. The caller owns Database and the original model codec. */
export function nativeHistoryProjection(input: {
  readonly database: Database["Service"];
  readonly decodeMessages: (json: string) => ModelMessage[];
}) {
  const { database, decodeMessages } = input;
  database.atomic(() => database.sqlite.exec(historyProjectionSchema));
  const initial = database.sqlite.prepare(historyProjectionSnapshots.initial);
  const older = database.sqlite.prepare(historyProjectionSnapshots.older);
  const identities = database.sqlite.prepare(sql.groupIdentities);
  const removeInvalidOrdinals = database.sqlite.prepare(sql.removeInvalidOrdinals);
  const removeOrdinal = database.sqlite.prepare(sql.removeOrdinal);
  const removeTail = database.sqlite.prepare(sql.removeTail);
  const update = database.sqlite.prepare(sql.updateGroup);
  const publish = database.sqlite.prepare(sql.publishIfCurrent);
  const prepared = (snapshot: {
    threadId: string;
    sourceJSON: string;
    models?: readonly ModelMessage[];
  }) => {
    // Only the typed SDK writer supplies models; startup/import still validates
    // and decodes stored JSON. Avoid reparsing the writer's freshly serialized snapshot.
    if (snapshot.models === undefined) validateStored(snapshot.sourceJSON);
    const retained = Result.getOrThrow(
      Schema.decodeUnknownResult(Schema.Array(Schema.Struct({ ui_id: Schema.String })))(
        identities.all(snapshot.threadId),
      ),
    );
    const normalized = historyProjectionMessages(
      snapshot.threadId,
      snapshot.models ?? decodeMessages(snapshot.sourceJSON),
      retained.map((row) => row.ui_id),
    );
    switch (normalized.type) {
      case "id-collision":
        throw HistoryPageUnavailable.make({ reason: "id-collision" });
      case "ready":
        break;
    }
    const models = normalized.messages;
    for (const message of models) {
      switch (message.role) {
        case "user":
        case "assistant":
        case "tool":
          break;
        default:
          throw HistoryPageUnavailable.make({ reason: "invalid-transcript" });
      }
    }
    const grouping = groupHistoryMessages(snapshot.threadId, models);
    switch (grouping.type) {
      case "id-collision":
        throw HistoryPageUnavailable.make({ reason: "id-collision" });
      case "ready":
        return grouping.groups;
    }
  };
  const replace = (snapshot: {
    threadId: string;
    sourceJSON: string;
    models?: readonly ModelMessage[];
  }) => {
    const groups = prepared(snapshot);
    database.atomic(() => {
      database.sqlite.prepare(sql.markUnready).run(snapshot.threadId);
      // Disposable non-STRICT SQLite rows can contain fractional ordinals.
      // Repair them before decoding metadata, and discard out-of-window values.
      removeInvalidOrdinals.run(snapshot.threadId);
      removeTail.run(snapshot.threadId, groups.length);
      const existing = Result.getOrThrow(
        Schema.decodeUnknownResult(
          Schema.Array(Schema.Struct({ ordinal: Schema.Natural, ui_id: Schema.String })),
        )(identities.all(snapshot.threadId)),
      );
      // Delete only changed identities before upserting, so moved/swapped IDs
      // cannot collide with the unique cursor index. Unchanged JSON is not rewritten.
      for (const row of existing) {
        if (row.ordinal < groups.length && groups[row.ordinal]?.id !== row.ui_id)
          removeOrdinal.run(snapshot.threadId, row.ordinal);
      }
      for (const [ordinal, group] of groups.entries())
        update.run(snapshot.threadId, ordinal, group.id, JSON.stringify(group.messages));
      if (publish.run(snapshot.threadId, snapshot.sourceJSON).changes === 0)
        throw HistoryPageUnavailable.make({ reason: "not-ready" });
    });
  };
  return {
    // Explicit startup/import preparation, never a page-read fallback. Read one
    // unprepared original at a time, preserving the released authoritative table.
    prepare(threadId?: string) {
      const statement = database.sqlite
        .prepare(`SELECT thread_id FROM chat_threads WHERE (?1 IS NULL OR thread_id=?1) AND NOT EXISTS (
        SELECT 1 FROM chat_history_projection WHERE chat_history_projection.thread_id=chat_threads.thread_id AND ready=1 AND format_version=1
      )`);
      const pending = statement.all(threadId ?? null);
      const ids = Result.getOrThrow(
        Schema.decodeUnknownResult(Schema.Array(Schema.Struct({ thread_id: Schema.String })))(
          pending,
        ),
      );
      const select = database.sqlite.prepare(
        "SELECT thread_id, messages FROM chat_threads WHERE thread_id=?",
      );
      for (const { thread_id } of ids) {
        const snapshot = decodeThread(select.get(thread_id));
        try {
          replace({ threadId: snapshot.thread_id, sourceJSON: snapshot.messages });
        } catch (failure) {
          // A corrupt/ambiguous UI projection must not stop unrelated sessions.
          // Its original stays authoritative and reads report not-ready explicitly.
          if (Schema.is(HistoryPageUnavailable)(failure)) continue;
          throw failure;
        }
      }
    },
    // Called within the original writer's owner transaction immediately after
    // the authoritative upsert, so failure rolls back both original and projection.
    replace,
    load(request: HistoryPageRequest): MessagePage {
      const checked = decodeRequest(request);
      const raw =
        checked.type === "initial"
          ? initial.all(checked.threadId, checked.limit)
          : older.all(checked.threadId, checked.before, checked.limit);
      const rows = decodeRows(raw);
      const state = rows[0];
      if (state === undefined || state.ready !== 1 || state.format_version !== 1) {
        const exists = Result.getOrThrow(
          Schema.decodeUnknownResult(Schema.Struct({ present: Schema.Literals([0, 1]) }))(
            database.sqlite
              .prepare("SELECT EXISTS(SELECT 1 FROM chat_threads WHERE thread_id=?) AS present")
              .get(checked.threadId),
          ),
        );
        if (exists.present === 0) return { messages: [], truncated: false };
        throw HistoryPageUnavailable.make({ reason: "not-ready" });
      }
      if (state.cursor_valid === 0) return { messages: [], truncated: false };
      const selected = rows
        .filter((row) => row.ordinal !== null)
        .toSorted((a, b) => Number(a.ordinal) - Number(b.ordinal));
      const messages = selected.flatMap((row) =>
        row.messages === null ? [] : decodeMessages(row.messages),
      );
      if (state.has_earlier === 1) {
        const cursor = selected[0]?.ui_id;
        if (cursor === undefined || cursor.length === 0)
          throw HistoryPageUnavailable.make({ reason: "not-ready" });
        return { messages, truncated: true, cursor };
      }
      return { messages, truncated: false };
    },
  };
}
