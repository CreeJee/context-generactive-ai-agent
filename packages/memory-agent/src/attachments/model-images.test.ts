import { it } from "@effect/vitest";
import { Effect, Ref } from "effect";
import { expect } from "vite-plus/test";
import type { StoredMessage } from "../chat-store/schema.ts";
import type { Attachment, AttachmentsApi } from "./attachments.ts";
import { modelImagesHook } from "./model-images.ts";
import { attachmentUrl } from "./urls.ts";

const attachment: Attachment = {
  id: "a".repeat(64),
  mimeType: "image/png",
  bytes: 4,
  createdAt: "2026-11-08T00:00:00.000Z",
};
const asked: StoredMessage = {
  role: "user",
  content: [
    { type: "text", content: "look" },
    {
      type: "image",
      source: { type: "url", value: attachmentUrl(attachment.id), mimeType: "image/png" },
    },
  ],
};
const scope = {
  threadId: "thread",
  runId: "run",
  emit: () => Effect.void,
  inBackground: Effect.ignore,
};

it.effect("reads an image once per run and inlines it on every step", () =>
  Effect.gen(function* () {
    const reads = yield* Ref.make(0);
    const attachments: Pick<AttachmentsApi, "get" | "forModel" | "dataUrl"> = {
      get: () => Effect.succeed(attachment),
      forModel: () => Effect.succeed({ path: "/images/a.png", mimeType: "image/png" }),
      dataUrl: () =>
        Effect.as(
          Ref.update(reads, (count) => count + 1),
          "data:image/png;base64,QUJD",
        ),
    };
    const hook = yield* modelImagesHook(attachments);
    const step = (history: ReadonlyArray<StoredMessage>) =>
      Effect.flatMap(Effect.fromNullishOr(hook.request), (request) =>
        request(scope, { system: [], history, tools: [] }),
      );

    const first = yield* step([asked]);
    const second = yield* step([asked, { role: "user", content: "again" }, asked]);
    const inline = {
      type: "image",
      source: { type: "data", value: "QUJD", mimeType: "image/png" },
    };
    expect(first.history).toEqual([
      { ...asked, content: [{ type: "text", content: "look" }, inline] },
    ]);
    expect(second.history[2]).toEqual(first.history[0]);
    expect(yield* Ref.get(reads)).toBe(1);
    // Another run reads it again.
    yield* Effect.flatMap(modelImagesHook(attachments), (other) =>
      Effect.flatMap(Effect.fromNullishOr(other.request), (request) =>
        request(scope, { system: [], history: [asked], tools: [] }),
      ),
    );
    expect(yield* Ref.get(reads)).toBe(2);
  }),
);
