import { DatabaseSync } from "node:sqlite";
import { Effect, Layer, Schema, Result, Function as EffectFunction } from "effect";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { Database } from "../db/database.ts";
import { HistoryProjectionReader, type HistoryPageRequest } from "./history-projection-reader.ts";
import { historyProjectionSchema, historyProjectionSql as sql } from "./history-projection-sql.ts";
const encodeJson = EffectFunction.flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)),
  Result.getOrThrow,
);

const database = Layer.effect(
  Database,
  Effect.acquireRelease(
    Effect.try(() => {
      const sqlite = new DatabaseSync(":memory:");
      sqlite.exec(
        "CREATE TABLE chat_threads(thread_id TEXT PRIMARY KEY, messages TEXT NOT NULL, updated_at INTEGER NOT NULL);",
      );
      sqlite.exec(historyProjectionSchema);
      return Database.of({ sqlite, atomic: (work) => work() });
    }),
    ({ sqlite }) => Effect.sync(() => sqlite.close()),
  ),
);
const layer = HistoryProjectionReader.layer.pipe(Layer.provideMerge(database));
function run<A, E>(program: Effect.Effect<A, E, Database | HistoryProjectionReader>) {
  return program.pipe(provideFixture(layer));
}
const seed = Effect.fnUntraced(function* (count: number) {
  const { sqlite } = yield* Database;
  yield* Effect.try(() => {
    const messages = Array.from({ length: count }, (_, ordinal) => ({
      id: `m-${ordinal}`,
      role: "user",
      content: `Message ${ordinal}`,
    }));
    sqlite.prepare("INSERT INTO chat_threads VALUES(?, ?, ?)").run("a", encodeJson(messages), 1);
    for (const [ordinal, message] of messages.entries())
      sqlite.prepare(sql.insertGroup).run("a", ordinal, message.id, encodeJson([message]));
    sqlite.prepare(sql.publish).run("a");
  });
});

describe("Effect history projection reader boundary", () => {
  it.effect("reports missing schema at layer preparation and releases the owner connection", () => {
    let closes = 0;
    const missing = Layer.effect(
      Database,
      Effect.acquireRelease(
        Effect.try(() =>
          Database.of({ sqlite: new DatabaseSync(":memory:"), atomic: (work) => work() }),
        ),
        ({ sqlite }) =>
          Effect.sync(() => {
            sqlite.close();
            closes += 1;
          }),
      ),
    );
    return Effect.gen(function* () {
      const failure = yield* Effect.void.pipe(
        provideFixture(HistoryProjectionReader.layer.pipe(Layer.provide(missing))),
        Effect.flip,
      );
      switch (failure._tag) {
        case "HistoryProjectionReadFailed":
          expect(failure.reason).toEqual({ _tag: "SqliteRead", phase: "prepare" });
          break;
        case "UnknownError":
          expect.fail("fixture acquisition should succeed");
      }
      expect(closes).toBe(1);
    });
  });

  it.effect("does not reopen a borrowed connection after its owner Scope has ended", () =>
    Effect.gen(function* () {
      const reader = yield* HistoryProjectionReader.pipe(provideFixture(layer));
      const failure = yield* reader
        .read({ type: "initial", threadId: "a", limit: 3 })
        .pipe(Effect.flip);
      expect(failure.reason).toEqual({ _tag: "SqliteRead", phase: "query" });
    }),
  );

  it.effect(
    "distinguishes an unsupported projection format and rejects malformed selected fields",
    () =>
      run(
        Effect.gen(function* () {
          yield* seed(2);
          const reader = yield* HistoryProjectionReader;
          const { sqlite } = yield* Database;
          yield* Effect.try(() =>
            sqlite.exec(
              "PRAGMA ignore_check_constraints = ON; UPDATE chat_history_projection SET format_version = 2 WHERE thread_id = 'a';",
            ),
          );
          expect(yield* reader.read({ type: "initial", threadId: "a", limit: 3 })).toEqual({
            type: "not-ready",
            reason: "unsupported-format",
          });
          yield* Effect.try(() =>
            sqlite.exec(
              "UPDATE chat_history_projection SET format_version = 1 WHERE thread_id = 'a'; UPDATE chat_history_groups SET ui_id = '' WHERE thread_id = 'a' AND ordinal = 0;",
            ),
          );
          const failure = yield* reader
            .read({ type: "initial", threadId: "a", limit: 3 })
            .pipe(Effect.flip);
          expect(failure.reason._tag).toBe("InvalidSnapshot");
        }),
      ),
  );

  it.effect(
    "orders only selected groups, returns an indexed cursor and preserves serialized originals",
    () =>
      run(
        Effect.gen(function* () {
          yield* seed(5);
          const reader = yield* HistoryProjectionReader;
          const page = yield* reader.read({ type: "initial", threadId: "a", limit: 3 });
          expect(page.type).toBe("page");
          switch (page.type) {
            case "page":
              expect(page.groups.map((group) => group.uiId)).toEqual(["m-2", "m-3", "m-4"]);
              expect(page.truncated).toBe(true);
              expect(page.nextCursor).toBe("m-2");
              expect(page.groups[0]?.messages).toBe(
                encodeJson([{ id: "m-2", role: "user", content: "Message 2" }]),
              );
              break;
            case "not-ready":
            case "unknown-cursor":
              expect.fail("fixture should be ready");
          }
          const older = yield* reader.read({
            type: "older",
            threadId: "a",
            before: "m-2",
            limit: 3,
          });
          switch (older.type) {
            case "page":
              expect(older.groups.map((group) => group.uiId)).toEqual(["m-0", "m-1"]);
              expect(older.truncated).toBe(false);
              expect(older.nextCursor).toBeNull();
              break;
            case "not-ready":
            case "unknown-cursor":
              expect.fail("fixture should be ready");
          }
        }),
      ),
  );

  it.effect(
    "distinguishes missing, stale, unknown, empty and end without full-transcript fallback",
    () =>
      run(
        Effect.gen(function* () {
          const reader = yield* HistoryProjectionReader;
          expect(yield* reader.read({ type: "initial", threadId: "missing", limit: 3 })).toEqual({
            type: "not-ready",
            reason: "unprepared",
          });
          yield* seed(2);
          expect(
            yield* reader.read({ type: "older", threadId: "a", before: "unknown", limit: 3 }),
          ).toEqual({ type: "unknown-cursor" });
          expect(
            yield* reader.read({ type: "older", threadId: "a", before: "m-0", limit: 3 }),
          ).toEqual({ type: "page", groups: [], truncated: false, nextCursor: null });
          const { sqlite } = yield* Database;
          yield* Effect.try(() =>
            sqlite
              .prepare("UPDATE chat_threads SET messages = ? WHERE thread_id = ?")
              .run("[]", "a"),
          );
          expect(yield* reader.read({ type: "initial", threadId: "a", limit: 3 })).toEqual({
            type: "not-ready",
            reason: "stale",
          });
          yield* Effect.try(() => {
            sqlite.prepare(sql.removeGroups).run("a");
            sqlite.prepare(sql.publish).run("a");
          });
          expect(yield* reader.read({ type: "initial", threadId: "a", limit: 3 })).toEqual({
            type: "page",
            groups: [],
            truncated: false,
            nextCursor: null,
          });
        }),
      ),
  );

  it.effect(
    "rejects invalid limits and cursor requests before SQLite can interpret an unbounded LIMIT",
    () =>
      run(
        Effect.gen(function* () {
          const reader = yield* HistoryProjectionReader;
          const inputs: HistoryPageRequest[] = [
            { type: "initial", threadId: "a", limit: -1 },
            { type: "initial", threadId: "a", limit: 0 },
            { type: "initial", threadId: "a", limit: 1.5 },
            { type: "initial", threadId: "a", limit: Infinity },
            { type: "older", threadId: "a", limit: 3, before: "" },
          ];
          for (const input of inputs) {
            const failure = yield* reader.read(input).pipe(Effect.flip);
            expect(failure._tag).toBe("HistoryProjectionReadFailed");
            expect(failure.reason._tag).toBe("InvalidRequest");
          }
        }),
      ),
  );

  it.effect(
    "keeps malformed database rows and query failures typed instead of showing empty history",
    () =>
      run(
        Effect.gen(function* () {
          yield* seed(2);
          const reader = yield* HistoryProjectionReader;
          const { sqlite } = yield* Database;
          yield* Effect.try(() =>
            sqlite.exec(
              "PRAGMA ignore_check_constraints = ON; UPDATE chat_history_projection SET ready = 2 WHERE thread_id = 'a';",
            ),
          );
          const invalid = yield* reader
            .read({ type: "initial", threadId: "a", limit: 3 })
            .pipe(Effect.flip);
          expect(invalid.reason._tag).toBe("InvalidSnapshot");
          yield* Effect.try(() => sqlite.exec("DROP TABLE chat_history_groups"));
          const failed = yield* reader
            .read({ type: "initial", threadId: "a", limit: 3 })
            .pipe(Effect.flip);
          expect(failed.reason).toEqual({ _tag: "SqliteRead", phase: "query" });
          expect(encodeJson(failed)).not.toContain("Message 0");
        }),
      ),
  );
});

function provideFixture<R, E2>(layer: Layer.Layer<R, E2>) {
  return <A, E>(program: Effect.Effect<A, E, R>) =>
    Effect.scoped(
      Effect.flatMap(Layer.build(layer), (context) => Effect.provideContext(program, context)),
    );
}
