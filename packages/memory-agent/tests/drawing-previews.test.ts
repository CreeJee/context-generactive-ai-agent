import { Cause, Effect, FileSystem, Path, Result, Schema } from "effect";
import { it } from "@effect/vitest";
import { withTestPlatform } from "./support/platform.ts";
import { selectTestModel } from "./support/provider.ts";
import { describe, expect } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { sessionMessages } from "../src/agent/history.ts";
import { Attachments, maxDrawingBytes } from "../src/attachments/attachments.ts";
import { DrawingPreviews } from "../src/attachments/previews.ts";
import type { JsonValue } from "../src/json.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { requireRuntime } from "../src/runtime/resources.ts";
import { FileTools } from "../src/tools/files.ts";
import { testRuntime } from "./support/runtime.ts";

const sdkCall = Effect.fn("drawingPreview.sdkCall")(function* <A>(
  operation: () => A | PromiseLike<A>,
) {
  return yield* Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: (cause) => new Cause.UnknownError(cause),
  });
});

const svg = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 64 64">${body}</svg>`;

/** The colour at the centre of a stored picture. */
const centre = Effect.fn("drawingPreview.centre")(function* (path: string) {
  const { data, info } = yield* sdkCall(() =>
    requireRuntime("sharp")(path).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
  );
  const at = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * 3;
  return [data[at], data[at + 1], data[at + 2]];
});

describe("Attachments.saveDrawing", () => {
  it.live("stores what an SVG looks like as a PNG", () =>
    Effect.gen(function* () {
      const { runtime } = yield* sdkCall(() => testRuntime());
      const colour = yield* Effect.provideContext(
        Effect.gen(function* () {
          const attachments = yield* Attachments;
          const picture = yield* attachments.saveDrawing(
            Buffer.from(svg('<rect width="64" height="64" fill="#ff0000"/>')),
          );
          expect(picture.mimeType).toBe("image/png");
          return yield* centre(attachments.pathOf(picture));
        }),
        yield* runtime.contextEffect,
      );
      expect(colour).toEqual([255, 0, 0]);
    }).pipe(withTestPlatform),
  );

  it.live("never copies a file the SVG points at into the picture", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { runtime, base } = yield* sdkCall(() => testRuntime());
      // A green square on disk; an SVG written by a prompt-injected model tries to embed it.
      const secret = path.join(base, "secret.png");
      yield* sdkCall(() =>
        requireRuntime("sharp")({
          create: { width: 64, height: 64, channels: 3, background: "#00ff00" },
        })
          .png()
          .toFile(secret),
      );
      const colours = yield* Effect.provideContext(
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
            seen.push(yield* centre(attachments.pathOf(picture)));
          }
          return seen;
        }),
        yield* runtime.contextEffect,
      );
      // White everywhere: the reference was refused, not rendered.
      expect(colours).toEqual([
        [255, 255, 255],
        [255, 255, 255],
        [255, 255, 255],
      ]);
    }).pipe(withTestPlatform),
  );

  it.live("refuses empty, oversized and unreadable drawings", () =>
    Effect.gen(function* () {
      const { runtime } = yield* sdkCall(() => testRuntime());
      const reasons = yield* Effect.provideContext(
        Effect.gen(function* () {
          const attachments = yield* Attachments;
          const reasonOf = (bytes: Uint8Array) =>
            Effect.map(Effect.result(attachments.saveDrawing(bytes)), (outcome) =>
              Result.match(outcome, {
                onFailure: (error) =>
                  error._tag === "AttachmentRejected" ? error.reason : error._tag,
                onSuccess: () => "saved",
              }),
            );
          return [
            yield* reasonOf(new Uint8Array()),
            yield* reasonOf(new Uint8Array(maxDrawingBytes + 1)),
            yield* reasonOf(Buffer.from("not an svg at all")),
          ];
        }),
        yield* runtime.contextEffect,
      );
      expect(reasons).toEqual(["empty", "too_large", "unsupported_type"]);
    }).pipe(withTestPlatform),
  );
});

const Written = Schema.Struct({
  path: Schema.String,
  sha256: Schema.String,
  preview: Schema.optional(Schema.Struct({ attachmentId: Schema.String, mimeType: Schema.String })),
});
const decodeWritten = Schema.decodeUnknownEffect(Written);

describe("DrawingPreviews", () => {
  const toolsFor = Effect.fn("drawingPreview.toolsFor")(function* () {
    const setup = yield* sdkCall(() => testRuntime());
    const tools = yield* Effect.provideContext(
      Effect.gen(function* () {
        const files = (yield* FileTools).forProject(setup.project);
        return (yield* DrawingPreviews).withPreviews(setup.project, files);
      }),
      yield* setup.runtime.contextEffect,
    );
    const call = Effect.fn("drawingPreview.toolCall")(function* (
      name: string,
      args: { readonly [key: string]: JsonValue },
    ) {
      const tool = tools.find((candidate) => candidate.name === name);
      return yield* sdkCall(() =>
        tool?.execute?.(args, { toolCallId: name, emitCustomEvent: () => undefined }),
      );
    });
    return { ...setup, call };
  });

  it.live(
    "a written SVG comes back with a picture of it, and the result is otherwise the same",
    () =>
      Effect.gen(function* () {
        const { call, runtime } = yield* toolsFor();
        const result = yield* decodeWritten(
          yield* call("write_file", {
            path: "docs/figure.svg",
            content: svg('<rect width="64" height="64" fill="#0000ff"/>'),
          }),
        );
        expect(result.path).toBe("docs/figure.svg");
        expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(result.preview?.mimeType).toBe("image/png");
        const colour = yield* Effect.provideContext(
          Effect.gen(function* () {
            const attachments = yield* Attachments;
            const picture = attachments.get(result.preview?.attachmentId ?? "");
            expect(picture).not.toBeNull();
            return yield* centre(attachments.pathOf(picture!));
          }),
          yield* runtime.contextEffect,
        );
        expect(colour).toEqual([0, 0, 255]);
      }).pipe(withTestPlatform),
  );

  it.live("an edit takes a new picture; the first one stays as it was", () =>
    Effect.gen(function* () {
      const { call } = yield* toolsFor();
      const first = yield* decodeWritten(
        yield* call("write_file", {
          path: "figure.svg",
          content: svg('<rect width="64" height="64" fill="#0000ff"/>'),
        }),
      );
      const edited = yield* decodeWritten(
        yield* call("edit_file", { path: "figure.svg", oldText: "#0000ff", newText: "#ff0000" }),
      );
      expect(edited.preview?.attachmentId).toBeDefined();
      expect(edited.preview?.attachmentId).not.toBe(first.preview?.attachmentId);
    }).pipe(withTestPlatform),
  );

  it.live("a chat run records the picture with the result, so a reloaded page shows it", () =>
    Effect.gen(function* () {
      const context = yield* sdkCall(() => testRuntime({ testProvider: {} }));
      const { runtime, session } = context;
      yield* Effect.provideContext(selectTestModel(), yield* runtime.contextEffect);
      const args = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        path: "arch.svg",
        content: svg('<rect width="64" height="64" fill="#00aa00"/>'),
      });
      const requestBody = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        threadId: session.id,
        runId: "run-draw",
        messages: [{ id: "m1", role: "user", content: `call write_file ${args}` }],
        tools: [],
        context: [],
      });
      const response = yield* Effect.provideContext(
        Effect.flatMap(AgentChat, (agent) =>
          agent.handle(
            new Request("http://127.0.0.1/api/chat", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: requestBody,
            }),
            session.id,
          ),
        ),
        yield* runtime.contextEffect,
      );
      expect(yield* sdkCall(() => response.text())).toContain("attachmentId");
      const stored = yield* Effect.provideContext(
        Effect.map(Nodes, (nodes) =>
          nodes.session(session.id).find((node) => node.kind === "tool_result"),
        ),
        yield* runtime.contextEffect,
      );
      const preview = (yield* Schema.decodeEffect(Schema.fromJsonString(Written))(
        stored?.text ?? "{}",
      )).preview;
      expect(preview?.mimeType).toBe("image/png");
      const reloaded = sessionMessages(
        yield* Effect.provideContext(
          Effect.map(Nodes, (nodes) => nodes.session(session.id)),
          yield* runtime.contextEffect,
        ),
        () => [],
      );
      expect(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(reloaded)).toContain(
        preview?.attachmentId ?? "missing",
      );
    }).pipe(withTestPlatform),
  );

  it.live("other files and unrenderable SVGs are written without a picture", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { call, project } = yield* toolsFor();
      expect(
        (yield* decodeWritten(yield* call("write_file", { path: "notes.md", content: "# hi" })))
          .preview,
      ).toBeUndefined();
      // Written fine, but not something the renderer can draw: the write still stands.
      const broken = yield* decodeWritten(
        yield* call("write_file", { path: "broken.svg", content: "<svg" }),
      );
      expect(broken.preview).toBeUndefined();
      expect(broken.path).toBe("broken.svg");
      // A tool that is not a writer is left alone even when it reads an SVG.
      yield* fs.writeFileString(path.join(project.root, "read.svg"), svg(""));
      const read = yield* call("read_file", { path: "read.svg" });
      expect(
        (yield* Schema.decodeUnknownEffect(Schema.Struct({ path: Schema.String }))(read)).path,
      ).toBe("read.svg");
      expect(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(read)).not.toContain(
        "preview",
      );
    }).pipe(withTestPlatform),
  );

  it.live(
    "a failed preview storage write does not turn a successful file write into a tool failure",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { call, project, storage } = yield* toolsFor();
        yield* fs.rename(path.join(storage, "attachments"), path.join(storage, "attachments.old"));
        yield* fs.writeFileString(path.join(storage, "attachments"), "blocked");
        const result = yield* decodeWritten(
          yield* call("write_file", {
            path: "drawing.svg",
            content: svg('<rect width="64" height="64" fill="#ff0000"/>'),
          }),
        );
        expect(result.path).toBe("drawing.svg");
        expect(result.preview).toBeUndefined();
        expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(yield* fs.readFileString(path.join(project.root, result.path))).toContain("#ff0000");
      }).pipe(withTestPlatform),
  );
});
