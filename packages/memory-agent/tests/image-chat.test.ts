import { waitUntil } from "./support/wait-until.ts";
import { ChatClient, fetchServerSentEvents } from "@tanstack/ai-client";
import { Cause, Effect } from "effect";
import { it } from "@effect/vitest";
import { selectTestModel } from "./support/provider.ts";
import { describe, expect } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { sessionMessages } from "../src/agent/history.ts";
import { Attachments } from "../src/attachments/attachments.ts";
import { attachmentUrl } from "../src/attachments/urls.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { tinyPng } from "./support/images.ts";
import { testRuntime } from "./support/runtime.ts";

const until = waitUntil;

const imageSetup = Effect.fnUntraced(function* (model: string) {
  const context = yield* Effect.tryPromise({
    try: () => testRuntime({ testProvider: {} }),
    catch: (cause) => new Cause.UnknownError(cause),
  });
  yield* Effect.provideContext(
    selectTestModel(model, model === "deep-1" ? "medium" : "low"),
    yield* context.runtime.contextEffect,
  );
  const attachment = yield* Effect.provideContext(
    Effect.flatMap(Attachments, (attachments) => attachments.save(tinyPng)),
    yield* context.runtime.contextEffect,
  );
  const handle = (input: string | URL | Request, init?: RequestInit) =>
    context.runtime.runPromise(
      Effect.flatMap(AgentChat, (agent) =>
        agent.handle(new Request(input, init), context.session.id),
      ),
    );
  const client = yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new ChatClient({
          connection: fetchServerSentEvents("http://127.0.0.1/api/chat", { fetchClient: handle }),
        }),
    ),
    (client) => Effect.sync(() => client.dispose()),
  );
  const answer = () =>
    client
      .getMessages()
      .flatMap((message) =>
        message.role === "assistant"
          ? message.parts.flatMap((part) => (part.type === "text" ? [part.content] : []))
          : [],
      )
      .join("");
  const imagePart = {
    type: "image",
    source: { type: "url", value: attachmentUrl(attachment.id), mimeType: "image/png" },
  } as const;
  return { ...context, attachment, client, answer, imagePart, handle };
});

describe("images in chat", () => {
  it.live("stores images with the user turn and sends provider-neutral image parts", () =>
    Effect.gen(function* () {
      const { client, answer, imagePart, runtime, session, attachment, provider } =
        yield* imageSetup("fast-1");

      yield* Effect.tryPromise({
        try: () =>
          client.sendMessage({
            content: [{ type: "text", content: "look at #1 please" }, imagePart],
          }),
        catch: (cause) => new Cause.UnknownError(cause),
      });
      yield* until(() => !client.getIsLoading() && answer().length > 0, "the answer");
      expect(answer()).toBe("Saw 1 image(s)");

      const [nodes, attachments] = yield* Effect.provideContext(
        Effect.all([Nodes, Attachments]),
        yield* runtime.contextEffect,
      );
      const user = nodes.session(session.id).find((node) => node.kind === "user");
      expect(user?.text).toBe("look at #1 please");
      expect(attachments.forNode(user?.id ?? "").map((stored) => stored.id)).toEqual([
        attachment.id,
      ]);

      const modelUser = provider!.adapter.invocations[0]?.messages.find(
        (message) => message.role === "user",
      );
      expect(modelUser?.content).toEqual([
        { type: "text", content: "look at #1 please" },
        {
          type: "image",
          source: {
            type: "data",
            value: expect.any(String),
            mimeType: expect.stringMatching(/^image\//),
          },
        },
      ]);

      // A later turn replays the earlier image as inline data the provider can read.
      yield* Effect.tryPromise({
        try: () => client.sendMessage("look at it again"),
        catch: (cause) => new Cause.UnknownError(cause),
      });
      yield* until(
        () => provider!.adapter.invocations.length === 2,
        "the second provider invocation",
      );
      expect(
        provider!.adapter.invocations[1]?.messages.flatMap((message) =>
          Array.isArray(message.content)
            ? message.content.filter((part) => part.type === "image")
            : [],
        ),
      ).toEqual([
        {
          type: "image",
          source: {
            type: "data",
            value: expect.any(String),
            mimeType: expect.stringMatching(/^image\//),
          },
        },
      ]);

      // The stored transcript shows the image again after a reload.
      const [firstUser] = sessionMessages(nodes.session(session.id), attachments.forNode);
      expect(firstUser?.parts).toEqual([{ type: "text", content: "look at #1 please" }, imagePart]);
    }),
  );

  it.live("refuses images for a text-only model and unknown attachments", () =>
    Effect.gen(function* () {
      const { handle, imagePart } = yield* imageSetup("deep-1");
      const post = (content: readonly object[]) =>
        handle("http://127.0.0.1/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadId: "t",
            runId: "r",
            messages: [{ id: "m", role: "user", content }],
            tools: [],
            context: [],
          }),
        });

      const unsupported = yield* Effect.tryPromise({
        try: () => post([{ type: "text", content: "look at this" }, imagePart]),
        catch: (cause) => new Cause.UnknownError(cause),
      });
      expect(unsupported.status).toBe(422);
      expect(
        yield* Effect.tryPromise({
          try: () => unsupported.json(),
          catch: (cause) => new Cause.UnknownError(cause),
        }),
      ).toMatchObject({ error: "images_not_supported" });

      const unknown = yield* Effect.tryPromise({
        try: () =>
          post([{ type: "image", source: { type: "url", value: attachmentUrl("f".repeat(64)) } }]),
        catch: (cause) => new Cause.UnknownError(cause),
      });
      expect(unknown.status).toBe(400);
    }),
  );
});
