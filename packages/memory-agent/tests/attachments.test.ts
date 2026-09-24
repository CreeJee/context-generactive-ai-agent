import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Result } from "effect";
import { describe, expect, test } from "vite-plus/test";
import {
  Attachments,
  maxModelImageBytes,
  modelImageEdge,
  sniffImageType,
} from "../src/attachments/attachments.ts";
import { requireRuntime } from "../src/runtime/resources.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { tinyPng } from "./support/images.ts";
import { testRuntime } from "./support/runtime.ts";

describe("sniffImageType", () => {
  test("reads the type from the bytes", () => {
    expect(sniffImageType(tinyPng)).toBe("image/png");
    expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImageType(Buffer.from("GIF89a"))).toBe("image/gif");
    expect(sniffImageType(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffImageType(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
  });
});

test("a storage write failure is a typed attachment error", async () => {
  const { runtime, storage } = await testRuntime();
  renameSync(join(storage, "attachments"), join(storage, "attachments.old"));
  writeFileSync(join(storage, "attachments"), "blocked");
  const result = await runtime.runPromise(
    Effect.gen(function* () {
      const attachments = yield* Attachments;
      return yield* Effect.result(attachments.save(tinyPng));
    }),
  );
  expect(
    Result.match(result, {
      onFailure: (error) => {
        switch (error._tag) {
          case "AttachmentStorageFailed":
            return { tag: error._tag, operation: error.operation };
          case "AttachmentRejected":
            return { tag: error._tag, operation: null };
        }
      },
      onSuccess: () => null,
    }),
  ).toEqual({ tag: "AttachmentStorageFailed", operation: "save" });
});

describe("Attachments", () => {
  test("stores an image once by content hash and links it to a message in order", async () => {
    const { runtime, project, session, storage } = await testRuntime();
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const attachments = yield* Attachments;
        const first = yield* attachments.save(tinyPng);
        const again = yield* attachments.save(tinyPng);
        const gif = yield* attachments.save(Buffer.from("GIF89a-not-really-but-signed"));
        const node = (yield* Nodes).append({
          projectId: project.id,
          sessionId: session.id,
          kind: "user",
          text: "#1 이랑 #2 비교해줘",
        });
        attachments.link(node.id, [first, gif]);
        return {
          first,
          again,
          linked: attachments.forNode(node.id).map((attachment) => attachment.mimeType),
          dataUrl: yield* Effect.promise(() =>
            attachments.dataUrl({ path: attachments.pathOf(first), mimeType: first.mimeType }),
          ),
          path: attachments.pathOf(first),
        };
      }),
    );
    expect(result.first).toMatchObject({ mimeType: "image/png", bytes: tinyPng.length });
    expect(result.first.id).toMatch(/^[0-9a-f]{64}$/);
    expect(result.again.id).toBe(result.first.id);
    expect(result.linked).toEqual(["image/png", "image/gif"]);
    expect(result.dataUrl).toBe(`data:image/png;base64,${tinyPng.toString("base64")}`);
    expect(result.path.startsWith(join(storage, "attachments"))).toBe(true);
    expect(readFileSync(result.path)).toEqual(tinyPng);
  });

  test("eagerly starts a bounded model WebP and keeps GIFs as uploaded", async () => {
    const { runtime } = await testRuntime();
    const sharp = requireRuntime("sharp");
    // A wide screenshot of text, where a lossless WebP is smaller than the PNG upload.
    const lines = Array.from(
      { length: 28 },
      (_, line) =>
        `<text x="40" y="${40 + line * 34}" font-size="28">const line${line} = await fetchSomething(${line});</text>`,
    ).join("");
    const screenshot = await sharp({
      create: { width: 3000, height: 1000, channels: 3, background: "#f5f5f5" },
    })
      .composite([
        { input: Buffer.from(`<svg width="3000" height="1000">${lines}</svg>`), top: 0, left: 0 },
      ])
      .png()
      .toBuffer();
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const attachments = yield* Attachments;
        const png = yield* attachments.save(screenshot);
        const gif = yield* attachments.save(Buffer.from("GIF89a-not-really-but-signed"));
        const image = yield* Effect.promise(() => attachments.forModel(png));
        return {
          png,
          image,
          again: yield* Effect.promise(() => attachments.forModel(png)),
          gif: yield* Effect.promise(() => attachments.forModel(gif)),
          gifPath: attachments.pathOf(gif),
          dataUrl: yield* Effect.promise(() => attachments.dataUrl(image)),
        };
      }),
    );
    expect(result.image.mimeType).toBe("image/webp");
    expect(result.image.path.endsWith(`${result.png.id}.model.webp`)).toBe(true);
    expect(result.again).toEqual(result.image);
    const size = await sharp(result.image.path).metadata();
    expect([size.width, size.height]).toEqual([modelImageEdge, Math.round((1000 * 2048) / 3000)]);
    expect(statSync(result.image.path).size).toBeLessThanOrEqual(maxModelImageBytes);
    expect(statSync(result.image.path).size).toBeLessThan(result.png.bytes);
    expect(result.dataUrl.startsWith("data:image/webp;base64,")).toBe(true);
    expect(result.gif).toEqual({ path: result.gifPath, mimeType: "image/gif" });
  });

  test("keeps the upload when a WebP copy would not be smaller", async () => {
    const { runtime } = await testRuntime();
    // A repeating pattern PNG compresses better than lossless WebP does.
    const pixels = Buffer.alloc(3000 * 1000 * 3);
    for (let index = 0; index < pixels.length; index++) pixels[index] = (index * 7919) % 251;
    const pattern = await requireRuntime("sharp")(pixels, {
      raw: { width: 3000, height: 1000, channels: 3 },
    })
      .png()
      .toBuffer();
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const attachments = yield* Attachments;
        const png = yield* attachments.save(pattern);
        return {
          image: yield* Effect.promise(() => attachments.forModel(png)),
          upload: attachments.pathOf(png),
        };
      }),
    );
    expect(result.image).toEqual({ path: result.upload, mimeType: "image/png" });
  });

  test("rejects empty, unknown and malformed ids without touching the filesystem", async () => {
    const { runtime, storage } = await testRuntime();
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const attachments = yield* Attachments;
        return {
          empty: yield* Effect.result(attachments.save(new Uint8Array())),
          svg: yield* Effect.result(attachments.save(Buffer.from("<svg/>"))),
          traversal: attachments.get("../agent.db"),
          missing: attachments.get("0".repeat(64)),
        };
      }),
    );
    const reason = (result: typeof outcome.empty) =>
      Result.match(result, {
        onFailure: (error) => (error._tag === "AttachmentRejected" ? error.reason : error._tag),
        onSuccess: () => "saved",
      });
    expect(reason(outcome.empty)).toBe("empty");
    expect(reason(outcome.svg)).toBe("unsupported_type");
    expect(outcome.traversal).toBeNull();
    expect(outcome.missing).toBeNull();
    expect(existsSync(join(storage, "attachments"))).toBe(true);
  });
});
