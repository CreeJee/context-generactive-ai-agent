import { Effect, Layer, Schema, Result, Function as EffectFunction } from "effect";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import type { ModelMessage } from "@tanstack/ai";
import { Database } from "../db/database.ts";
import { groupHistoryMessages } from "./history-groups.ts";
import { HistoryProjectionReader } from "./history-projection-reader.ts";
import {
  HistoryProjectionPublisher,
  type HistoryProjectionPublication,
} from "./history-projection-publisher.ts";
const encodeJson = EffectFunction.flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)),
  Result.getOrThrow,
);

const ownedDatabase = Database.layer(":memory:");
const publisher = HistoryProjectionPublisher.layer.pipe(Layer.provideMerge(ownedDatabase));
const layer = HistoryProjectionReader.layer.pipe(Layer.provideMerge(publisher));
function run<A, E>(
  program: Effect.Effect<A, E, Database | HistoryProjectionReader | HistoryProjectionPublisher>,
) {
  return program.pipe(provideFixture(layer));
}
function publication(messages: ModelMessage[]): HistoryProjectionPublication {
  const grouping = groupHistoryMessages("a", messages);
  switch (grouping.type) {
    case "id-collision":
      throw new Error("Unexpected fixture ID collision");
    case "ready":
      return {
        threadId: "a",
        sourceJSON: encodeJson(messages),
        groups: grouping.groups.map((group) => ({
          id: group.id,
          messages: encodeJson(group.messages),
        })),
      };
  }
}
const first = publication([{ id: "old", role: "user", content: "Original preserved" }]);
const latest = publication([
  { id: "old", role: "user", content: "Original preserved" },
  { id: "new", role: "assistant", content: "Later answer" },
]);
const writeOriginal = Effect.fnUntraced(function* (sourceJSON: string) {
  const { sqlite } = yield* Database;
  yield* Effect.try(() =>
    sqlite
      .prepare(
        "INSERT INTO chat_threads VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET messages=excluded.messages, updated_at=excluded.updated_at",
      )
      .run("a", sourceJSON, 1),
  );
});

describe("Effect history projection publication", () => {
  it.effect("reports a read-only install failure rather than running a partial publisher", () =>
    Effect.gen(function* () {
      const readOnly = Layer.effect(
        Database,
        Effect.gen(function* () {
          const db = yield* Database;
          yield* Effect.try(() => db.sqlite.exec("PRAGMA query_only=ON"));
          return db;
        }),
      ).pipe(Layer.provide(ownedDatabase));
      const failed = yield* Effect.void.pipe(
        provideFixture(HistoryProjectionPublisher.layer.pipe(Layer.provide(readOnly))),
        Effect.flip,
      );
      switch (failed._tag) {
        case "HistoryProjectionPublishFailed":
          expect(failed.reason).toEqual({ _tag: "SqliteWrite", phase: "install" });
          break;
        case "DatabaseOpenError":
        case "UnknownError":
          expect.fail("read-only fixture setup should succeed");
      }
    }),
  );

  it.effect("keeps borrowed lifetime and does not reopen a disposed owner connection", () =>
    Effect.gen(function* () {
      const service = yield* HistoryProjectionPublisher.pipe(provideFixture(publisher));
      const failed = yield* service.publish(first).pipe(Effect.flip);
      expect(failed.reason).toEqual({ _tag: "SqliteWrite", phase: "publish" });
    }),
  );

  it.effect(
    "publishes the prepared source and keeps original bytes and global version unchanged",
    () =>
      run(
        Effect.gen(function* () {
          const db = yield* Database;
          const service = yield* HistoryProjectionPublisher;
          const reader = yield* HistoryProjectionReader;
          const before = yield* Effect.try(() => db.sqlite.prepare("PRAGMA user_version").get());
          yield* writeOriginal(first.sourceJSON);
          expect(yield* service.publish(first)).toEqual({ type: "published", groupCount: 1 });
          expect(yield* service.publish(first)).toEqual({ type: "published", groupCount: 1 });
          const page = yield* reader.read({ type: "initial", threadId: "a", limit: 50 });
          switch (page.type) {
            case "page":
              expect(page.groups.map((group) => group.messages)).toEqual(
                first.groups.map((group) => group.messages),
              );
              break;
            case "not-ready":
            case "unknown-cursor":
              expect.fail("publication should be ready");
          }
          expect(
            yield* Effect.try(() =>
              db.sqlite.prepare("SELECT messages FROM chat_threads WHERE thread_id=?").get("a"),
            ),
          ).toEqual({ messages: first.sourceJSON });
          expect(yield* Effect.try(() => db.sqlite.prepare("PRAGMA user_version").get())).toEqual(
            before,
          );
        }),
      ),
  );

  it.effect("rolls back stale publication and does not resurrect a deleted source", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Database;
        const service = yield* HistoryProjectionPublisher;
        const reader = yield* HistoryProjectionReader;
        yield* writeOriginal(latest.sourceJSON);
        yield* service.publish(latest);
        const current = yield* reader.read({ type: "initial", threadId: "a", limit: 50 });
        expect(yield* service.publish(first)).toEqual({ type: "source-changed" });
        expect(yield* reader.read({ type: "initial", threadId: "a", limit: 50 })).toEqual(current);
        yield* Effect.try(() =>
          db.sqlite.prepare("DELETE FROM chat_threads WHERE thread_id=?").run("a"),
        );
        expect(yield* service.publish(latest)).toEqual({ type: "source-changed" });
        expect(yield* reader.read({ type: "initial", threadId: "a", limit: 50 })).toEqual({
          type: "not-ready",
          reason: "unprepared",
        });
        expect(
          yield* Effect.try(() =>
            db.sqlite
              .prepare("SELECT COUNT(*) AS count FROM chat_history_groups WHERE thread_id=?")
              .get("a"),
          ),
        ).toEqual({ count: 0 });
      }),
    ),
  );

  it.effect("keeps a ready snapshot intact on invalid group JSON or duplicate UI IDs", () =>
    run(
      Effect.gen(function* () {
        const service = yield* HistoryProjectionPublisher;
        const reader = yield* HistoryProjectionReader;
        yield* writeOriginal(first.sourceJSON);
        yield* service.publish(first);
        const current = yield* reader.read({ type: "initial", threadId: "a", limit: 50 });
        for (const input of [
          { ...first, threadId: "" },
          { ...first, groups: [{ id: "", messages: first.sourceJSON }] },
        ]) {
          const failed = yield* service.publish(input).pipe(Effect.flip);
          expect(failed.reason._tag).toBe("InvalidPublication");
          expect(yield* reader.read({ type: "initial", threadId: "a", limit: 50 })).toEqual(
            current,
          );
        }
        for (const messages of ["not JSON", "{}", "[]"]) {
          const failed = yield* service
            .publish({ ...first, groups: [{ id: "old", messages }] })
            .pipe(Effect.flip);
          expect(failed.reason._tag).toBe("InvalidPreparedJson");
          expect(yield* reader.read({ type: "initial", threadId: "a", limit: 50 })).toEqual(
            current,
          );
        }
        const failed = yield* service
          .publish({ ...first, groups: [...first.groups, ...first.groups] })
          .pipe(Effect.flip);
        expect(failed.reason).toEqual({ _tag: "SqliteWrite", phase: "publish" });
        expect(encodeJson(failed)).not.toContain("Original preserved");
        expect(yield* reader.read({ type: "initial", threadId: "a", limit: 50 })).toEqual(current);
      }),
    ),
  );

  it.effect("publishes valid empty history but does not publish malformed source JSON", () =>
    run(
      Effect.gen(function* () {
        const service = yield* HistoryProjectionPublisher;
        const reader = yield* HistoryProjectionReader;
        yield* writeOriginal("[]");
        expect(yield* service.publish({ threadId: "a", sourceJSON: "[]", groups: [] })).toEqual({
          type: "published",
          groupCount: 0,
        });
        const invalid = yield* service
          .publish({ threadId: "a", sourceJSON: "{}", groups: [] })
          .pipe(Effect.flip);
        expect(invalid.reason._tag).toBe("InvalidPreparedJson");
        expect(yield* reader.read({ type: "initial", threadId: "a", limit: 50 })).toEqual({
          type: "page",
          groups: [],
          truncated: false,
          nextCursor: null,
        });
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
