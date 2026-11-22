import { Effect, Schema } from "effect";
import { expect } from "vite-plus/test";
import { AgentChat } from "../../src/agent/chat.ts";
import { Attachments } from "../../src/attachments/attachments.ts";
import { RunStore } from "../../src/loop/store.ts";
import { ImageExecutorModel } from "../../src/providers/image-contracts.ts";
import type { ImageMediaAsset } from "../../src/providers/image-media-contracts.ts";
import { tinyPng } from "../support/images.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";

const resultOf = Schema.fromJsonString(
  Schema.Struct({ preview: Schema.Struct({ attachmentId: Schema.String }) }),
);

const generatedAsset = Effect.gen(function* () {
  const attachment = yield* (yield* Attachments).save(tinyPng);
  const asset: ImageMediaAsset = {
    attachment,
    initiatorChatModel: "gpt-6-astra",
    executorMediaRouteId: "media:test",
    executorMediaModel: ImageExecutorModel.provider_managed(),
    provider: "openai",
    accountId: "test",
    executionMode: "direct_adapter",
  };
  return asset;
});

testAgent()(function (it) {
  it.effect("a generated image is written as the prompt, a call and its result", () =>
    Effect.gen(function* () {
      const { session } = yield* TestEnv;
      const chat = yield* AgentChat;
      const runStore = yield* RunStore;
      const asset = yield* generatedAsset;
      yield* runStore.saveThread(session.id, [{ role: "user", content: "earlier" }]);

      const recorded = yield* chat.recordImage(session.id, { prompt: "a red fox", asset });

      const thread = yield* runStore.thread(session.id);
      expect(thread[0]).toMatchObject({ role: "user", content: "earlier" });
      const [user, assistant, tool] = thread.slice(-3);
      expect(thread).toHaveLength(4);
      expect(recorded).toEqual({
        userMessageId: user?.id,
        assistantMessageId: assistant?.id,
        toolMessageId: tool?.id,
      });
      expect(user).toMatchObject({ role: "user", content: "a red fox" });
      expect(assistant).toMatchObject({
        role: "assistant",
        content: null,
        toolCalls: [{ function: { name: "generate_image" } }],
      });
      const callId = assistant?.role === "assistant" ? assistant.toolCalls?.[0]?.id : undefined;
      expect(tool).toMatchObject({ role: "tool", toolCallId: callId });
      const result = yield* Schema.decodeUnknownEffect(resultOf)(tool?.content);
      expect(result.preview.attachmentId).toBe(asset.attachment.id);
    }),
  );

  it.effect("the picture survives cleanup", () =>
    Effect.gen(function* () {
      const { session } = yield* TestEnv;
      const chat = yield* AgentChat;
      const attachments = yield* Attachments;
      const asset = yield* generatedAsset;

      yield* chat.recordImage(session.id, { prompt: "a red fox", asset });

      yield* attachments.purgeOrphans;
      expect(yield* attachments.get(asset.attachment.id)).not.toBeNull();
    }),
  );
});
