import { Effect, FileSystem, Match, Path, Schema } from "effect";
import type { SqlError } from "effect/sql";
import { expect } from "vite-plus/test";
import { sessionMessages } from "../../src/agent/history.ts";
import {
  type AttachmentRejected,
  Attachments,
  type AttachmentStorageFailed,
  maxDrawingBytes,
  maxModelImageBytes,
  modelImageEdge,
} from "../../src/attachments/attachments.ts";
import { DrawingPreviews } from "../../src/attachments/previews.ts";
import type { JsonValue } from "../../src/json.ts";
import { Nodes } from "../../src/memory/nodes.ts";
import { requireRuntime } from "../../src/runtime/resources.ts";
import { FileTools } from "../../src/tools/files.ts";
import { runTurn, toolResults } from "../support/chat-client.ts";
import { tinyPng } from "../support/images.ts";
import { callTool } from "../support/run-tools.ts";
import { selectTestModel } from "../support/provider.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";
import { current, freshSession, sdk } from "./tab.ts";

const gif = Buffer.from("GIF89a-not-really-but-signed");

const svg = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 64 64">${body}</svg>`;
const square = (fill: string) => svg(`<rect width="64" height="64" fill="${fill}"/>`);

/** The colour at the centre of a stored picture. */
const centre = Effect.fnUntraced(function* (path: string) {
  const sharp = yield* requireRuntime("sharp");
  const { data, info } = yield* sdk(() =>
    sharp(path).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
  );
  const at = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * 3;
  return [data[at], data[at + 1], data[at + 2]];
});

/** What a rejected save reports: the rejection reason, or the tag of any other failure. */
const refusalOf = <A>(
  save: Effect.Effect<
    A,
    AttachmentRejected | AttachmentStorageFailed | SqlError.SqlError | Schema.SchemaError
  >,
) =>
  Effect.match(save, {
    onFailure: (error) =>
      Match.valueTags(error, {
        AttachmentRejected: (rejected) => rejected.reason,
        AttachmentStorageFailed: (failed) => `AttachmentStorageFailed:${failed.operation}`,
        SqlError: () => "SqlError",
        SchemaError: () => "SchemaError",
      }),
    onSuccess: () => "saved",
  });

const samples = {
  empty: new Uint8Array(),
  svg: Buffer.from("<svg/>"),
  oversized: new Uint8Array(maxDrawingBytes + 1),
  text: Buffer.from("not an svg at all"),
};

const Written = Schema.Struct({
  path: Schema.String,
  sha256: Schema.String,
  preview: Schema.optional(Schema.Struct({ attachmentId: Schema.String, mimeType: Schema.String })),
});
const decodeWritten = Schema.decodeUnknownEffect(Written);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/** The project's file tools wrapped with drawing previews, called as the model would. */
const fileTool = Effect.fnUntraced(function* (name: string, args: Record<string, JsonValue>) {
  const { project } = yield* TestEnv;
  const files = (yield* FileTools).toolsFor(project);
  return yield* callTool((yield* DrawingPreviews).withPreviews(project, files), name, args);
});

/** Replace the attachment directory with a file until the test ends. */
const blockAttachmentStorage = Effect.gen(function* () {
  const { storage } = yield* TestEnv;
  const fs = yield* FileSystem.FileSystem;
  const directory = (yield* Path.Path).join(storage, "attachments");
  const moved = `${directory}.old`;
  yield* Effect.acquireRelease(
    Effect.andThen(fs.rename(directory, moved), fs.writeFileString(directory, "blocked")),
    () => Effect.orDie(Effect.andThen(fs.remove(directory), fs.rename(moved, directory))),
  );
});

testAgent({ testProvider: {} })("attachments", (it) => {
  it.effect("stores an image once by content hash and links it to a message in order", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { project, storage } = yield* TestEnv;
      const attachments = yield* Attachments;
      const first = yield* attachments.save(tinyPng);
      const again = yield* attachments.save(tinyPng);
      const animated = yield* attachments.save(gif);
      const node = yield* (yield* Nodes).append({
        projectId: project.id,
        sessionId: yield* freshSession,
        kind: "user",
        text: "#1 이랑 #2 비교해줘",
      });
      yield* attachments.link(node.id, [first, animated]);
      expect(first).toMatchObject({ mimeType: "image/png", bytes: tinyPng.length });
      expect(first.id).toMatch(/^[0-9a-f]{64}$/);
      expect(again.id).toBe(first.id);
      expect(
        (yield* attachments.forNode(node.id)).map((attachment) => attachment.mimeType),
      ).toEqual(["image/png", "image/gif"]);
      const stored = attachments.pathOf(first);
      expect(yield* attachments.dataUrl({ path: stored, mimeType: first.mimeType })).toBe(
        `data:image/png;base64,${tinyPng.toString("base64")}`,
      );
      expect(stored.startsWith(path.join(storage, "attachments"))).toBe(true);
      expect(Buffer.from(yield* fs.readFile(stored))).toEqual(tinyPng);
    }),
  );

  it.effect(
    "eagerly starts a bounded model WebP and keeps GIFs as uploaded",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const sharp = yield* requireRuntime("sharp");
        // A wide screenshot of text, where a lossless WebP is smaller than the PNG upload.
        const lines = Array.from(
          { length: 28 },
          (_, line) =>
            `<text x="40" y="${40 + line * 34}" font-size="28">const line${line} = await fetchSomething(${line});</text>`,
        ).join("");
        const screenshot = yield* sdk(() =>
          sharp({ create: { width: 3000, height: 1000, channels: 3, background: "#f5f5f5" } })
            .composite([
              {
                input: Buffer.from(`<svg width="3000" height="1000">${lines}</svg>`),
                top: 0,
                left: 0,
              },
            ])
            .png()
            .toBuffer(),
        );
        const attachments = yield* Attachments;
        const png = yield* attachments.save(screenshot);
        const animated = yield* attachments.save(gif);
        const image = yield* attachments.forModel(png);
        expect(image.mimeType).toBe("image/webp");
        expect(image.path.endsWith(`${png.id}.model.webp`)).toBe(true);
        expect(yield* attachments.forModel(png)).toEqual(image);
        const size = yield* sdk(() => sharp(image.path).metadata());
        expect([size.width, size.height]).toEqual([
          modelImageEdge,
          Math.round((1000 * 2048) / 3000),
        ]);
        const bytes = Number((yield* fs.stat(image.path)).size);
        expect(bytes).toBeLessThanOrEqual(maxModelImageBytes);
        expect(bytes).toBeLessThan(png.bytes);
        expect((yield* attachments.dataUrl(image)).startsWith("data:image/webp;base64,")).toBe(
          true,
        );
        expect(yield* attachments.forModel(animated)).toEqual({
          path: attachments.pathOf(animated),
          mimeType: "image/gif",
        });
      }),
    // Sharp encodes a 3000×1000 image, which takes seconds on a loaded machine.
    15_000,
  );

  it.effect(
    "keeps the upload when a WebP copy would not be smaller",
    () =>
      Effect.gen(function* () {
        // A repeating pattern PNG compresses better than lossless WebP does.
        const pixels = Buffer.alloc(3000 * 1000 * 3);
        for (let index = 0; index < pixels.length; index++) pixels[index] = (index * 7919) % 251;
        const sharp = yield* requireRuntime("sharp");
        const pattern = yield* sdk(() =>
          sharp(pixels, { raw: { width: 3000, height: 1000, channels: 3 } })
            .png()
            .toBuffer(),
        );
        const attachments = yield* Attachments;
        const png = yield* attachments.save(pattern);
        expect(yield* attachments.forModel(png)).toEqual({
          path: attachments.pathOf(png),
          mimeType: "image/png",
        });
      }),
    15_000,
  );

  it.effect.each([
    { kind: "image", sample: "empty", reason: "empty" },
    { kind: "image", sample: "svg", reason: "unsupported_type" },
    { kind: "drawing", sample: "empty", reason: "empty" },
    { kind: "drawing", sample: "oversized", reason: "too_large" },
    { kind: "drawing", sample: "text", reason: "unsupported_type" },
  ] as const)("refuses $sample bytes as $kind with $reason", ({ kind, sample, reason }) =>
    Effect.gen(function* () {
      const attachments = yield* Attachments;
      const bytes = samples[sample];
      switch (kind) {
        case "image":
          return expect(yield* refusalOf(attachments.save(bytes))).toBe(reason);
        case "drawing":
          return expect(yield* refusalOf(attachments.saveDrawing(bytes))).toBe(reason);
      }
    }),
  );

  it.effect("looks up malformed and unknown ids without touching the filesystem", () =>
    Effect.gen(function* () {
      const attachments = yield* Attachments;
      expect(yield* attachments.get("../agent.db")).toBeNull();
      expect(yield* attachments.get("0".repeat(64))).toBeNull();
    }),
  );

  it.effect("stores what an SVG looks like as a PNG", () =>
    Effect.gen(function* () {
      const attachments = yield* Attachments;
      const picture = yield* attachments.saveDrawing(Buffer.from(square("#ff0000")));
      expect(picture.mimeType).toBe("image/png");
      expect(yield* centre(attachments.pathOf(picture))).toEqual([255, 0, 0]);
    }),
  );

  it.effect("never copies a file the SVG points at into the picture", () =>
    Effect.gen(function* () {
      const { base } = yield* TestEnv;
      const attachments = yield* Attachments;
      // A green square on disk; an SVG written by a prompt-injected model tries to embed it.
      const secret = (yield* Path.Path).join(base, "secret.png");
      const sharp = yield* requireRuntime("sharp");
      yield* sdk(() =>
        sharp({
          create: { width: 64, height: 64, channels: 3, background: "#00ff00" },
        })
          .png()
          .toFile(secret),
      );
      const colours = yield* Effect.forEach([`file://${secret}`, secret, "secret.png"], (href) =>
        attachments
          .saveDrawing(
            Buffer.from(
              svg(
                `<rect width="64" height="64" fill="#ffffff"/><image href="${href}" xlink:href="${href}" width="64" height="64"/>`,
              ),
            ),
          )
          .pipe(Effect.flatMap((picture) => centre(attachments.pathOf(picture)))),
      );
      // White everywhere: the reference was refused, not rendered.
      expect(colours).toEqual([
        [255, 255, 255],
        [255, 255, 255],
        [255, 255, 255],
      ]);
    }),
  );

  it.effect(
    "a written SVG comes back with a picture of it, and the result is otherwise the same",
    () =>
      Effect.gen(function* () {
        const result = yield* decodeWritten(
          yield* fileTool("write_file", { path: "docs/figure.svg", content: square("#0000ff") }),
        );
        expect(result.path).toBe("docs/figure.svg");
        expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(result.preview?.mimeType).toBe("image/png");
        const attachments = yield* Attachments;
        const picture = yield* attachments.get(result.preview?.attachmentId ?? "");
        expect(picture).not.toBeNull();
        expect(yield* centre(attachments.pathOf(picture!))).toEqual([0, 0, 255]);
      }),
  );

  it.effect("an edit takes a new picture; the first one stays as it was", () =>
    Effect.gen(function* () {
      const first = yield* decodeWritten(
        yield* fileTool("write_file", { path: "figure.svg", content: square("#0000ff") }),
      );
      const edited = yield* decodeWritten(
        yield* fileTool("edit_file", {
          path: "figure.svg",
          oldText: "#0000ff",
          newText: "#ff0000",
        }),
      );
      expect(edited.preview?.attachmentId).toBeDefined();
      expect(edited.preview?.attachmentId).not.toBe(first.preview?.attachmentId);
    }),
  );

  it.effect("other files and unrenderable SVGs are written without a picture", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { project } = yield* TestEnv;
      expect(
        (yield* decodeWritten(yield* fileTool("write_file", { path: "notes.md", content: "# hi" })))
          .preview,
      ).toBeUndefined();
      // Written fine, but not something the renderer can draw: the write still stands.
      const broken = yield* decodeWritten(
        yield* fileTool("write_file", { path: "broken.svg", content: "<svg" }),
      );
      expect(broken.preview).toBeUndefined();
      expect(broken.path).toBe("broken.svg");
      // A tool that is not a writer is left alone even when it reads an SVG.
      yield* fs.writeFileString(path.join(project.root, "read.svg"), svg(""));
      const read = yield* fileTool("read_file", { path: "read.svg" });
      expect(
        (yield* Schema.decodeUnknownEffect(Schema.Struct({ path: Schema.String }))(read)).path,
      ).toBe("read.svg");
      expect(yield* encodeJson(read)).not.toContain("preview");
    }),
  );

  it.effect("a chat run records the picture with the result, so a reloaded page shows it", () =>
    Effect.gen(function* () {
      yield* selectTestModel();
      const sessionId = yield* freshSession;
      const args = yield* encodeJson({ path: "arch.svg", content: square("#00aa00") });
      const events = yield* runTurn(sessionId, `${sessionId}-draw`, `call write_file ${args}`);
      expect(toolResults(events).join("\n")).toContain("attachmentId");
      const nodes = yield* (yield* Nodes).session(sessionId);
      const stored = nodes.find((node) => node.kind === "tool_result");
      const preview = (yield* Schema.decodeEffect(Schema.fromJsonString(Written))(
        stored?.text ?? "{}",
      )).preview;
      expect(preview?.mimeType).toBe("image/png");
      expect(yield* encodeJson(sessionMessages(nodes, () => []))).toContain(
        preview?.attachmentId ?? "missing",
      );
    }),
  );
});

// Blocking the attachment directory affects every attachment in the agent.
testAgent()("attachments over blocked storage", (it) => {
  it.effect("a storage write failure is a typed attachment error", () =>
    Effect.gen(function* () {
      yield* blockAttachmentStorage;
      expect(yield* refusalOf((yield* Attachments).save(tinyPng))).toBe(
        "AttachmentStorageFailed:save",
      );
    }),
  );

  it.effect(
    "a failed preview storage write does not turn a successful file write into a tool failure",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { project } = yield* TestEnv;
        yield* blockAttachmentStorage;
        const result = yield* decodeWritten(
          yield* fileTool("write_file", { path: "drawing.svg", content: square("#ff0000") }),
        );
        expect(result.path).toBe("drawing.svg");
        expect(result.preview).toBeUndefined();
        expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(yield* fs.readFileString(path.join(project.root, result.path))).toContain("#ff0000");
      }),
  );
});

// Closing the agent is a reopen, so this block reads services through `env.use`.
testAgent()("attachments across closing the agent", (it) => {
  it.effect("closing the agent waits for its eager model conversion before storage cleanup", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sharp = yield* requireRuntime("sharp");
      const png = yield* sdk(() =>
        sharp({
          create: { width: 512, height: 512, channels: 3, background: "#00ff00" },
        })
          .png()
          .toBuffer(),
      );
      const sessionId = yield* freshSession;
      // Linked to a message, so reopening does not purge it as an orphan.
      const attachment = yield* current(
        Effect.gen(function* () {
          const attachments = yield* Attachments;
          const saved = yield* attachments.save(png);
          const node = yield* (yield* Nodes).append({
            projectId: env.project.id,
            sessionId,
            kind: "user",
            text: "#1",
          });
          yield* attachments.link(node.id, [saved]);
          return saved;
        }),
      );
      yield* env.reopen;
      const directory = path.join(env.storage, "attachments");
      expect(
        (yield* fs.exists(path.join(directory, `${attachment.id}.model.webp`))) ||
          (yield* fs.exists(path.join(directory, `${attachment.id}.model-original`))),
      ).toBe(true);
    }),
  );
});
