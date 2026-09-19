import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Either, Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { sessionMessages } from "../src/agent/history.ts";
import { Attachments, maxDrawingBytes } from "../src/attachments/attachments.ts";
import { DrawingPreviews } from "../src/attachments/previews.ts";
import type { JsonValue } from "../src/json.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { requireRuntime } from "../src/runtime/resources.ts";
import { FileTools } from "../src/tools/files.ts";
import { testRuntime } from "./support/runtime.ts";

const svg = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 64 64">${body}</svg>`;

/** The colour at the centre of a stored picture. */
async function centre(path: string) {
  const { data, info } = await requireRuntime("sharp")(path)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const at = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * 3;
  return [data[at], data[at + 1], data[at + 2]];
}

describe("Attachments.saveDrawing", () => {
  test("stores what an SVG looks like as a PNG", async () => {
    const { runtime } = await testRuntime();
    const colour = await runtime.runPromise(
      Effect.gen(function* () {
        const attachments = yield* Attachments;
        const picture = yield* attachments.saveDrawing(
          Buffer.from(svg('<rect width="64" height="64" fill="#ff0000"/>')),
        );
        expect(picture.mimeType).toBe("image/png");
        return yield* Effect.promise(() => centre(attachments.pathOf(picture)));
      }),
    );
    expect(colour).toEqual([255, 0, 0]);
  });

  test("never copies a file the SVG points at into the picture", async () => {
    const { runtime, base } = await testRuntime();
    // A green square on disk; an SVG written by a prompt-injected model tries to embed it.
    const secret = join(base, "secret.png");
    await requireRuntime("sharp")({
      create: { width: 64, height: 64, channels: 3, background: "#00ff00" },
    })
      .png()
      .toFile(secret);

    const colours = await runtime.runPromise(
      Effect.gen(function* () {
        const attachments = yield* Attachments;
        const seen: number[][] = [];
        for (const href of [`file://${secret}`, secret, "secret.png"]) {
          const picture = yield* attachments.saveDrawing(
            Buffer.from(
              svg(
                `<rect width="64" height="64" fill="#ffffff"/><image href="${href}" xlink:href="${href}" width="64" height="64"/>`,
              ),
            ),
          );
          seen.push(yield* Effect.promise(() => centre(attachments.pathOf(picture))));
        }
        return seen;
      }),
    );
    // White everywhere: the reference was refused, not rendered.
    expect(colours).toEqual([
      [255, 255, 255],
      [255, 255, 255],
      [255, 255, 255],
    ]);
  });

  test("refuses empty, oversized and unreadable drawings", async () => {
    const { runtime } = await testRuntime();
    const reasons = await runtime.runPromise(
      Effect.gen(function* () {
        const attachments = yield* Attachments;
        const reasonOf = (bytes: Uint8Array) =>
          Effect.map(Effect.either(attachments.saveDrawing(bytes)), (outcome) =>
            Either.isLeft(outcome) ? outcome.left.reason : "saved",
          );
        return [
          yield* reasonOf(new Uint8Array()),
          yield* reasonOf(new Uint8Array(maxDrawingBytes + 1)),
          yield* reasonOf(Buffer.from("not an svg at all")),
        ];
      }),
    );
    expect(reasons).toEqual(["empty", "too_large", "unsupported_type"]);
  });
});

const Written = Schema.Struct({
  path: Schema.String,
  sha256: Schema.String,
  preview: Schema.optional(Schema.Struct({ attachmentId: Schema.String, mimeType: Schema.String })),
});
const decodeWritten = Schema.decodeUnknownSync(Written);

describe("DrawingPreviews", () => {
  const toolsFor = async () => {
    const setup = await testRuntime();
    const tools = await setup.runtime.runPromise(
      Effect.gen(function* () {
        const files = (yield* FileTools).forProject(setup.project);
        return (yield* DrawingPreviews).withPreviews(setup.project, files);
      }),
    );
    const call = async (name: string, args: { readonly [key: string]: JsonValue }) => {
      const tool = tools.find((candidate) => candidate.name === name);
      return tool?.execute?.(args, { toolCallId: name, emitCustomEvent: () => undefined });
    };
    return { ...setup, call };
  };

  test("a written SVG comes back with a picture of it, and the result is otherwise the same", async () => {
    const { call, runtime } = await toolsFor();
    const result = decodeWritten(
      await call("write_file", {
        path: "docs/figure.svg",
        content: svg('<rect width="64" height="64" fill="#0000ff"/>'),
      }),
    );
    expect(result.path).toBe("docs/figure.svg");
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.preview?.mimeType).toBe("image/png");

    const colour = await runtime.runPromise(
      Effect.gen(function* () {
        const attachments = yield* Attachments;
        const picture = attachments.get(result.preview?.attachmentId ?? "");
        expect(picture).not.toBeNull();
        return yield* Effect.promise(() => centre(attachments.pathOf(picture!)));
      }),
    );
    expect(colour).toEqual([0, 0, 255]);
  });

  test("an edit takes a new picture; the first one stays as it was", async () => {
    const { call } = await toolsFor();
    const first = decodeWritten(
      await call("write_file", {
        path: "figure.svg",
        content: svg('<rect width="64" height="64" fill="#0000ff"/>'),
      }),
    );
    const edited = decodeWritten(
      await call("edit_file", { path: "figure.svg", oldText: "#0000ff", newText: "#ff0000" }),
    );
    expect(edited.preview?.attachmentId).toBeDefined();
    expect(edited.preview?.attachmentId).not.toBe(first.preview?.attachmentId);
  });

  test("a chat run records the picture with the result, so a reloaded page shows it", async () => {
    const context = await testRuntime({ testProvider: {} });
    const { runtime, session } = context;
    await context.provider!.select(runtime);
    const args = JSON.stringify({
      path: "arch.svg",
      content: svg('<rect width="64" height="64" fill="#00aa00"/>'),
    });
    const response = await runtime.runPromise(
      Effect.flatMap(AgentChat, (agent) =>
        agent.handle(
          new Request("http://127.0.0.1/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              threadId: session.id,
              runId: "run-draw",
              messages: [{ id: "m1", role: "user", content: `call write_file ${args}` }],
              tools: [],
              context: [],
            }),
          }),
          session.id,
        ),
      ),
    );
    expect(await response.text()).toContain("attachmentId");

    const stored = await runtime.runPromise(
      Effect.map(Nodes, (nodes) =>
        nodes.session(session.id).find((node) => node.kind === "tool_result"),
      ),
    );
    const preview = decodeWritten(JSON.parse(stored?.text ?? "{}")).preview;
    expect(preview?.mimeType).toBe("image/png");
    const reloaded = sessionMessages(
      await runtime.runPromise(Effect.map(Nodes, (nodes) => nodes.session(session.id))),
      () => [],
    );
    expect(JSON.stringify(reloaded)).toContain(preview?.attachmentId ?? "missing");
  });

  test("other files and unrenderable SVGs are written without a picture", async () => {
    const { call, project } = await toolsFor();
    expect(
      decodeWritten(await call("write_file", { path: "notes.md", content: "# hi" })).preview,
    ).toBeUndefined();

    // Written fine, but not something the renderer can draw: the write still stands.
    const broken = decodeWritten(await call("write_file", { path: "broken.svg", content: "<svg" }));
    expect(broken.preview).toBeUndefined();
    expect(broken.path).toBe("broken.svg");

    // A tool that is not a writer is left alone even when it reads an SVG.
    writeFileSync(join(project.root, "read.svg"), svg(""));
    const read = await call("read_file", { path: "read.svg" });
    expect(Schema.decodeUnknownSync(Schema.Struct({ path: Schema.String }))(read).path).toBe(
      "read.svg",
    );
    expect(JSON.stringify(read)).not.toContain("preview");
  });
});
