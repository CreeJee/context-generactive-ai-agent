import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import { StoredMessage } from "../chat-store/schema.ts";
import { Database } from "../db/database.ts";
import { RunStore } from "../loop/store.ts";
import { displayMessages } from "./display-messages.ts";
import {
  HistoryPageRequest,
  HistoryPageSnapshot,
  HistoryPageUnavailable,
  historyPageQueries,
} from "./history-pages.ts";
import { chatSnapshot } from "./snapshot.ts";
import { sqlAll, sqlExec, sqlGet, sqlRun } from "../../tests/support/sql.ts";
import { threadRevision, threadText, writeThread } from "../../tests/support/chat-thread.ts";

const encodeThread = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(StoredMessage)));
const encodeMessage = Schema.encodeEffect(Schema.fromJsonString(StoredMessage));
const request = HistoryPageRequest.cases;
const snapshot = HistoryPageSnapshot.cases;

const fixture = <A, E>(program: Effect.Effect<A, E, RunStore | SqlClient.SqlClient>) =>
  Effect.scoped(
    Effect.flatMap(
      Layer.build(RunStore.layer.pipe(Layer.provideMerge(Database.layer(":memory:")))),
      (context) => Effect.provideContext(program, context),
    ),
  );

/** What `ChatState` does at startup, or for `threadId` after an import. */
const prepare = (threadId?: string) =>
  Effect.flatMap(displayMessages, (display) => display.prepare(threadId));

/** The ids of the messages a page shows, and the cursor of the page before it. */
const page = (threadId: string, limit: number, before?: string) =>
  Effect.map(chatSnapshot(threadId, limit, before), ({ messages, older }) => ({
    ids: messages.map((message) => message.id),
    older,
  }));

/** The thread's shown messages as stored. */
const displayRows = (threadId: string) =>
  sqlAll(
    `SELECT seq, display_id, first_message_seq FROM chat_thread_display_messages
      WHERE thread_id = ? ORDER BY seq`,
    threadId,
  );

const users = (count: number, size = 0): StoredMessage[] =>
  Array.from({ length: count }, (_, seq) => ({
    id: `m-${seq}`,
    role: "user",
    content: `${seq}: ${"x".repeat(size)}`,
  }));

describe("history pages", () => {
  it.effect("read only their own messages, through the indexes, and keep the whole thread", () =>
    Effect.gen(function* () {
      const store = yield* RunStore;
      const messages = users(400, 4096);
      yield* store.saveThread("a", messages);
      const whole = yield* encodeThread(messages);
      yield* Effect.acquireUseRelease(
        Effect.sync(() => vi.spyOn(JSON, "parse")),
        (parse) =>
          Effect.gen(function* () {
            const initial = yield* page("a", 20);
            expect(initial.ids).toEqual(Array.from({ length: 20 }, (_, i) => `m-${380 + i}`));
            expect(initial.older).toBe("m-380");
            const older = yield* page("a", 20, "m-380");
            expect(older.ids[0]).toBe("m-360");
            expect(older.ids).toHaveLength(20);
            expect(parse.mock.calls.some(([json]) => json === whole)).toBe(false);
          }),
        (parse) => Effect.sync(() => parse.mockRestore()),
      );
      const reads = [
        { query: historyPageQueries.initial, bindings: ["a", 50] },
        { query: historyPageQueries.older, bindings: ["a", "m-350", 50] },
      ] as const;
      yield* Effect.forEach(
        reads,
        Effect.fnUntraced(function* ({ query, bindings }) {
          const rows = yield* sqlAll(query, ...bindings);
          expect(rows).toHaveLength(50);
          expect(rows.every((row) => row.is_current === 1 && row.has_earlier === 1)).toBe(true);
          expect(rows.reduce((bytes, row) => bytes + String(row.messages).length, 0)).toBeLessThan(
            whole.length / 7,
          );
          const plan = yield* sqlAll(`EXPLAIN QUERY PLAN ${query}`, ...bindings);
          const details = plan.map((row) => String(row.detail));
          expect(
            details.some((detail) => /^SCAN (chat_\w+|thread|m|n|cursor)\b/.test(detail)),
          ).toBe(false);
        }),
        { discard: true },
      );
      expect(yield* store.thread("a")).toEqual(messages);
    }).pipe(fixture),
  );

  it.effect("tell a missing, stale or unknown page from an empty one", () =>
    Effect.gen(function* () {
      const store = yield* RunStore;
      expect(
        yield* store.historyPage(request.initial.make({ threadId: "missing", limit: 3 })),
      ).toEqual(snapshot["not-ready"].make({ reason: "unprepared" }));
      yield* store.saveThread("a", users(2));
      expect(
        yield* store.historyPage(
          request.older.make({ threadId: "a", before: "unknown", limit: 3 }),
        ),
      ).toEqual(snapshot["unknown-cursor"].make({}));
      expect(
        yield* store.historyPage(request.older.make({ threadId: "a", before: "m-0", limit: 3 })),
      ).toEqual(snapshot.page.make({ shown: [], truncated: false, nextCursor: null }));
      // Another writer's change leaves the pages behind until they are built again.
      yield* writeThread({ threadId: "a", messages: "[]" });
      expect(yield* store.historyPage(request.initial.make({ threadId: "a", limit: 3 }))).toEqual(
        snapshot["not-ready"].make({ reason: "stale" }),
      );
      expect(yield* Effect.flip(page("a", 3))).toBeInstanceOf(HistoryPageUnavailable);
      yield* store.saveThread("a", []);
      expect(yield* store.historyPage(request.initial.make({ threadId: "a", limit: 3 }))).toEqual(
        snapshot.page.make({ shown: [], truncated: false, nextCursor: null }),
      );
      // A thread never saved has nothing to show.
      expect(yield* page("new", 20)).toEqual({ ids: [], older: null });
    }).pipe(fixture),
  );

  it.effect("are built at startup for threads written without them", () =>
    Effect.gen(function* () {
      const store = yield* RunStore;
      const legacy = yield* encodeThread([
        { role: "user", content: "Old" },
        { role: "assistant", content: "Reply" },
      ]);
      yield* writeThread({ threadId: "a", messages: legacy });
      const repeated: StoredMessage[] = [
        { id: "user", role: "user", content: "Question" },
        { id: "answer", role: "assistant", content: "Checking" },
        { role: "tool", toolCallId: "call", content: "Result" },
        { id: "answer", role: "assistant", content: "Done" },
        { id: "next", role: "user", content: "Follow-up" },
      ];
      yield* writeThread({ threadId: "b", messages: yield* encodeThread(repeated) });
      // A message the pages cannot place keeps its thread without pages, and not the others.
      yield* writeThread({ threadId: "c", messages: '[{"role":"system","content":"?"}]' });
      yield* prepare();
      expect(yield* page("a", 1)).toEqual({ ids: ["stored:a:1"], older: "stored:a:1" });
      expect(yield* page("a", 1, "stored:a:1")).toEqual({ ids: ["stored:a:0"], older: null });
      expect(yield* threadText("a")).toBe(legacy);
      expect(yield* page("b", 1)).toEqual({ ids: ["next"], older: "next" });
      expect(yield* page("b", 1, "next")).toEqual({ ids: ["answer"], older: "answer" });
      expect(yield* page("b", 1, "answer")).toEqual({ ids: ["user"], older: null });
      expect(yield* Effect.flip(page("c", 1))).toBeInstanceOf(HistoryPageUnavailable);
      // A save of the unchanged thread keeps its pages.
      yield* store.saveThread("b", repeated);
      expect(yield* page("b", 20)).toEqual({ ids: ["user", "answer", "next"], older: null });
      // A thread changed by another writer is built again from its rows.
      yield* writeThread({
        threadId: "b",
        messages: yield* encodeThread([{ id: "u", role: "user", content: "Changed" }]),
      });
      yield* prepare("b");
      expect((yield* chatSnapshot("b", 20, undefined)).messages).toEqual([
        { id: "u", role: "user", parts: [{ type: "text", content: "Changed" }] },
      ]);
    }).pipe(fixture),
  );

  it.effect("give an appended message whose id is taken a fallback, and keep the earlier ids", () =>
    Effect.gen(function* () {
      const store = yield* RunStore;
      const messages: StoredMessage[] = [
        { role: "assistant", content: "Legacy answer" },
        { id: "user", role: "user", content: "Next question" },
        { id: "stored:a:0", role: "assistant", content: "Unrelated answer" },
      ];
      yield* writeThread({ threadId: "a", messages: yield* encodeThread(messages) });
      yield* prepare();
      const ids = ["stored:a:0:fallback:0", "user", "stored:a:0"];
      expect(yield* page("a", 20)).toEqual({ ids, older: null });
      yield* store.saveThread("a", [
        ...messages,
        { id: "stored:a:0:fallback:0", role: "user", content: "Taken" },
        { id: "user", role: "user", content: "Taken too" },
      ]);
      expect(yield* page("a", 20)).toEqual({
        ids: [...ids, "stored:a:0:fallback:0:fallback:0", "user:fallback:0"],
        older: null,
      });
    }).pipe(fixture),
  );

  it.effect("are written again only from the shown message the first change is in", () =>
    Effect.gen(function* () {
      const store = yield* RunStore;
      const call = { id: "call", type: "function", function: { name: "read", arguments: "{}" } };
      const question: StoredMessage = { id: "u", role: "user", content: "Question" };
      const answer: StoredMessage = {
        id: "a",
        role: "assistant",
        content: "Checking",
        toolCalls: [{ ...call, type: "function" }],
      };
      yield* store.saveThread("a", [...users(30), question, answer]);
      yield* sqlExec(`
        CREATE TABLE display_writes (operation TEXT, seq INTEGER, display_id TEXT);
        CREATE TRIGGER display_insert AFTER INSERT ON chat_thread_display_messages
        BEGIN INSERT INTO display_writes VALUES ('insert', NEW.seq, NEW.display_id); END;
        CREATE TRIGGER display_delete AFTER DELETE ON chat_thread_display_messages
        BEGIN INSERT INTO display_writes VALUES ('delete', OLD.seq, OLD.display_id); END;
      `);
      const writes = Effect.tap(
        sqlAll("SELECT operation, seq, display_id FROM display_writes ORDER BY rowid"),
        () => sqlRun("DELETE FROM display_writes"),
      );
      const result: StoredMessage = { role: "tool", toolCallId: "call", content: "Result" };
      // Unchanged, or a result the answer holds: nothing shown begins or ends.
      yield* store.saveThread("a", [...users(30), question, answer]);
      expect(yield* writes).toEqual([]);
      yield* store.saveThread("a", [...users(30), question, answer, result]);
      expect(yield* writes).toEqual([]);
      // The answer's next segment of text is a new shown message.
      const next: StoredMessage = { id: "b", role: "assistant", content: "Done" };
      yield* store.saveThread("a", [...users(30), question, answer, result, next]);
      expect(yield* writes).toEqual([{ operation: "insert", seq: 32, display_id: "b" }]);
      // A step that ends without the answer its snapshot saved.
      yield* store.saveThread("a", [...users(30), question, answer, result]);
      expect(yield* writes).toEqual([{ operation: "delete", seq: 32, display_id: "b" }]);
      expect((yield* displayRows("a")).slice(-2)).toEqual([
        { seq: 30, display_id: "u", first_message_seq: 30 },
        { seq: 31, display_id: "a", first_message_seq: 31 },
      ]);
      // Moved ids are written again without colliding on the unique index.
      yield* store.saveThread("a", [answer, question]);
      expect(yield* page("a", 20)).toEqual({ ids: ["a", "u"], older: null });
    }).pipe(fixture),
  );

  it.effect("show what the secret sweep hid, and stay current while it keeps roles and ids", () =>
    Effect.gen(function* () {
      const store = yield* RunStore;
      yield* store.saveThread("a", [
        { id: "u", role: "user", content: "token: secret" },
        { id: "b", role: "assistant", content: "Done" },
      ]);
      yield* sqlRun(
        "UPDATE chat_thread_messages SET message = ? WHERE thread_id = 'a' AND seq = 0",
        yield* encodeMessage({ id: "u", role: "user", content: "token: [redacted]" }),
      );
      expect((yield* chatSnapshot("a", 20, undefined)).messages[0]).toEqual({
        id: "u",
        role: "user",
        parts: [{ type: "text", content: "token: [redacted]" }],
      });
      // A change to an id is a change to what is shown.
      yield* sqlRun(
        "UPDATE chat_thread_messages SET message = ? WHERE thread_id = 'a' AND seq = 1",
        yield* encodeMessage({ id: "c", role: "assistant", content: "Done" }),
      );
      expect(yield* Effect.flip(page("a", 20))).toBeInstanceOf(HistoryPageUnavailable);
      yield* prepare("a");
      expect(yield* page("a", 20)).toEqual({ ids: ["u", "c"], older: null });
    }).pipe(fixture),
  );

  it.effect("roll back with the save that wrote them, and go with their thread", () =>
    Effect.gen(function* () {
      const store = yield* RunStore;
      const original = users(1);
      yield* store.saveThread("a", original);
      yield* sqlExec(`
        CREATE TRIGGER display_fails BEFORE INSERT ON chat_thread_display_messages
        BEGIN SELECT RAISE(ABORT, 'fixture'); END;
      `);
      yield* Effect.flip(store.saveThread("a", users(2)));
      expect(yield* store.thread("a")).toEqual(original);
      expect(yield* page("a", 20)).toEqual({ ids: ["m-0"], older: null });
      yield* sqlRun("DELETE FROM chat_threads WHERE thread_id = ?", "a");
      expect(yield* displayRows("a")).toEqual([]);
      expect(yield* page("a", 20)).toEqual({ ids: [], older: null });
    }).pipe(fixture),
  );

  it.effect("never give a thread a revision an earlier transcript of it had", () =>
    Effect.gen(function* () {
      const store = yield* RunStore;
      yield* store.saveThread("a", users(1));
      const first = yield* threadRevision("a");
      yield* writeThread({ threadId: "a", messages: yield* encodeThread(users(2)) });
      const second = yield* threadRevision("a");
      yield* sqlRun("DELETE FROM chat_threads WHERE thread_id = ?", "a");
      yield* store.saveThread("a", users(1));
      expect(new Set([first, second, yield* threadRevision("a")]).size).toBe(3);
      expect(
        yield* sqlGet("SELECT display_revision = revision AS current FROM chat_threads"),
      ).toEqual({ current: 1 });
    }).pipe(fixture),
  );
});
