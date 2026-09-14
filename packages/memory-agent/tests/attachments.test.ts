import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Either } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { Attachments, sniffImageType } from "../src/attachments/attachments.ts";
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
          dataUrl: yield* Effect.promise(() => attachments.dataUrl(first)),
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

  test("rejects empty, unknown and malformed ids without touching the filesystem", async () => {
    const { runtime, storage } = await testRuntime();
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const attachments = yield* Attachments;
        return {
          empty: yield* Effect.either(attachments.save(new Uint8Array())),
          svg: yield* Effect.either(attachments.save(Buffer.from("<svg/>"))),
          traversal: attachments.get("../agent.db"),
          missing: attachments.get("0".repeat(64)),
        };
      }),
    );
    expect(Either.isLeft(outcome.empty) && outcome.empty.left.reason).toBe("empty");
    expect(Either.isLeft(outcome.svg) && outcome.svg.left.reason).toBe("unsupported_type");
    expect(outcome.traversal).toBeNull();
    expect(outcome.missing).toBeNull();
    expect(existsSync(join(storage, "attachments"))).toBe(true);
  });
});
