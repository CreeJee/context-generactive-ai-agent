import { Effect, Layer, Schema, Result, Function as EffectFunction } from "effect";
import { SqlClient } from "effect/sql";
import { expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { StoredMessage } from "../chat-store/schema.ts";
import { Database } from "../db/database.ts";
import { RunStore } from "../loop/store.ts";
import { historyProjection, HistoryPageUnavailable } from "./history-projection-native.ts";
import { chatSnapshot } from "./snapshot.ts";
import { sqlAll, sqlGet, sqlExec } from "../../tests/support/sql.ts";
import { threadRevision, threadText, writeThread } from "../../tests/support/chat-thread.ts";
const encodeJson = EffectFunction.flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)),
  Result.getOrThrow,
);
/** The thread's text as `RunStore` saves it. */
const encodeThread = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(StoredMessage)));

// `historyProjection` itself needs Crypto where a test makes one.
const fixture = provideFixture(
  RunStore.layer.pipe(
    Layer.provideMerge(Layer.merge(Database.layer(":memory:"), NodeCrypto.layer)),
  ),
);

/** What `ChatState` does at startup: the pages of every thread that has none ready. */
const restart = Effect.flatMap(historyProjection(), (projection) => projection.prepare());
/** What `ChatState` does for a session imported after startup. */
const prepareThread = (threadId: string) =>
  Effect.flatMap(historyProjection(), (projection) => projection.prepare(threadId));

/** The ids of the messages a page shows, and the cursor of the page before it. */
const page = (threadId: string, limit: number, before?: string) =>
  Effect.map(chatSnapshot(threadId, limit, before), ({ messages, older }) => ({
    ids: messages.map((message) => message.id),
    older,
  }));

it.effect("initial and older pages parse only their groups and keep the whole thread", () =>
  Effect.gen(function* () {
    const store = yield* RunStore;
    const messages = Array.from({ length: 100 }, (_, ordinal): StoredMessage => ({
      id: `m-${ordinal}`,
      role: "user",
      content: `${ordinal}: ${"x".repeat(1024)}`,
    }));
    yield* store.saveThread("a", messages);
    const original = yield* encodeThread(messages);
    yield* Effect.acquireUseRelease(
      Effect.sync(() => vi.spyOn(JSON, "parse")),
      (parse) =>
        Effect.gen(function* () {
          const initial = yield* page("a", 20);
          expect(initial.ids).toHaveLength(20);
          expect(initial.ids[0]).toBe("m-80");
          expect(initial.older).toBe("m-80");
          const older = yield* page("a", 20, "m-80");
          expect(older.ids).toHaveLength(20);
          expect(older.ids[0]).toBe("m-60");
          expect(parse.mock.calls.some(([json]) => json === original)).toBe(false);
        }),
      (parse) => Effect.sync(() => parse.mockRestore()),
    );
    expect(yield* store.thread("a")).toEqual(messages);
  }).pipe(fixture),
);

it.effect("prepares released threads at startup and keeps legacy hydration IDs", () =>
  Effect.gen(function* () {
    const original = encodeJson([
      { role: "user", content: "Old" },
      { role: "assistant", content: "Reply" },
    ]);
    yield* writeThread({ threadId: "a", messages: original });
    yield* restart;
    expect(yield* page("a", 1)).toEqual({ ids: ["stored:a:1"], older: "stored:a:1" });
    expect(yield* threadText("a")).toBe(original);
  }).pipe(fixture),
);

it.effect("prepares repeated assistant IDs for initial and older pages without changing them", () =>
  Effect.gen(function* () {
    const store = yield* RunStore;
    const messages: StoredMessage[] = [
      { id: "user", role: "user", content: "Question" },
      { id: "answer", role: "assistant", content: "Checking" },
      { role: "tool", toolCallId: "call", content: "Result" },
      { id: "answer", role: "assistant", content: "Done" },
      { id: "next", role: "user", content: "Follow-up" },
    ];
    yield* writeThread({ threadId: "a", messages: encodeJson(messages) });
    yield* restart;
    expect(yield* page("a", 1)).toEqual({ ids: ["next"], older: "next" });
    const older = yield* page("a", 1, "next");
    expect(older).toEqual({ ids: ["answer"], older: "answer" });
    expect(yield* page("a", 1, "next")).toEqual(older);
    expect(yield* page("a", 1, "answer")).toEqual({ ids: ["user"], older: null });
    expect(yield* store.thread("a")).toEqual(messages);
    yield* store.saveThread("a", messages);
    expect(yield* store.thread("a")).toEqual(messages);
    expect(yield* page("a", 20)).toEqual({ ids: ["user", "answer", "next"], older: null });
  }).pipe(fixture),
);

it.effect("prepares fallback ID collisions as separate answers with stable page cursors", () =>
  Effect.gen(function* () {
    const store = yield* RunStore;
    const messages: StoredMessage[] = [
      { role: "assistant", content: "Legacy answer" },
      { id: "user", role: "user", content: "Next question" },
      { id: "stored:a:0", role: "assistant", content: "Unrelated answer" },
    ];
    yield* writeThread({ threadId: "a", messages: encodeJson(messages) });
    yield* writeThread({
      threadId: "b",
      messages: encodeJson([{ id: "normal", role: "user", content: "Normal" }]),
    });
    yield* restart;
    expect(yield* page("a", 1)).toEqual({ ids: ["stored:a:0"], older: "stored:a:0" });
    const previous = yield* page("a", 2, "stored:a:0");
    expect(previous).toEqual({ ids: ["stored:a:0:fallback:0", "user"], older: null });
    yield* prepareThread("a");
    yield* store.saveThread("a", messages);
    expect(yield* page("a", 2, "stored:a:0")).toEqual(previous);
    expect((yield* page("b", 20)).ids).toEqual(["normal"]);
    yield* store.saveThread("a", [
      ...messages,
      { id: "stored:a:0:fallback:0", role: "user", content: "Published cursor conflict" },
    ]);
    const failure = yield* Effect.flip(page("a", 20));
    expect(failure).toBeInstanceOf(HistoryPageUnavailable);
    expect(failure).toMatchObject({ reason: "not-ready" });
    expect(
      yield* sqlGet("SELECT ui_id FROM chat_history_groups WHERE thread_id=? AND ordinal=0", "a"),
    ).toEqual({ ui_id: "stored:a:0:fallback:0" });
  }).pipe(fixture),
);

it.effect(
  "does not mistake an explicit standalone tool cursor for a linked result's fallback",
  () =>
    Effect.gen(function* () {
      const store = yield* RunStore;
      const messages: StoredMessage[] = [
        {
          id: "answer",
          role: "assistant",
          content: "Checking",
          toolCalls: [
            { id: "call", type: "function", function: { name: "read", arguments: "{}" } },
          ],
        },
        { role: "tool", toolCallId: "call", content: "Linked result" },
        { id: "user", role: "user", content: "Next question" },
        { id: "stored:a:1", role: "tool", toolCallId: "other-call", content: "Standalone result" },
      ];
      const original = encodeJson(messages);
      yield* writeThread({ threadId: "a", messages: original });
      yield* restart;
      yield* store.saveThread("a", messages);
      // Preparation must also recover the unchanged original after an external invalidation.
      yield* writeThread({ threadId: "a", messages: original });
      yield* prepareThread("a");
      const newest = yield* page("a", 1);
      expect(newest).toEqual({ ids: ["stored:a:1"], older: "stored:a:1" });
      expect((yield* page("a", 1, "stored:a:1")).ids).toEqual(["user"]);
      expect(yield* page("a", 1, "user")).toEqual({ ids: ["answer"], older: null });
      expect(yield* page("a", 1)).toEqual(newest);
      expect(yield* store.thread("a")).toEqual(messages);
      expect(yield* threadText("a")).toBe(original);
    }).pipe(fixture),
);

it.effect("keeps a newly empty thread valid and does not full-load a stale transcript", () =>
  Effect.gen(function* () {
    const store = yield* RunStore;
    expect(yield* page("new", 20)).toEqual({ ids: [], older: null });
    yield* store.saveThread("a", [{ id: "u", role: "user", content: "Original" }]);
    yield* writeThread({
      threadId: "a",
      messages: encodeJson([{ id: "u", role: "user", content: "Old writer changed" }]),
    });
    expect(yield* Effect.flip(page("a", 20))).toBeInstanceOf(HistoryPageUnavailable);
    yield* prepareThread("a");
    expect((yield* chatSnapshot("a", 20, undefined)).messages).toEqual([
      { id: "u", role: "user", parts: [{ type: "text", content: "Old writer changed" }] },
    ]);
  }).pipe(fixture),
);

it.effect("writes only changed derived groups rather than rewriting the unchanged prefix", () =>
  Effect.gen(function* () {
    const store = yield* RunStore;
    const messages = Array.from({ length: 30 }, (_, index): StoredMessage => ({
      id: `m-${index}`,
      role: "user",
      content: `${index}`,
    }));
    yield* store.saveThread("a", messages);
    yield* sqlExec(`
    CREATE TABLE projection_write_fixture(operation TEXT, ordinal INTEGER);
    CREATE TRIGGER projection_fixture_insert AFTER INSERT ON chat_history_groups BEGIN INSERT INTO projection_write_fixture VALUES('insert',NEW.ordinal); END;
    CREATE TRIGGER projection_fixture_update AFTER UPDATE ON chat_history_groups BEGIN INSERT INTO projection_write_fixture VALUES('update',NEW.ordinal); END;
    CREATE TRIGGER projection_fixture_delete AFTER DELETE ON chat_history_groups BEGIN INSERT INTO projection_write_fixture VALUES('delete',OLD.ordinal); END;
  `);
    yield* store.saveThread("a", messages);
    expect(yield* sqlAll("SELECT * FROM projection_write_fixture")).toEqual([]);
    const changed: StoredMessage[] = [
      ...messages.slice(0, -1),
      { id: "m-29", role: "user", content: "Changed tail" },
    ];
    yield* store.saveThread("a", changed);
    expect(yield* sqlAll("SELECT * FROM projection_write_fixture")).toEqual([
      { operation: "update", ordinal: 29 },
    ]);
    yield* sqlExec("DELETE FROM projection_write_fixture");
    yield* store.saveThread("a", [...changed, { id: "m-30", role: "user", content: "Appended" }]);
    expect(yield* sqlAll("SELECT * FROM projection_write_fixture")).toEqual([
      { operation: "insert", ordinal: 30 },
    ]);
    yield* sqlExec("DELETE FROM projection_write_fixture");
    yield* store.saveThread("a", changed);
    expect(yield* sqlAll("SELECT * FROM projection_write_fixture")).toEqual([
      { operation: "delete", ordinal: 30 },
    ]);
    expect(yield* store.thread("a")).toEqual(changed);
  }).pipe(fixture),
);

it.effect("handles moved UI IDs without unique-index collisions or stale tail rows", () =>
  Effect.gen(function* () {
    const store = yield* RunStore;
    const initial: StoredMessage[] = [
      { id: "first", role: "user", content: "One" },
      { id: "second", role: "user", content: "Two" },
      { id: "third", role: "user", content: "Three" },
    ];
    yield* store.saveThread("a", initial);
    const moved: StoredMessage[] = [initial[1]!, initial[0]!];
    yield* store.saveThread("a", moved);
    expect(yield* page("a", 20)).toEqual({ ids: ["second", "first"], older: null });
    expect(yield* store.thread("a")).toEqual(moved);
  }).pipe(fixture),
);

it.effect("rolls back original and page together on projection SQL failure", () =>
  Effect.gen(function* () {
    const store = yield* RunStore;
    const original: StoredMessage[] = [{ id: "u", role: "user", content: "Kept" }];
    yield* store.saveThread("a", original);
    yield* sqlExec(
      "CREATE TRIGGER fail_projection_fixture BEFORE INSERT ON chat_history_groups BEGIN SELECT RAISE(ABORT,'fixture'); END;",
    );
    yield* Effect.flip(
      store.saveThread("a", [...original, { id: "n", role: "assistant", content: "Rejected" }]),
    );
    expect(yield* store.thread("a")).toEqual(original);
    expect(yield* page("a", 20)).toEqual({ ids: ["u"], older: null });
  }).pipe(fixture),
);

// A 15k-message thread rewrote its 7k groups on every save of a run, holding the connection for
// about 0.4 s each time.
it.effect("a run's next save encodes only the groups its new messages make", () =>
  Effect.gen(function* () {
    const store = yield* RunStore;
    // Tool results are saved without ids, so each save publishes fresh copies of them.
    const messages = Array.from({ length: 10 }, (_, turn): StoredMessage[] => [
      { id: `u-${turn}`, role: "user", content: `${turn}` },
      {
        id: `a-${turn}`,
        role: "assistant",
        content: "Checking",
        toolCalls: [
          { id: `call-${turn}`, type: "function", function: { name: "read", arguments: "{}" } },
        ],
      },
      { role: "tool", toolCallId: `call-${turn}`, content: `Result ${turn}` },
    ]).flat();
    yield* store.saveThread("a", messages);
    const next = [...messages, { id: "u-10", role: "user" as const, content: "Appended" }];
    const encodedGroups = yield* Effect.acquireUseRelease(
      Effect.sync(() => vi.spyOn(JSON, "stringify")),
      (stringify) =>
        Effect.map(store.saveThread("a", next), () =>
          // The thread itself is encoded whole; every other array is a group.
          stringify.mock.calls.flatMap(([value]) =>
            Array.isArray(value) && value.length < next.length ? [value] : [],
          ),
        ),
      (stringify) => Effect.sync(() => stringify.mockRestore()),
    );
    expect(encodedGroups).toEqual([[next[30]]]);
    expect((yield* page("a", 2)).ids).toEqual(["a-9", "u-10"]);
  }).pipe(fixture),
);

it.effect("does not trust a remembered publish whose transaction rolled back", () =>
  Effect.gen(function* () {
    const store = yield* RunStore;
    const sql = yield* SqlClient.SqlClient;
    const projection = yield* historyProjection();
    const original: StoredMessage[] = [{ id: "u", role: "user", content: "Kept" }];
    yield* store.saveThread("a", original);
    const next = [...original, { id: "n", role: "assistant" as const, content: "Answer" }];
    /** The thread saved as `next`, as `RunStore` saves it. */
    const save = writeThread({ threadId: "a", messages: yield* encodeThread(next) }).pipe(
      Effect.andThen(threadRevision("a")),
      Effect.flatMap((revision) => projection.replace({ threadId: "a", revision, messages: next })),
    );
    // The writer's transaction fails after the pages were published, and rolls them back.
    yield* Effect.flip(sql.withTransaction(Effect.andThen(save, Effect.fail("after publish"))));
    yield* sql.withTransaction(save);
    expect(yield* page("a", 20)).toEqual({ ids: ["u", "n"], older: null });
  }).pipe(fixture),
);

function provideFixture<R, E2>(layer: Layer.Layer<R, E2>) {
  return <A, E>(program: Effect.Effect<A, E, R>) =>
    Effect.scoped(
      Effect.flatMap(Layer.build(layer), (context) => Effect.provideContext(program, context)),
    );
}
