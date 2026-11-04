import { Clock, Effect, Layer, Schema } from "effect";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { StoredMessage } from "../chat-store/schema.ts";
import { Database } from "../db/database.ts";
import { migrations } from "../db/migrations.ts";
import { RunStore } from "../loop/store.ts";
import { historyProjection, HistoryPageUnavailable } from "./history-projection-native.ts";
import { historyProjectionSnapshots as snapshots } from "./history-projection-sql.ts";
import { chatSnapshot } from "./snapshot.ts";
import { sqlAll, sqlGet, sqlRun } from "../../tests/support/sql.ts";
import { threadRevision, threadText, writeThread } from "../../tests/support/chat-thread.ts";
/** The thread's text as `RunStore` saves it. */
const encodeThread = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(StoredMessage)));

// `historyProjection` itself needs Crypto where a test makes one.
const fixture = provideFixture(
  RunStore.layer.pipe(
    Layer.provideMerge(Layer.merge(Database.layer(":memory:"), NodeCrypto.layer)),
  ),
);

/** The ids of the messages a page shows, and the cursor of the page before it. */
const page = (threadId: string, limit: number, before?: string) =>
  Effect.map(chatSnapshot(threadId, limit, before), ({ messages, older }) => ({
    ids: messages.map((message) => message.id),
    older,
  }));

const groupCount = (threadId: string) =>
  sqlGet("SELECT COUNT(*) AS count FROM chat_history_groups WHERE thread_id = ?", threadId);

function transcript(count: number): StoredMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content: `${index}: ${"x".repeat(4096)}`,
  }));
}

describe("history projection SQLite contract", () => {
  it.effect("reads readiness, cursor and exactly the selected groups in one indexed snapshot", () =>
    Effect.gen(function* () {
      const store = yield* RunStore;
      const messages = transcript(400);
      yield* store.saveThread("a", messages);
      const whole = Buffer.byteLength(yield* encodeThread(messages));
      const reads = [
        { query: snapshots.initial, bindings: ["a", 50], first: 350 },
        { query: snapshots.older, bindings: ["a", "message-350", 50], first: 300 },
      ] as const;
      yield* Effect.forEach(
        reads,
        Effect.fnUntraced(function* ({ query, bindings, first }) {
          const rows = yield* sqlAll(query, ...bindings);
          expect(
            rows.every(
              (row) =>
                row.ready === 1 &&
                row.format_version === 1 &&
                row.cursor_valid === 1 &&
                row.has_earlier === 1,
            ),
          ).toBe(true);
          expect(
            rows.toSorted((a, b) => Number(a.ordinal) - Number(b.ordinal)).map((row) => row.ui_id),
          ).toEqual(Array.from({ length: 50 }, (_, index) => `message-${first + index}`));
          expect(
            rows.reduce((bytes, row) => bytes + Buffer.byteLength(String(row.messages)), 0),
          ).toBeLessThan(whole / 7);
          const plan = yield* sqlAll(`EXPLAIN QUERY PLAN ${query}`, ...bindings);
          const details = plan.map((row) => String(row.detail));
          expect(
            details.some((detail) => detail.includes("SEARCH chat_history_groups USING")),
          ).toBe(true);
          expect(details.some((detail) => detail.includes("SCAN chat_history_groups"))).toBe(false);
          expect(details.some((detail) => detail.includes("chat_threads"))).toBe(false);
        }),
        { discard: true },
      );
    }).pipe(fixture),
  );

  it.effect(
    "invalidates other writers' saves even with the same timestamp and cleans deleted threads",
    () =>
      Effect.gen(function* () {
        const store = yield* RunStore;
        yield* store.saveThread("a", transcript(10));
        // The time `saveThread` wrote; the other writer reuses it.
        const updatedAt = yield* Clock.currentTimeMillis;
        yield* writeThread({
          threadId: "a",
          messages: yield* encodeThread(transcript(11)),
          updatedAt,
        });
        expect(yield* Effect.flip(page("a", 50))).toBeInstanceOf(HistoryPageUnavailable);
        // Saved again after an append; an existing UI-ID cursor still points at the same prefix.
        yield* store.saveThread("a", transcript(11));
        expect(yield* page("a", 50, "message-5")).toEqual({
          ids: ["message-0", "message-1", "message-2", "message-3", "message-4"],
          older: null,
        });
        yield* sqlRun("DELETE FROM chat_threads WHERE thread_id = ?", "a");
        expect(yield* page("a", 50)).toEqual({ ids: [], older: null });
        expect(yield* groupCount("a")).toEqual({ count: 0 });
        // Written again without its projection, the thread has no stale ready pages.
        yield* writeThread({
          threadId: "a",
          messages: yield* encodeThread(transcript(2)),
          updatedAt,
        });
        expect(yield* Effect.flip(page("a", 50))).toBeInstanceOf(HistoryPageUnavailable);
      }).pipe(fixture),
  );

  it.effect("publishes a preparation only for the unchanged source and rolls back stale rows", () =>
    Effect.gen(function* () {
      const store = yield* RunStore;
      const projection = yield* historyProjection();
      const original = transcript(5);
      yield* store.saveThread("a", original);
      // What `prepare` read before the thread was saved again: replacing the pages from it fails
      // and keeps the newer pages.
      const source = { threadId: "a", revision: yield* threadRevision("a"), messages: original };
      yield* store.saveThread("a", transcript(6));
      expect(yield* Effect.flip(projection.replace(source))).toMatchObject({ reason: "not-ready" });
      expect((yield* page("a", 50)).ids).toHaveLength(6);

      // A source removed during preparation must not be resurrected by it.
      yield* sqlRun("DELETE FROM chat_threads WHERE thread_id = ?", "a");
      yield* Effect.flip(projection.replace(source));
      expect(yield* groupCount("a")).toEqual({ count: 0 });
      expect(yield* page("a", 50)).toEqual({ ids: [], older: null });
    }).pipe(fixture),
  );

  it.effect("never gives a thread a revision an earlier transcript of it had", () =>
    Effect.gen(function* () {
      const store = yield* RunStore;
      const projection = yield* historyProjection();
      yield* store.saveThread("a", transcript(1));
      const first = yield* threadRevision("a");
      // The writers that do not replace the pages change it too.
      yield* writeThread({ threadId: "a", messages: yield* encodeThread(transcript(2)) });
      const second = yield* threadRevision("a");
      yield* sqlRun("DELETE FROM chat_threads WHERE thread_id = ?", "a");
      yield* store.saveThread("a", transcript(1));
      const third = yield* threadRevision("a");
      expect(new Set([first, second, third]).size).toBe(3);
      // The first transcript's pages are not published over the thread saved again.
      expect(
        yield* Effect.flip(
          projection.replace({ threadId: "a", revision: first, messages: transcript(1) }),
        ),
      ).toMatchObject({ reason: "not-ready" });
    }).pipe(fixture),
  );

  it.effect(
    "prepares idempotently without changing the migration version or the thread table",
    () =>
      Effect.gen(function* () {
        const store = yield* RunStore;
        yield* store.saveThread("a", transcript(5));
        const columns = yield* sqlAll("PRAGMA table_info(chat_threads)");
        yield* historyProjection(); // Idempotent preparation.
        expect(yield* sqlGet("PRAGMA user_version")).toEqual({ user_version: migrations.length });
        expect(yield* sqlAll("PRAGMA table_info(chat_threads)")).toEqual(columns);
        const next = yield* encodeThread(transcript(6));
        yield* writeThread({ threadId: "a", messages: next, updatedAt: 2 });
        expect(yield* threadText("a")).toBe(next);
      }).pipe(fixture),
  );
});

function provideFixture<R, E2>(layer: Layer.Layer<R, E2>) {
  return <A, E>(program: Effect.Effect<A, E, R>) =>
    Effect.scoped(
      Effect.flatMap(Layer.build(layer), (context) => Effect.provideContext(program, context)),
    );
}
