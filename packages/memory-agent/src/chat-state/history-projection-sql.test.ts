import { DatabaseSync } from "node:sqlite";
import { modelMessagesToUIMessages, type ModelMessage } from "@tanstack/ai";
import { describe, expect, it } from "vite-plus/test";
import { groupHistoryMessages } from "./history-groups.ts";
import {
  historyProjectionRollback,
  historyProjectionSchema,
  historyProjectionSql as sql,
  historyProjectionSnapshots as snapshots,
} from "./history-projection-sql.ts";

// Copied from release 0.0.13 migrations.ts lines 121–125 / persistence.ts 176–178.
// An isolated writer contract fixture, not the complete release migration suite.
const releasedTable = `CREATE TABLE chat_threads (
  thread_id TEXT PRIMARY KEY,
  messages TEXT NOT NULL CHECK (json_valid(messages)),
  updated_at INTEGER NOT NULL
);`;
const releasedWriter =
  "INSERT INTO chat_threads VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET messages = excluded.messages, updated_at = excluded.updated_at";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`${releasedTable} PRAGMA user_version = 7; PRAGMA foreign_keys = OFF;`);
  db.exec(historyProjectionSchema);
  return db;
}

function publish(db: DatabaseSync, threadId: string, messages: ModelMessage[]) {
  const grouping = groupHistoryMessages(threadId, messages);
  switch (grouping.type) {
    case "id-collision":
      throw new Error(`Unexpected fixture collision: ${grouping.id}`);
    case "ready": {
      db.exec("SAVEPOINT history_fixture");
      try {
        db.prepare(releasedWriter).run(threadId, JSON.stringify(messages), 1);
        db.prepare(sql.removeGroups).run(threadId);
        const insert = db.prepare(sql.insertGroup);
        for (const [ordinal, group] of grouping.groups.entries()) {
          insert.run(threadId, ordinal, group.id, JSON.stringify(group.messages));
        }
        db.prepare(sql.publish).run(threadId);
        db.exec("RELEASE history_fixture");
      } catch (error) {
        db.exec("ROLLBACK TO history_fixture; RELEASE history_fixture");
        throw error;
      }
    }
  }
}

function parseFixtureMessages(text: string): ModelMessage[] {
  // SAFETY: only publish's JSON.stringify of typed ModelMessage[] populates this isolated fixture column.
  return JSON.parse(text) as ModelMessage[];
}

function transcript(count: number): ModelMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content: `${index}: ${"x".repeat(4096)}`,
  }));
}

describe("isolated history projection SQLite contract", () => {
  it("reads exactly the initial and older UI windows through indexes without a payload sentinel", () => {
    const db = fixture();
    try {
      const messages = transcript(400);
      publish(db, "a", messages);
      publish(db, "b", transcript(10));
      const initial = db.prepare(sql.initial).all("a", 50);
      expect(initial).toHaveLength(50);
      expect(initial.map((row) => row.ordinal)).toEqual(
        Array.from({ length: 50 }, (_, i) => 399 - i),
      );
      expect(db.prepare(sql.cursor).get("a", "message-350")?.ordinal).toBe(350);
      const older = db.prepare(sql.older).all("a", 350, 50);
      expect(older.map((row) => row.ordinal)).toEqual(
        Array.from({ length: 50 }, (_, i) => 349 - i),
      );
      expect(db.prepare(sql.hasEarlier).get("a", 350)?.has_earlier).toBe(1);
      expect(db.prepare(sql.hasEarlier).get("a", 0)?.has_earlier).toBe(0);
      // Actual returned JSON bytes/rows, separate from HTTP and browser UI cost.
      const originalBytes = Buffer.byteLength(JSON.stringify(messages));
      const selectedBytes = initial.reduce(
        (total, row) => total + Buffer.byteLength(String(row.messages)),
        0,
      );
      expect(selectedBytes).toBeLessThan(originalBytes / 7);
      for (const [query, bindings] of [
        [sql.initial, ["a", 50]],
        [sql.older, ["a", 350, 50]],
        [sql.cursor, ["a", "message-350"]],
        [sql.hasEarlier, ["a", 350]],
      ] as const) {
        const plan = db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...bindings);
        expect(
          plan.some((row) => String(row.detail).includes("SEARCH chat_history_groups USING")),
        ).toBe(true);
        expect(plan.some((row) => String(row.detail).includes("SCAN chat_history_groups"))).toBe(
          false,
        );
        expect(plan.some((row) => String(row.detail).includes("TEMP B-TREE"))).toBe(false);
      }
    } finally {
      db.close();
    }
  });

  it("reads readiness, cursor and exactly the selected payload in one indexed snapshot", () => {
    const db = fixture();
    try {
      publish(db, "a", transcript(400));
      const initial = db.prepare(snapshots.initial).all("a", 50);
      const older = db.prepare(snapshots.older).all("a", "message-350", 50);
      for (const [rows, expected] of [
        [initial, db.prepare(sql.initial).all("a", 50)],
        [older, db.prepare(sql.older).all("a", 350, 50)],
      ]) {
        expect(rows).toHaveLength(50);
        expect(
          rows.every(
            (row) =>
              row.ready === 1 &&
              row.format_version === 1 &&
              row.cursor_valid === 1 &&
              row.has_earlier === 1,
          ),
        ).toBe(true);
        const ordered = rows.toSorted((a, b) => Number(a.ordinal) - Number(b.ordinal));
        expect(ordered.map((row) => row.messages)).toEqual(
          expected.toReversed().map((row) => row.messages),
        );
        expect(
          rows.reduce((bytes, row) => bytes + Buffer.byteLength(String(row.messages)), 0),
        ).toBeLessThan(Buffer.byteLength(JSON.stringify(transcript(400))) / 7);
      }
      for (const [query, bindings] of [
        [snapshots.initial, ["a", 50]],
        [snapshots.older, ["a", "message-350", 50]],
      ] as const) {
        const plan = db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...bindings);
        expect(
          plan.some((row) => String(row.detail).includes("SEARCH chat_history_groups USING")),
        ).toBe(true);
        expect(plan.some((row) => String(row.detail).includes("SCAN chat_history_groups"))).toBe(
          false,
        );
        expect(plan.some((row) => String(row.detail).includes("chat_threads"))).toBe(false);
      }
    } finally {
      db.close();
    }
  });

  it("distinguishes unprepared, stale, unknown cursors and valid empty pages without payload", () => {
    const db = fixture();
    try {
      expect(db.prepare(snapshots.initial).all("missing", 50)).toEqual([
        {
          ready: 0,
          format_version: 0,
          cursor_valid: 1,
          ordinal: null,
          ui_id: null,
          messages: null,
          has_earlier: 0,
        },
      ]);
      publish(db, "empty", []);
      expect(db.prepare(snapshots.initial).all("empty", 50)).toEqual([
        {
          ready: 1,
          format_version: 1,
          cursor_valid: 1,
          ordinal: null,
          ui_id: null,
          messages: null,
          has_earlier: 0,
        },
      ]);
      publish(db, "a", transcript(5));
      expect(db.prepare(snapshots.older).all("a", "unknown", 50)).toEqual([
        {
          ready: 1,
          format_version: 1,
          cursor_valid: 0,
          ordinal: null,
          ui_id: null,
          messages: null,
          has_earlier: 0,
        },
      ]);
      expect(db.prepare(snapshots.older).all("a", "message-0", 50)).toEqual([
        {
          ready: 1,
          format_version: 1,
          cursor_valid: 1,
          ordinal: null,
          ui_id: null,
          messages: null,
          has_earlier: 0,
        },
      ]);
      db.prepare(releasedWriter).run("a", JSON.stringify(transcript(6)), 1);
      const stale = db.prepare(snapshots.older).all("a", "message-4", 50);
      expect(stale).toHaveLength(1);
      expect(stale[0]).toMatchObject({ ready: 0, cursor_valid: 1, messages: null, has_earlier: 0 });
      publish(db, "a", transcript(6));
      expect(db.prepare(snapshots.older).all("a", "message-4", 50)).toHaveLength(4);
    } finally {
      db.close();
    }
  });

  it("preserves SDK page results, tool details and retained UI-ID cursors", () => {
    const db = fixture();
    try {
      const messages: ModelMessage[] = [
        { id: "user", role: "user", content: "Question" },
        {
          id: "assistant",
          role: "assistant",
          content: "Checking",
          toolCalls: [
            { id: "call", type: "function", function: { name: "read", arguments: "{}" } },
          ],
        },
        { id: "orphan", role: "tool", content: "Standalone" },
        { id: "result", role: "tool", toolCallId: "call", content: "Detail", error: "read failed" },
        { id: "assistant-segment-1", role: "assistant", content: "Done" },
        { id: "last", role: "user", content: "Next" },
      ];
      publish(db, "a", messages);
      const fullUI = modelMessagesToUIMessages(messages);
      const initial = db.prepare(sql.initial).all("a", 2).reverse();
      const pageModels = initial.flatMap((row) => parseFixtureMessages(String(row.messages)));
      expect(modelMessagesToUIMessages(pageModels)).toEqual(fullUI.slice(-2));
      const cursor = String(initial[0]?.ui_id);
      const ordinal = db.prepare(sql.cursor).get("a", cursor)?.ordinal;
      const older = db.prepare(sql.older).all("a", ordinal!, 2).reverse();
      expect(
        modelMessagesToUIMessages(
          older.flatMap((row) => parseFixtureMessages(String(row.messages))),
        ),
      ).toEqual(fullUI.slice(0, -2));
      expect(db.prepare(sql.cursor).get("b", cursor)).toBeUndefined();
      expect(db.prepare(sql.cursor).get("a", "nonexistent")).toBeUndefined();
      expect(
        db.prepare("SELECT messages FROM chat_threads WHERE thread_id = ?").get("a")?.messages,
      ).toBe(JSON.stringify(messages));
    } finally {
      db.close();
    }
  });

  it("invalidates old-writer updates even with the same timestamp and cleans deleted threads", () => {
    const db = fixture();
    try {
      publish(db, "a", transcript(10));
      expect(db.prepare(sql.readiness).get("a")?.ready).toBe(1);
      db.prepare(releasedWriter).run("a", JSON.stringify(transcript(11)), 1);
      expect(db.prepare(sql.readiness).get("a")?.ready).toBe(0);
      expect(db.prepare(sql.initial).all("a", 50)).toEqual([]);
      expect(db.prepare(sql.older).all("a", 5, 50)).toEqual([]);
      // Republish after an append; an existing UI-ID cursor still points at the same prefix.
      publish(db, "a", transcript(11));
      expect(db.prepare(sql.cursor).get("a", "message-5")?.ordinal).toBe(5);
      expect(
        db
          .prepare(sql.older)
          .all("a", 5, 50)
          .map((row) => row.ui_id),
      ).toEqual(["message-4", "message-3", "message-2", "message-1", "message-0"]);
      db.prepare("DELETE FROM chat_threads WHERE thread_id = ?").run("a");
      expect(db.prepare(sql.readiness).get("a")).toBeUndefined();
      expect(db.prepare(sql.initial).all("a", 50)).toEqual([]);
      expect(db.prepare(sql.cursor).get("a", "message-5")).toBeUndefined();
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM chat_history_groups WHERE thread_id = ?").get("a")
          ?.count,
      ).toBe(0);
      db.prepare(releasedWriter).run("a", JSON.stringify(transcript(2)), 1);
      expect(db.prepare(sql.readiness).get("a")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("invalidates previously staged readiness when the original is inserted", () => {
    const db = fixture();
    try {
      db.prepare(sql.publish).run("staged");
      db.prepare(sql.insertGroup).run("staged", 0, "orphan", JSON.stringify(transcript(1)));
      expect(db.prepare(sql.readiness).get("staged")?.ready).toBe(1);
      db.prepare(releasedWriter).run("staged", JSON.stringify(transcript(2)), 1);
      expect(db.prepare(sql.readiness).get("staged")?.ready).toBe(0);
      expect(db.prepare(sql.initial).all("staged", 50)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("handles empty ready projections and exact cursor endpoints and partial pages", () => {
    const db = fixture();
    try {
      publish(db, "empty", []);
      expect(db.prepare(sql.readiness).get("empty")?.ready).toBe(1);
      expect(db.prepare(sql.initial).all("empty", 50)).toEqual([]);
      publish(db, "partial", transcript(7));
      expect(db.prepare(sql.initial).all("partial", 50)).toHaveLength(7);
      expect(db.prepare(sql.cursor).get("partial", "message-0")?.ordinal).toBe(0);
      expect(db.prepare(sql.older).all("partial", 0, 50)).toEqual([]);
      expect(
        db
          .prepare(sql.older)
          .all("partial", 4, 50)
          .map((row) => row.ordinal),
      ).toEqual([3, 2, 1, 0]);
      expect(db.prepare(sql.hasEarlier).get("partial", 0)?.has_earlier).toBe(0);
    } finally {
      db.close();
    }
  });

  it("keeps original and projection atomic on publication failure", () => {
    const db = fixture();
    try {
      const original = transcript(10);
      publish(db, "a", original);
      db.exec(
        "CREATE TRIGGER reject_history_fixture BEFORE INSERT ON chat_history_groups BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;",
      );
      expect(() => publish(db, "a", transcript(11))).toThrow();
      expect(
        db.prepare("SELECT messages FROM chat_threads WHERE thread_id = ?").get("a")?.messages,
      ).toBe(JSON.stringify(original));
      expect(db.prepare(sql.readiness).get("a")?.ready).toBe(1);
      expect(db.prepare(sql.initial).all("a", 50)).toHaveLength(10);
    } finally {
      db.close();
    }
  });

  it("publishes a backfill only for the unchanged source and rolls back stale staged rows", () => {
    const db = fixture();
    try {
      const original = transcript(5);
      const source = JSON.stringify(original);
      publish(db, "a", original);
      const grouping = groupHistoryMessages("a", original);
      expect(grouping.type).toBe("ready");
      switch (grouping.type) {
        case "id-collision":
          throw new Error("Unexpected fixture collision");
        case "ready": {
          const replaceFromSnapshot = () => {
            db.prepare(sql.markUnready).run("a");
            db.prepare(sql.removeGroups).run("a");
            for (const [ordinal, group] of grouping.groups.entries()) {
              db.prepare(sql.insertGroup).run(
                "a",
                ordinal,
                group.id,
                JSON.stringify(group.messages),
              );
            }
            return db.prepare(sql.publishIfCurrent).run("a", source).changes;
          };
          db.exec("SAVEPOINT backfill_fixture");
          expect(replaceFromSnapshot()).toBe(1);
          db.exec("RELEASE backfill_fixture");
          expect(db.prepare(sql.initial).all("a", 50)).toHaveLength(5);

          // A newer complete projection arrives while the older source is being prepared.
          // Timestamp remains identical; checking updated_at alone would accept stale data.
          const latest = transcript(6);
          publish(db, "a", latest);
          db.exec("SAVEPOINT backfill_fixture");
          expect(replaceFromSnapshot()).toBe(0);
          expect(db.prepare(sql.readiness).get("a")?.ready).toBe(0);
          expect(db.prepare(sql.initial).all("a", 50)).toEqual([]);
          db.exec("ROLLBACK TO backfill_fixture; RELEASE backfill_fixture");
          expect(db.prepare(sql.readiness).get("a")?.ready).toBe(1);
          expect(db.prepare(sql.initial).all("a", 50)).toHaveLength(6);
          expect(
            db.prepare("SELECT messages FROM chat_threads WHERE thread_id = ?").get("a")?.messages,
          ).toBe(JSON.stringify(latest));

          // A source removed during preparation must not be resurrected by backfill.
          db.prepare("DELETE FROM chat_threads WHERE thread_id = ?").run("a");
          db.exec("SAVEPOINT backfill_fixture");
          expect(replaceFromSnapshot()).toBe(0);
          db.exec("ROLLBACK TO backfill_fixture; RELEASE backfill_fixture");
          expect(db.prepare(sql.readiness).get("a")).toBeUndefined();
          expect(db.prepare(sql.cursor).get("a", "message-0")).toBeUndefined();
          expect(db.prepare(sql.initial).all("a", 50)).toEqual([]);
        }
      }
    } finally {
      db.close();
    }
  });

  it("is disposable without changing global migration version or the released writer", () => {
    const db = fixture();
    try {
      publish(db, "a", transcript(5));
      db.exec(historyProjectionSchema); // Idempotent preparation.
      expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(7);
      db.exec(historyProjectionRollback);
      db.exec(historyProjectionRollback); // Idempotent rollback.
      expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(7);
      const next = transcript(6);
      db.prepare(releasedWriter).run("a", JSON.stringify(next), 2);
      expect(
        db.prepare("SELECT messages FROM chat_threads WHERE thread_id = ?").get("a")?.messages,
      ).toBe(JSON.stringify(next));
      expect(
        db
          .prepare("PRAGMA table_info(chat_threads)")
          .all()
          .map((row) => row.name),
      ).toEqual(["thread_id", "messages", "updated_at"]);
    } finally {
      db.close();
    }
  });
});
