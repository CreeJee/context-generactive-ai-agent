import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import type { StoredMessage } from "../chat-store/schema.ts";
import { groupHistoryMessages, HistoryGroupingResult } from "./history-groups.ts";
import {
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

function publish(db: DatabaseSync, threadId: string, messages: StoredMessage[]) {
  const groups = HistoryGroupingResult.$match(groupHistoryMessages(threadId, messages), {
    "id-collision": ({ id }) => {
      throw new Error(`Unexpected fixture collision: ${id}`);
    },
    ready: ({ groups }) => groups,
  });
  db.exec("SAVEPOINT history_fixture");
  try {
    db.prepare(releasedWriter).run(threadId, JSON.stringify(messages), 1);
    db.prepare(sql.removeGroups).run(threadId);
    const insert = db.prepare(sql.insertGroup);
    groups.forEach((group, ordinal) =>
      insert.run(threadId, ordinal, group.id, JSON.stringify(group.messages)),
    );
    db.prepare(sql.publish).run(threadId);
    db.exec("RELEASE history_fixture");
  } catch (error) {
    db.exec("ROLLBACK TO history_fixture; RELEASE history_fixture");
    throw error;
  }
}

function transcript(count: number): StoredMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content: `${index}: ${"x".repeat(4096)}`,
  }));
}

describe("isolated history projection SQLite contract", () => {
  it("reads readiness, cursor and exactly the selected payload in one indexed snapshot", () => {
    const db = fixture();
    try {
      publish(db, "a", transcript(400));
      const initial = db.prepare(snapshots.initial).all("a", 50);
      const older = db.prepare(snapshots.older).all("a", "message-350", 50);
      [
        [initial, db.prepare(sql.initial).all("a", 50)],
        [older, db.prepare(sql.older).all("a", 350, 50)],
      ].forEach(([rows, expected]) => {
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
      });
      (
        [
          [snapshots.initial, ["a", 50]],
          [snapshots.older, ["a", "message-350", 50]],
        ] as const
      ).forEach(([query, bindings]) => {
        const plan = db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...bindings);
        expect(
          plan.some((row) => String(row.detail).includes("SEARCH chat_history_groups USING")),
        ).toBe(true);
        expect(plan.some((row) => String(row.detail).includes("SCAN chat_history_groups"))).toBe(
          false,
        );
        expect(plan.some((row) => String(row.detail).includes("chat_threads"))).toBe(false);
      });
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

  it("publishes a backfill only for the unchanged source and rolls back stale staged rows", () => {
    const db = fixture();
    try {
      const original = transcript(5);
      const source = JSON.stringify(original);
      publish(db, "a", original);
      const grouping = groupHistoryMessages("a", original);
      expect(HistoryGroupingResult.$is("ready")(grouping)).toBe(true);
      const groups = HistoryGroupingResult.$match(grouping, {
        "id-collision": () => {
          throw new Error("Unexpected fixture collision");
        },
        ready: ({ groups }) => groups,
      });
      const replaceFromSnapshot = () => {
        db.prepare(sql.markUnready).run("a");
        db.prepare(sql.removeGroups).run("a");
        groups.forEach((group, ordinal) =>
          db.prepare(sql.insertGroup).run("a", ordinal, group.id, JSON.stringify(group.messages)),
        );
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
    } finally {
      db.close();
    }
  });

  it("prepares idempotently without changing global migration version or the released writer", () => {
    const db = fixture();
    try {
      publish(db, "a", transcript(5));
      db.exec(historyProjectionSchema); // Idempotent preparation.
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
