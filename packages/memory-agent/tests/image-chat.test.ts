import { fileURLToPath } from "node:url";
import { ChatClient, fetchServerSentEvents } from "@tanstack/ai-client";
import { Effect, Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { sessionMessages } from "../src/agent/history.ts";
import { Attachments } from "../src/attachments/attachments.ts";
import { attachmentUrl } from "../src/attachments/urls.ts";
import { CodexAppServer } from "../src/codex/app-server.ts";
import { CodexModels } from "../src/codex/models.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { tinyPng } from "./support/images.ts";
import { testRuntime } from "./support/runtime.ts";

const fakeServer = fileURLToPath(new URL("./support/fake-codex.mjs", import.meta.url));
const fakeCodex = CodexAppServer.withCommand({
  executable: process.execPath,
  args: [fakeServer, "--signed-in"],
});

const Log = Schema.Struct({
  log: Schema.Array(Schema.Struct({ method: Schema.String, params: Schema.Unknown })),
});

async function until(condition: () => boolean, what: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function imageSetup(model: string) {
  const context = await testRuntime({ codex: fakeCodex });
  const attachment = await context.runtime.runPromise(
    Effect.gen(function* () {
      yield* (yield* CodexModels).select(model);
      return yield* (yield* Attachments).save(tinyPng);
    }),
  );
  const handle = (input: string | URL | Request, init?: RequestInit) =>
    context.runtime.runPromise(
      Effect.flatMap(AgentChat, (agent) =>
        agent.handle(new Request(input, init), context.session.id),
      ),
    );
  const client = new ChatClient({
    connection: fetchServerSentEvents("http://127.0.0.1/api/chat", { fetchClient: handle }),
  });
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
}

describe("images in chat", () => {
  test("stores the images with the user turn and hands codex the local files", async () => {
    const { client, answer, imagePart, runtime, session, attachment } = await imageSetup("fast-1");

    await client.sendMessage({
      content: [{ type: "text", content: "look at #1 please" }, imagePart],
    });
    await until(() => !client.getIsLoading() && answer().length > 0, "the answer");
    expect(answer()).toBe("Saw 1 new image(s) and 0 earlier image(s)");

    const [nodes, attachments, codex] = await Promise.all([
      runtime.runPromise(Nodes),
      runtime.runPromise(Attachments),
      runtime.runPromise(CodexAppServer),
    ]);
    const user = nodes.session(session.id).find((node) => node.kind === "user");
    expect(user?.text).toBe("look at #1 please");
    expect(attachments.forNode(user?.id ?? "").map((stored) => stored.id)).toEqual([attachment.id]);

    const { log } = await runtime.runPromise(codex.request("test/log", {}, Log));
    expect(log.find((entry) => entry.method === "turn/start")?.params).toMatchObject({
      input: [
        { type: "text", text: "look at #1 please" },
        { type: "localImage", path: attachments.pathOf(attachment) },
      ],
    });

    // A later turn replays the earlier image to a fresh codex thread.
    await client.sendMessage("look at it again");
    await until(() => answer().includes("1 earlier image"), "the second answer");

    // The stored transcript shows the image again after a reload.
    const [firstUser] = sessionMessages(nodes.session(session.id), attachments.forNode);
    expect(firstUser?.parts).toEqual([{ type: "text", content: "look at #1 please" }, imagePart]);
  });

  test("refuses images for a text-only model and unknown attachments", async () => {
    const { handle, imagePart } = await imageSetup("deep-1");
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

    const unsupported = await post([{ type: "text", content: "look at this" }, imagePart]);
    expect(unsupported.status).toBe(422);
    expect(await unsupported.json()).toMatchObject({ error: "images_not_supported" });

    const unknown = await post([
      { type: "image", source: { type: "url", value: attachmentUrl("f".repeat(64)) } },
    ]);
    expect(unknown.status).toBe(400);
  });
});
