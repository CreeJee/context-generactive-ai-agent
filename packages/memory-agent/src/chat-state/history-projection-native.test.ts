import type { ModelMessage } from "@tanstack/ai";
import { reconstructChat } from "@tanstack/ai-persistence";
import { Effect, Layer, Schema, Result, Function as EffectFunction } from "effect";
import { expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import { Database } from "../db/database.ts";
import { chatPersistence, ownedChatPersistence } from "./persistence.ts";
import { HistoryPageUnavailable } from "./history-projection-native.ts";
import { sqlAll, sqlGet, sqlRun, sqlExec } from "../../tests/support/sql.ts";
const encodeJson = EffectFunction.flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)),
  Result.getOrThrow,
);

const decodePage = Schema.decodeUnknownEffect(
  Schema.Struct({
    messages: Schema.Array(Schema.Struct({ id: Schema.String })),
    page: Schema.Struct({ truncated: Schema.Boolean, cursor: Schema.optional(Schema.String) }),
  }),
);

it.effect(
  "SDK initial/older GET parses only selected groups and preserves full model context",
  () =>
    Effect.gen(function* () {
      const store = yield* ownedChatPersistence;
      const models: ModelMessage[] = Array.from({ length: 100 }, (_, ordinal): ModelMessage => ({
        id: `m-${ordinal}`,
        role: "user",
        content: `${ordinal}: ${"x".repeat(1024)}`,
      }));
      yield* Effect.tryPromise(() => store.stores.messages.saveThread("a", models));
      const original = encodeJson(models);
      const parse = vi.spyOn(JSON, "parse");
      try {
        const initial = yield* Effect.tryPromise(() =>
          reconstructChat(store, new Request("http://fixture/chat?threadId=a&limit=20")),
        );
        expect(initial.status).toBe(200);
        const payload = yield* Effect.tryPromise(() => initial.json()).pipe(
          Effect.flatMap(decodePage),
        );
        expect(payload.messages).toHaveLength(20);
        expect(payload.messages[0].id).toBe("m-80");
        expect(payload.page.cursor).toBe("m-80");
        expect(parse.mock.calls.some(([json]) => json === original)).toBe(false);
        const previous = yield* Effect.tryPromise(() =>
          reconstructChat(
            store,
            new Request("http://fixture/chat?threadId=a&limit=20&before=m-80"),
          ),
        );
        const older = yield* Effect.tryPromise(() => previous.json()).pipe(
          Effect.flatMap(decodePage),
        );
        expect(older.messages[0].id).toBe("m-60");
        expect(older.messages).toHaveLength(20);
        expect(parse.mock.calls.some(([json]) => json === original)).toBe(false);
      } finally {
        parse.mockRestore();
      }
      const unprojected = yield* chatPersistence;
      const before = yield* Effect.tryPromise(() =>
        reconstructChat(unprojected, new Request("http://fixture/chat?threadId=a&limit=50")),
      );
      const after = yield* Effect.tryPromise(() =>
        reconstructChat(store, new Request("http://fixture/chat?threadId=a&limit=20")),
      );
      const beforeBytes = Buffer.byteLength(yield* Effect.tryPromise(() => before.text()));
      const afterBytes = Buffer.byteLength(yield* Effect.tryPromise(() => after.text()));
      expect(afterBytes).toBeLessThan(beforeBytes / 2);
      yield* Effect.logInfo({
        fixture: "fixed-100-user-messages",
        beforeUI: 50,
        afterUI: 20,
        beforeBytes,
        afterBytes,
        compression: false,
      });
      expect(yield* Effect.tryPromise(() => store.stores.messages.loadThread("a"))).toEqual(models);
      expect(yield* sqlGet("SELECT messages FROM chat_threads WHERE thread_id=?", "a")).toEqual({
        messages: original,
      });
    }).pipe(provideFixture(Database.layer(":memory:"))),
);

it.effect(
  "backfills released three-column records at construction and keeps legacy hydration IDs",
  () =>
    Effect.gen(function* () {
      const original = encodeJson([
        { role: "user", content: "Old" },
        { role: "assistant", content: "Reply" },
      ]);
      yield* sqlRun("INSERT INTO chat_threads VALUES(?,?,?)", "a", original, 1);
      const store = yield* ownedChatPersistence;
      const page = yield* Effect.tryPromise(() =>
        reconstructChat(store, new Request("http://fixture/chat?threadId=a&limit=1")),
      );
      const payload = yield* Effect.tryPromise(() => page.json()).pipe(Effect.flatMap(decodePage));
      expect(payload.messages).toHaveLength(1);
      expect(payload.messages[0].id).toBe("stored:a:1");
      expect(payload.page.cursor).toBe("stored:a:1");
      expect(yield* sqlGet("SELECT messages FROM chat_threads WHERE thread_id=?", "a")).toEqual({
        messages: original,
      });
    }).pipe(provideFixture(Database.layer(":memory:"))),
);

it.effect(
  "prepares repeated assistant IDs for initial and older hydration without rewriting originals",
  () =>
    Effect.gen(function* () {
      const models: ModelMessage[] = [
        { id: "user", role: "user", content: "Question" },
        { id: "answer", role: "assistant", content: "Checking" },
        { role: "tool", toolCallId: "call", content: "Result" },
        { id: "answer", role: "assistant", content: "Done" },
        { id: "next", role: "user", content: "Follow-up" },
      ];
      const original = encodeJson(models);
      yield* sqlRun("INSERT INTO chat_threads VALUES(?,?,?)", "a", original, 1);
      const store = yield* ownedChatPersistence;
      const initial = yield* Effect.tryPromise(() =>
        reconstructChat(store, new Request("http://fixture/chat?threadId=a&limit=1")),
      );
      expect(initial.status).toBe(200);
      const newest = yield* Effect.tryPromise(() => initial.json()).pipe(
        Effect.flatMap(decodePage),
      );
      expect(newest.messages.map((message) => message.id)).toEqual(["next"]);
      expect(newest.page).toEqual({ truncated: true, cursor: "next" });
      const previous = yield* Effect.tryPromise(() =>
        reconstructChat(store, new Request("http://fixture/chat?threadId=a&limit=1&before=next")),
      );
      const older = yield* Effect.tryPromise(() => previous.json()).pipe(
        Effect.flatMap(decodePage),
      );
      expect(older.messages.map((message) => message.id)).toEqual(["answer"]);
      expect(older.page).toEqual({ truncated: true, cursor: "answer" });
      const repeated = yield* Effect.tryPromise(() =>
        reconstructChat(store, new Request("http://fixture/chat?threadId=a&limit=1&before=next")),
      );
      expect(
        yield* Effect.tryPromise(() => repeated.json()).pipe(Effect.flatMap(decodePage)),
      ).toEqual(older);
      const first = yield* Effect.tryPromise(() =>
        reconstructChat(store, new Request("http://fixture/chat?threadId=a&limit=1&before=answer")),
      );
      const oldest = yield* Effect.tryPromise(() => first.json()).pipe(Effect.flatMap(decodePage));
      expect(oldest.messages.map((message) => message.id)).toEqual(["user"]);
      expect(oldest.page.truncated).toBe(false);
      expect(yield* Effect.tryPromise(() => store.stores.messages.loadThread("a"))).toEqual(models);
      yield* Effect.tryPromise(() => store.stores.messages.saveThread("a", models));
      expect(yield* sqlGet("SELECT messages FROM chat_threads WHERE thread_id=?", "a")).toEqual({
        messages: original,
      });
      const saved = yield* Effect.tryPromise(() =>
        reconstructChat(store, new Request("http://fixture/chat?threadId=a&limit=20")),
      );
      const full = yield* Effect.tryPromise(() => saved.json()).pipe(Effect.flatMap(decodePage));
      expect(full.messages.map((message) => message.id)).toEqual(["user", "answer", "next"]);
    }).pipe(provideFixture(Database.layer(":memory:"))),
);

it.effect("prepares fallback ID collisions as separate answers with stable page cursors", () =>
  Effect.gen(function* () {
    const models: ModelMessage[] = [
      { role: "assistant", content: "Legacy answer" },
      { id: "user", role: "user", content: "Next question" },
      { id: "stored:a:0", role: "assistant", content: "Unrelated answer" },
    ];
    const original = encodeJson(models);
    yield* sqlRun("INSERT INTO chat_threads VALUES(?,?,?)", "a", original, 1);
    yield* sqlRun(
      "INSERT INTO chat_threads VALUES(?,?,?)",
      "b",
      encodeJson([{ id: "normal", role: "user", content: "Normal" }]),
      1,
    );
    const store = yield* ownedChatPersistence;
    const initial = yield* Effect.tryPromise(() =>
      reconstructChat(store, new Request("http://fixture/chat?threadId=a&limit=1")),
    );
    const newest = yield* Effect.tryPromise(() => initial.json()).pipe(Effect.flatMap(decodePage));
    expect(newest.messages.map((message) => message.id)).toEqual(["stored:a:0"]);
    expect(newest.page.cursor).toBe("stored:a:0");
    const earlier = yield* Effect.tryPromise(() =>
      reconstructChat(
        store,
        new Request("http://fixture/chat?threadId=a&limit=2&before=stored:a:0"),
      ),
    );
    const previous = yield* Effect.tryPromise(() => earlier.json()).pipe(
      Effect.flatMap(decodePage),
    );
    expect(previous.messages.map((message) => message.id)).toEqual([
      "stored:a:0:fallback:0",
      "user",
    ]);
    expect(previous.page.truncated).toBe(false);
    yield* store.prepareThread("a");
    yield* Effect.tryPromise(() => store.stores.messages.saveThread("a", models));
    const again = yield* Effect.tryPromise(() =>
      reconstructChat(
        store,
        new Request("http://fixture/chat?threadId=a&limit=2&before=stored:a:0"),
      ),
    );
    expect(yield* Effect.tryPromise(() => again.json()).pipe(Effect.flatMap(decodePage))).toEqual(
      previous,
    );
    const normal = yield* Effect.tryPromise(() =>
      reconstructChat(store, new Request("http://fixture/chat?threadId=b&limit=20")),
    );
    expect(normal.status).toBe(200);
    expect(yield* sqlGet("SELECT messages FROM chat_threads WHERE thread_id=?", "a")).toEqual({
      messages: original,
    });
    yield* Effect.tryPromise(() =>
      store.stores.messages.saveThread("a", [
        ...models,
        { id: "stored:a:0:fallback:0", role: "user", content: "Published cursor conflict" },
      ]),
    );
    const failure = yield* Effect.tryPromise(() =>
      store.stores.messages.loadThread("a", { limit: 20 }),
    ).pipe(Effect.flip);
    expect(failure.cause).toMatchObject({ reason: "not-ready" });
    expect(
      yield* sqlGet("SELECT ui_id FROM chat_history_groups WHERE thread_id=? AND ordinal=0", "a"),
    ).toEqual({ ui_id: "stored:a:0:fallback:0" });
  }).pipe(provideFixture(Database.layer(":memory:"))),
);

it.effect(
  "does not mistake an explicit standalone tool cursor for a linked result's fallback",
  () =>
    Effect.gen(function* () {
      const models: ModelMessage[] = [
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
      const original = encodeJson(models);
      yield* sqlRun("INSERT INTO chat_threads VALUES(?,?,?)", "a", original, 1);
      const store = yield* ownedChatPersistence;
      yield* Effect.tryPromise(() => store.stores.messages.saveThread("a", models));
      // Preparation must also recover the unchanged original after an external invalidation.
      yield* sqlRun("UPDATE chat_threads SET messages=? WHERE thread_id=?", original, "a");
      yield* store.prepareThread("a");
      const initial = yield* Effect.tryPromise(() =>
        reconstructChat(store, new Request("http://fixture/chat?threadId=a&limit=1")),
      );
      expect(initial.status).toBe(200);
      const newest = yield* Effect.tryPromise(() => initial.json()).pipe(
        Effect.flatMap(decodePage),
      );
      expect(newest.messages.map((message) => message.id)).toEqual(["stored:a:1"]);
      expect(newest.page.cursor).toBe("stored:a:1");
      const older = yield* Effect.tryPromise(() =>
        reconstructChat(
          store,
          new Request("http://fixture/chat?threadId=a&limit=1&before=stored:a:1"),
        ),
      );
      const previous = yield* Effect.tryPromise(() => older.json()).pipe(
        Effect.flatMap(decodePage),
      );
      expect(previous.messages.map((message) => message.id)).toEqual(["user"]);
      const first = yield* Effect.tryPromise(() =>
        reconstructChat(store, new Request("http://fixture/chat?threadId=a&limit=1&before=user")),
      );
      const oldest = yield* Effect.tryPromise(() => first.json()).pipe(Effect.flatMap(decodePage));
      expect(oldest.messages.map((message) => message.id)).toEqual(["answer"]);
      expect(oldest.page.truncated).toBe(false);
      const again = yield* Effect.tryPromise(() =>
        reconstructChat(store, new Request("http://fixture/chat?threadId=a&limit=1")),
      );
      expect(yield* Effect.tryPromise(() => again.json()).pipe(Effect.flatMap(decodePage))).toEqual(
        newest,
      );
      expect(yield* Effect.tryPromise(() => store.stores.messages.loadThread("a"))).toEqual(models);
      expect(yield* sqlGet("SELECT messages FROM chat_threads WHERE thread_id=?", "a")).toEqual({
        messages: original,
      });
    }).pipe(provideFixture(Database.layer(":memory:"))),
);

it.effect("keeps a newly empty thread valid and does not full-load a stale transcript", () =>
  Effect.gen(function* () {
    const store = yield* ownedChatPersistence;
    expect(
      yield* Effect.tryPromise(() => store.stores.messages.loadThread("new", { limit: 20 })),
    ).toEqual({ messages: [], truncated: false });
    yield* Effect.tryPromise(() =>
      store.stores.messages.saveThread("a", [{ id: "u", role: "user", content: "Original" }]),
    );
    yield* sqlRun(
      "UPDATE chat_threads SET messages=? WHERE thread_id=?",
      encodeJson([{ id: "u", role: "user", content: "Old writer changed" }]),
      "a",
    );
    const failed = yield* Effect.tryPromise(() =>
      store.stores.messages.loadThread("a", { limit: 20 }),
    ).pipe(Effect.flip);
    expect(failed.cause).toBeInstanceOf(HistoryPageUnavailable);
    yield* store.prepareThread("a");
    const page = yield* Effect.tryPromise(() =>
      store.stores.messages.loadThread("a", { limit: 20 }),
    );
    expect(page).toMatchObject({ messages: [{ content: "Old writer changed" }] });
  }).pipe(provideFixture(Database.layer(":memory:"))),
);

it.effect("writes only changed derived groups rather than rewriting the unchanged prefix", () =>
  Effect.gen(function* () {
    const store = yield* ownedChatPersistence;
    const models: ModelMessage[] = Array.from({ length: 30 }, (_, index): ModelMessage => ({
      id: `m-${index}`,
      role: "user",
      content: `${index}`,
    }));
    yield* Effect.tryPromise(() => store.stores.messages.saveThread("a", models));
    yield* sqlExec(`
    CREATE TABLE projection_write_fixture(operation TEXT, ordinal INTEGER);
    CREATE TRIGGER projection_fixture_insert AFTER INSERT ON chat_history_groups BEGIN INSERT INTO projection_write_fixture VALUES('insert',NEW.ordinal); END;
    CREATE TRIGGER projection_fixture_update AFTER UPDATE ON chat_history_groups BEGIN INSERT INTO projection_write_fixture VALUES('update',NEW.ordinal); END;
    CREATE TRIGGER projection_fixture_delete AFTER DELETE ON chat_history_groups BEGIN INSERT INTO projection_write_fixture VALUES('delete',OLD.ordinal); END;
  `);
    yield* Effect.tryPromise(() => store.stores.messages.saveThread("a", models));
    expect(yield* sqlAll("SELECT * FROM projection_write_fixture")).toEqual([]);
    const changed: ModelMessage[] = [
      ...models.slice(0, -1),
      { id: "m-29", role: "user", content: "Changed tail" },
    ];
    yield* Effect.tryPromise(() => store.stores.messages.saveThread("a", changed));
    expect(yield* sqlAll("SELECT * FROM projection_write_fixture")).toEqual([
      { operation: "update", ordinal: 29 },
    ]);
    yield* sqlExec("DELETE FROM projection_write_fixture");
    yield* Effect.tryPromise(() =>
      store.stores.messages.saveThread("a", [
        ...changed,
        { id: "m-30", role: "user", content: "Appended" },
      ]),
    );
    expect(yield* sqlAll("SELECT * FROM projection_write_fixture")).toEqual([
      { operation: "insert", ordinal: 30 },
    ]);
    yield* sqlExec("DELETE FROM projection_write_fixture");
    yield* Effect.tryPromise(() => store.stores.messages.saveThread("a", changed));
    expect(yield* sqlAll("SELECT * FROM projection_write_fixture")).toEqual([
      { operation: "delete", ordinal: 30 },
    ]);
    expect(yield* Effect.tryPromise(() => store.stores.messages.loadThread("a"))).toEqual(changed);
  }).pipe(provideFixture(Database.layer(":memory:"))),
);

it.effect(
  "repairs fractional disposable ordinals without rejecting original saves or startup preparation",
  () =>
    Effect.gen(function* () {
      const store = yield* ownedChatPersistence;
      const original: ModelMessage[] = [
        { id: "first", role: "user", content: "One" },
        { id: "second", role: "user", content: "Two" },
      ];
      yield* Effect.tryPromise(() => store.stores.messages.saveThread("a", original));
      yield* sqlRun(
        "UPDATE chat_history_groups SET ordinal=0.5 WHERE thread_id=? AND ordinal=0",
        "a",
      );
      const updated: ModelMessage[] = [
        ...original,
        { id: "third", role: "assistant", content: "Appended" },
      ];
      yield* Effect.tryPromise(() => store.stores.messages.saveThread("a", updated));
      expect(yield* Effect.tryPromise(() => store.stores.messages.loadThread("a"))).toEqual(
        updated,
      );
      const ready = yield* Effect.tryPromise(() =>
        store.stores.messages.loadThread("a", { limit: 20 }),
      );
      expect(ready).toMatchObject({ messages: updated });
      yield* sqlRun(
        "UPDATE chat_history_groups SET ordinal=0.5 WHERE thread_id=? AND ordinal=0",
        "a",
      );
      yield* sqlRun("UPDATE chat_threads SET messages=messages WHERE thread_id=?", "a");
      const restarted = yield* ownedChatPersistence;
      const recovered = yield* Effect.tryPromise(() =>
        restarted.stores.messages.loadThread("a", { limit: 20 }),
      );
      expect(recovered).toMatchObject({ messages: updated });
      expect(
        yield* sqlAll(
          "SELECT ordinal FROM chat_history_groups WHERE thread_id=? ORDER BY ordinal",
          "a",
        ),
      ).toEqual([{ ordinal: 0 }, { ordinal: 1 }, { ordinal: 2 }]);
    }).pipe(provideFixture(Database.layer(":memory:"))),
);

it.effect("handles moved UI IDs without unique-index collisions or stale tail rows", () =>
  Effect.gen(function* () {
    const store = yield* ownedChatPersistence;
    const initial: ModelMessage[] = [
      { id: "first", role: "user", content: "One" },
      { id: "second", role: "user", content: "Two" },
      { id: "third", role: "user", content: "Three" },
    ];
    yield* Effect.tryPromise(() => store.stores.messages.saveThread("a", initial));
    const moved: ModelMessage[] = [initial[1]!, initial[0]!];
    yield* Effect.tryPromise(() => store.stores.messages.saveThread("a", moved));
    const response = yield* Effect.tryPromise(() =>
      reconstructChat(store, new Request("http://fixture/chat?threadId=a&limit=20")),
    );
    const page = yield* Effect.tryPromise(() => response.json()).pipe(Effect.flatMap(decodePage));
    expect(page.messages.map((message) => message.id)).toEqual(["second", "first"]);
    expect(page.page.truncated).toBe(false);
    expect(yield* Effect.tryPromise(() => store.stores.messages.loadThread("a"))).toEqual(moved);
  }).pipe(provideFixture(Database.layer(":memory:"))),
);

it.effect("rolls back original and page together on projection SQL failure", () =>
  Effect.gen(function* () {
    const store = yield* ownedChatPersistence;
    const original: ModelMessage[] = [{ id: "u", role: "user", content: "Kept" }];
    yield* Effect.tryPromise(() => store.stores.messages.saveThread("a", original));
    yield* sqlExec(
      "CREATE TRIGGER fail_projection_fixture BEFORE INSERT ON chat_history_groups BEGIN SELECT RAISE(ABORT,'fixture'); END;",
    );
    yield* Effect.tryPromise(() =>
      store.stores.messages.saveThread("a", [
        ...original,
        { id: "n", role: "assistant", content: "Rejected" },
      ]),
    ).pipe(Effect.flip);
    expect(yield* Effect.tryPromise(() => store.stores.messages.loadThread("a"))).toEqual(original);
    const page = yield* Effect.tryPromise(() =>
      store.stores.messages.loadThread("a", { limit: 20 }),
    );
    expect(page).toMatchObject({ messages: original });
  }).pipe(provideFixture(Database.layer(":memory:"))),
);

function provideFixture<R, E2>(layer: Layer.Layer<R, E2>) {
  return <A, E>(program: Effect.Effect<A, E, R>) =>
    Effect.scoped(
      Effect.flatMap(Layer.build(layer), (context) => Effect.provideContext(program, context)),
    );
}
