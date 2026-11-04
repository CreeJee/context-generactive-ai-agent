import { Effect, Layer } from "effect";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { Database } from "../db/database.ts";
import { RunStore } from "../loop/store.ts";
import { HistoryPageRequest, HistoryPageSnapshot } from "./history-projection-reader.ts";
import { writeThread } from "../../tests/support/chat-thread.ts";
const request = HistoryPageRequest.cases;
const snapshot = HistoryPageSnapshot.cases;

const fixture = provideFixture(RunStore.layer.pipe(Layer.provideMerge(Database.layer(":memory:"))));

describe("Effect history projection reader boundary", () => {
  it.effect(
    "distinguishes missing, stale, unknown, empty and end without full-transcript fallback",
    () =>
      Effect.gen(function* () {
        const store = yield* RunStore;
        expect(
          yield* store.historyPage(request.initial.make({ threadId: "missing", limit: 3 })),
        ).toEqual(snapshot["not-ready"].make({ reason: "unprepared" }));
        yield* store.saveThread("a", [
          { id: "m-0", role: "user", content: "Message 0" },
          { id: "m-1", role: "user", content: "Message 1" },
        ]);
        expect(
          yield* store.historyPage(
            request.older.make({ threadId: "a", before: "unknown", limit: 3 }),
          ),
        ).toEqual(snapshot["unknown-cursor"].make({}));
        expect(
          yield* store.historyPage(request.older.make({ threadId: "a", before: "m-0", limit: 3 })),
        ).toEqual(snapshot.page.make({ groups: [], truncated: false, nextCursor: null }));
        yield* writeThread({ threadId: "a", messages: "[]" });
        expect(yield* store.historyPage(request.initial.make({ threadId: "a", limit: 3 }))).toEqual(
          snapshot["not-ready"].make({ reason: "stale" }),
        );
        yield* store.saveThread("a", []);
        expect(yield* store.historyPage(request.initial.make({ threadId: "a", limit: 3 }))).toEqual(
          snapshot.page.make({ groups: [], truncated: false, nextCursor: null }),
        );
      }).pipe(fixture),
  );
});

function provideFixture<R, E2>(layer: Layer.Layer<R, E2>) {
  return <A, E>(program: Effect.Effect<A, E, R>) =>
    Effect.scoped(
      Effect.flatMap(Layer.build(layer), (context) => Effect.provideContext(program, context)),
    );
}
