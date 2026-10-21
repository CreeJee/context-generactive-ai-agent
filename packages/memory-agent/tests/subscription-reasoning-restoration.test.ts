import { it } from "@effect/vitest";
import { Cause, Effect } from "effect";
import { nativePromise, runNativeEffect } from "../src/runtime/native-effect.ts";
import { nativeStream } from "../src/runtime/native-stream.ts";
// Native SDK integration boundary: no network, real models, tools or production database.
import { chat, EventType, type ModelMessage } from "@tanstack/ai";
import {
  defineAIPersistence,
  defineMessageStore,
  reconstructChat,
  withPersistence,
} from "@tanstack/ai-persistence";
import { expect } from "vite-plus/test";
import { Stream, Schema, Result, Function as EffectFunction } from "effect";

// Synchronous codec at this native SDK response boundary, not a domain Effect runner.
const decodeHistory = EffectFunction.flow(
  Schema.decodeUnknownResult(
    Schema.Struct({
      messages: Schema.Array(
        Schema.Struct({
          role: Schema.Literals(["user", "assistant", "system"]),
          parts: Schema.Array(
            Schema.Union([
              Schema.Struct({ type: Schema.Literals(["thinking"]), content: Schema.String }),
              Schema.Struct({ type: Schema.Literals(["text"]), content: Schema.String }),
            ]),
          ),
        }),
      ),
    }),
  ),
  Result.getOrThrow,
);
import { SubscriptionTextAdapter } from "../src/providers/subscription-adapter.ts";
import { NormalizedStreamEvent } from "../src/oauth/protocol.ts";

it.live(
  "public OpenAI summary survives real SDK transcript persistence and history reconstruction without exposing opaque reasoning",
  () =>
    Effect.gen(function* () {
      let saved: ModelMessage[] = [];
      const persistence = defineAIPersistence({
        stores: {
          messages: defineMessageStore({
            loadThread: () => runNativeEffect(Effect.sync(() => structuredClone(saved))),
            saveThread: (_threadId, messages) =>
              runNativeEffect(
                Effect.sync(() => {
                  saved = structuredClone(messages);
                }),
              ),
          }),
        },
      });
      const events: NormalizedStreamEvent[] = [
        NormalizedStreamEvent["reasoning-summary-start"]({
          id: "rs-fixture",
          summaryIndex: 0,
          text: "Checking",
        }),
        NormalizedStreamEvent["reasoning-summary-delta"]({
          id: "rs-fixture",
          summaryIndex: 0,
          delta: " details",
        }),
        NormalizedStreamEvent["reasoning-summary-end"]({
          id: "rs-fixture",
          summaryIndex: 0,
          text: "Checking details",
        }),
        NormalizedStreamEvent.reasoning({
          id: "rs-fixture",
          encryptedContent: "opaque-fixture-do-not-display",
        }),
        NormalizedStreamEvent.text({ text: "Answer." }),
      ];
      const adapter = new SubscriptionTextAdapter(
        {
          stream() {
            return nativeStream(
              Stream.fromIterable(
                (function* () {
                  yield* events;
                })(),
                { chunkSize: 1 },
              ),
            );
          },
        },
        { provider: "openai", model: "fixture", reasoningEffort: "medium" },
      );
      const chunks = yield* Stream.runCollect(
        Stream.fromAsyncIterable(
          chat({
            adapter,
            messages: [{ id: "user-fixture", role: "user", content: "Question." }],
            threadId: "fixture-thread",
            middleware: [withPersistence(persistence)],
          }),
          (cause) => new Cause.UnknownError(cause),
        ),
      );
      expect(chunks.some((chunk) => chunk.type === EventType.RUN_FINISHED)).toBe(true);
      const response = yield* nativePromise(() =>
        reconstructChat(
          persistence,
          new Request("http://fixture/chat?threadId=fixture-thread&limit=20"),
        ),
      );
      expect(response.status).toBe(200);
      const body = decodeHistory(yield* nativePromise(() => response.json()));
      expect(body.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "assistant",
            parts: expect.arrayContaining([
              expect.objectContaining({ type: "thinking", content: "Checking details" }),
              expect.objectContaining({ type: "text", content: "Answer." }),
            ]),
          }),
        ]),
      );
      const visibleText = body.messages
        .flatMap((message) => message.parts.map((part) => part.content))
        .join("");
      expect(visibleText).not.toContain("opaque-fixture-do-not-display");
      expect(
        Result.getOrThrow(Schema.encodeResult(Schema.fromJsonString(Schema.Unknown))(saved)),
      ).toContain("openai-reasoning:");
    }),
);
