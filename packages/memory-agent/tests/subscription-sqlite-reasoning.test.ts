import { nativeStream } from "../src/runtime/native-stream.ts";
// Real production SQLite persistence/SDK boundary on an isolated scoped in-memory DB.
import { it } from "@effect/vitest";
import { chat, EventType, type ModelMessage } from "@tanstack/ai";
import { reconstructChat, withPersistence } from "@tanstack/ai-persistence";
import { Cause, Effect, Layer, Schema, Stream } from "effect";
import { expect } from "vite-plus/test";
import { Database } from "../src/db/database.ts";
import { ownedChatPersistence } from "../src/chat-state/persistence.ts";
import { SubscriptionTextAdapter } from "../src/providers/subscription-adapter.ts";
import { NormalizedStreamEvent } from "../src/oauth/protocol.ts";

const decodePage = Schema.decodeUnknownEffect(
  Schema.Struct({
    messages: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        parts: Schema.Array(
          Schema.Struct({ type: Schema.Literals(["thinking", "text"]), content: Schema.String }),
        ),
      }),
    ),
    page: Schema.Struct({ truncated: Schema.Boolean, cursor: Schema.optional(Schema.String) }),
  }),
);

it.effect(
  "production SQLite SDK persistence restores public reasoning in bounded pages and preserves opaque model context",
  () =>
    Effect.gen(function* () {
      const database = yield* Layer.build(Layer.fresh(Database.layer(":memory:")));
      const store = yield* Effect.provideContext(ownedChatPersistence, database);
      const threadId = "sqlite-reasoning-fixture";
      const previous: ModelMessage[] = Array.from({ length: 25 }, (_, index) => ({
        id: `old-${index}`,
        role: "user",
        content: `Previous ${index}`,
      }));
      yield* Effect.tryPromise(() => store.stores.messages.saveThread(threadId, previous));
      const events: NormalizedStreamEvent[] = [
        NormalizedStreamEvent["reasoning-summary-start"]({
          id: "rs-sqlite",
          summaryIndex: 0,
          text: "Checking",
        }),
        NormalizedStreamEvent["reasoning-summary-delta"]({
          id: "rs-sqlite",
          summaryIndex: 0,
          delta: " details",
        }),
        NormalizedStreamEvent["reasoning-summary-end"]({
          id: "rs-sqlite",
          summaryIndex: 0,
          text: "Checking details",
        }),
        NormalizedStreamEvent.reasoning({
          id: "rs-sqlite",
          encryptedContent: "opaque-sqlite-do-not-display",
        }),
        NormalizedStreamEvent.text({ text: "SQLite answer." }),
      ];
      const adapter = new SubscriptionTextAdapter(
        {
          stream() {
            return nativeStream(Stream.fromIterable(events, { chunkSize: 1 }));
          },
        },
        { provider: "openai", model: "fixture", reasoningEffort: "medium" },
      );
      const chunks = yield* Stream.runCollect(
        Stream.fromAsyncIterable(
          chat({
            adapter,
            messages: [{ id: "latest-user", role: "user", content: "Question." }],
            threadId,
            middleware: [withPersistence(store)],
          }),
          (cause) => new Cause.UnknownError(cause),
        ),
      );
      const finished = chunks.some((chunk) => chunk.type === EventType.RUN_FINISHED);
      expect(finished).toBe(true);
      const original = yield* Effect.tryPromise(() => store.stores.messages.loadThread(threadId));
      expect(original.map((message) => message.id)).toEqual(
        expect.arrayContaining(previous.map((message) => message.id)),
      );
      expect(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(original)).toContain(
        "openai-reasoning:",
      );
      const response = yield* Effect.tryPromise(() =>
        reconstructChat(store, new Request(`http://fixture/chat?threadId=${threadId}&limit=2`)),
      );
      expect(response.status).toBe(200);
      const initial = yield* Effect.tryPromise(() => response.json()).pipe(
        Effect.flatMap(decodePage),
      );
      expect(initial.messages).toHaveLength(2);
      expect(initial.page.truncated).toBe(true);
      expect(initial.messages.flatMap((message) => message.parts)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "thinking", content: "Checking details" }),
          expect.objectContaining({ type: "text", content: "SQLite answer." }),
        ]),
      );
      expect(
        initial.messages.flatMap((message) => message.parts.map((part) => part.content)).join(""),
      ).not.toContain("opaque-sqlite-do-not-display");
      const cursor = initial.page.cursor;
      expect(cursor).toBeDefined();
      const olderResponse = yield* Effect.tryPromise(() =>
        reconstructChat(
          store,
          new Request(`http://fixture/chat?threadId=${threadId}&limit=20&before=${cursor}`),
        ),
      );
      expect(olderResponse.status).toBe(200);
      const older = yield* Effect.tryPromise(() => olderResponse.json()).pipe(
        Effect.flatMap(decodePage),
      );
      expect(older.messages).toHaveLength(20);
      expect(
        older.messages.every(
          (message) => !initial.messages.some((latest) => latest.id === message.id),
        ),
      ).toBe(true);
      // Startup/reopening the production adapter must preserve both projection and model context.
      const reopened = yield* Effect.provideContext(ownedChatPersistence, database);
      expect(yield* Effect.tryPromise(() => reopened.stores.messages.loadThread(threadId))).toEqual(
        original,
      );
    }),
);
