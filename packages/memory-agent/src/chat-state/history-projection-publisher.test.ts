import { Effect, Layer, Match, Schema, Result, Function as EffectFunction } from "effect";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { SqlClient } from "effect/sql";
import type { ModelMessage } from "@tanstack/ai";
import { Database } from "../db/database.ts";
import { groupHistoryMessages, HistoryGroupingResult } from "./history-groups.ts";
import {
  HistoryPageRequest,
  HistoryPageSnapshot,
  HistoryProjectionReader,
} from "./history-projection-reader.ts";
import {
  HistoryProjectionPublicationResult,
  HistoryProjectionPublisher,
  HistoryProjectionPublishReason,
  type HistoryProjectionPublication,
} from "./history-projection-publisher.ts";
import { sqlGet, sqlRun, sqlExec } from "../../tests/support/sql.ts";
const encodeJson = EffectFunction.flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)),
  Result.getOrThrow,
);
const publishReason = HistoryProjectionPublishReason.cases;
const publicationResult = HistoryProjectionPublicationResult.cases;
const initialPage = HistoryPageRequest.cases.initial.make({ threadId: "a", limit: 50 });

const ownedDatabase = Database.layer(":memory:");
const publisher = HistoryProjectionPublisher.layer.pipe(Layer.provideMerge(ownedDatabase));
const layer = HistoryProjectionReader.layer.pipe(Layer.provideMerge(publisher));
function run<A, E>(
  program: Effect.Effect<
    A,
    E,
    SqlClient.SqlClient | HistoryProjectionReader | HistoryProjectionPublisher
  >,
) {
  return program.pipe(provideFixture(layer));
}
function publication(messages: ModelMessage[]): HistoryProjectionPublication {
  return HistoryGroupingResult.$match(groupHistoryMessages("a", messages), {
    "id-collision": () => {
      throw new Error("Unexpected fixture ID collision");
    },
    ready: ({ groups }) => ({
      threadId: "a",
      sourceJSON: encodeJson(messages),
      groups: groups.map((group) => ({
        id: group.id,
        messages: encodeJson(group.messages),
      })),
    }),
  });
}
const first = publication([{ id: "old", role: "user", content: "Original preserved" }]);
const latest = publication([
  { id: "old", role: "user", content: "Original preserved" },
  { id: "new", role: "assistant", content: "Later answer" },
]);
const writeOriginal = Effect.fnUntraced(function* (sourceJSON: string) {
  yield* sqlRun(
    "INSERT INTO chat_threads VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET messages=excluded.messages, updated_at=excluded.updated_at",
    "a",
    sourceJSON,
    1,
  );
});

describe("Effect history projection publication", () => {
  it.effect("reports a read-only install failure rather than running a partial publisher", () =>
    Effect.gen(function* () {
      const readOnly = Layer.effectDiscard(sqlExec("PRAGMA query_only=ON")).pipe(
        Layer.provideMerge(ownedDatabase),
      );
      const failed = yield* Effect.void.pipe(
        provideFixture(HistoryProjectionPublisher.layer.pipe(Layer.provide(readOnly))),
        Effect.flip,
      );
      const setupFailed = () => expect.fail("read-only fixture setup should succeed");
      Match.valueTags(failed, {
        HistoryProjectionPublishFailed: (publishFailed) =>
          expect(publishFailed.reason).toEqual(
            publishReason.SqliteWrite.make({ phase: "install" }),
          ),
        DatabaseOpenError: setupFailed,
        SqlError: setupFailed,
      });
    }),
  );

  it.effect("keeps borrowed lifetime and does not reopen a disposed owner connection", () =>
    Effect.gen(function* () {
      const service = yield* HistoryProjectionPublisher.pipe(provideFixture(publisher));
      const failed = yield* service.publish(first).pipe(Effect.flip);
      expect(failed.reason).toEqual(publishReason.SqliteWrite.make({ phase: "publish" }));
    }),
  );

  it.effect(
    "publishes the prepared source and keeps original bytes and global version unchanged",
    () =>
      run(
        Effect.gen(function* () {
          const service = yield* HistoryProjectionPublisher;
          const reader = yield* HistoryProjectionReader;
          const before = yield* sqlGet("PRAGMA user_version");
          yield* writeOriginal(first.sourceJSON);
          expect(yield* service.publish(first)).toEqual(
            publicationResult.published.make({ groupCount: 1 }),
          );
          expect(yield* service.publish(first)).toEqual(
            publicationResult.published.make({ groupCount: 1 }),
          );
          const page = yield* reader.read(initialPage);
          HistoryPageSnapshot.matchOrElse(
            page,
            {
              page: (page) =>
                expect(page.groups.map((group) => group.messages)).toEqual(
                  first.groups.map((group) => group.messages),
                ),
            },
            () => expect.fail("publication should be ready"),
          );
          expect(yield* sqlGet("SELECT messages FROM chat_threads WHERE thread_id=?", "a")).toEqual(
            { messages: first.sourceJSON },
          );
          expect(yield* sqlGet("PRAGMA user_version")).toEqual(before);
        }),
      ),
  );

  it.effect("rolls back stale publication and does not resurrect a deleted source", () =>
    run(
      Effect.gen(function* () {
        const service = yield* HistoryProjectionPublisher;
        const reader = yield* HistoryProjectionReader;
        yield* writeOriginal(latest.sourceJSON);
        yield* service.publish(latest);
        const current = yield* reader.read(initialPage);
        expect(yield* service.publish(first)).toEqual(publicationResult["source-changed"].make({}));
        expect(yield* reader.read(initialPage)).toEqual(current);
        yield* sqlRun("DELETE FROM chat_threads WHERE thread_id=?", "a");
        expect(yield* service.publish(latest)).toEqual(
          publicationResult["source-changed"].make({}),
        );
        expect(yield* reader.read(initialPage)).toEqual(
          HistoryPageSnapshot.cases["not-ready"].make({ reason: "unprepared" }),
        );
        expect(
          yield* sqlGet("SELECT COUNT(*) AS count FROM chat_history_groups WHERE thread_id=?", "a"),
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
        const current = yield* reader.read(initialPage);
        for (const input of [
          { ...first, threadId: "" },
          { ...first, groups: [{ id: "", messages: first.sourceJSON }] },
        ]) {
          const failed = yield* service.publish(input).pipe(Effect.flip);
          expect(failed.reason).toEqual(publishReason.InvalidPublication.make({}));
          expect(yield* reader.read(initialPage)).toEqual(current);
        }
        for (const messages of ["not JSON", "{}", "[]"]) {
          const failed = yield* service
            .publish({ ...first, groups: [{ id: "old", messages }] })
            .pipe(Effect.flip);
          expect(failed.reason).toEqual(publishReason.InvalidPreparedJson.make({}));
          expect(yield* reader.read(initialPage)).toEqual(current);
        }
        const failed = yield* service
          .publish({ ...first, groups: [...first.groups, ...first.groups] })
          .pipe(Effect.flip);
        expect(failed.reason).toEqual(publishReason.SqliteWrite.make({ phase: "publish" }));
        expect(encodeJson(failed)).not.toContain("Original preserved");
        expect(yield* reader.read(initialPage)).toEqual(current);
      }),
    ),
  );

  it.effect("publishes valid empty history but does not publish malformed source JSON", () =>
    run(
      Effect.gen(function* () {
        const service = yield* HistoryProjectionPublisher;
        const reader = yield* HistoryProjectionReader;
        yield* writeOriginal("[]");
        expect(yield* service.publish({ threadId: "a", sourceJSON: "[]", groups: [] })).toEqual(
          publicationResult.published.make({ groupCount: 0 }),
        );
        const invalid = yield* service
          .publish({ threadId: "a", sourceJSON: "{}", groups: [] })
          .pipe(Effect.flip);
        expect(invalid.reason).toEqual(publishReason.InvalidPreparedJson.make({}));
        expect(yield* reader.read(initialPage)).toEqual(
          HistoryPageSnapshot.cases.page.make({ groups: [], truncated: false, nextCursor: null }),
        );
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
