import type { NormalizedStreamEvent } from "../src/oauth/protocol.ts";
import { nativeStream } from "../src/runtime/native-stream.ts";
import { Stream } from "effect";
import { it } from "@effect/vitest";
import { NodeCrypto, NodeFileSystem, NodePath } from "@effect/platform-node";
import { Array as EffectArray } from "effect";
import { Cause, Crypto, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { build } from "vite";
import { expect } from "vite-plus/test";
import {
  loadTrustedNativeArtifact,
  nativeFactoryLoaderContract,
} from "../src/agent/native-artifact-loader.ts";

const sdkCall = Effect.fn("nativeLoaderTest.sdkCall")(function* <A>(
  operation: () => A | PromiseLike<A>,
) {
  return yield* Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: (cause) => new Cause.UnknownError(cause),
  });
});
const descriptor = Effect.fn("nativeLoaderTest.descriptor")(function* (
  file: string,
  bytes: string,
) {
  const path = yield* Path.Path;
  return {
    fileUrl: (yield* path.toFileUrl(file)).href,
    sha256: Buffer.from(
      yield* (yield* Crypto.Crypto).digest("SHA-256", new TextEncoder().encode(bytes)),
    ).toString("hex"),
    contractVersion: nativeFactoryLoaderContract,
  };
});
const fixture = Effect.fn("nativeLoaderTest.fixture")(function* <A, E, R>(
  program: (directory: string, root: string) => Effect.Effect<A, E, R>,
) {
  const services = yield* Layer.build(
    Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer),
  );
  const setup = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* path.fromFileUrl(new URL("../", import.meta.url));
    const directory = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ directory: root, prefix: ".loader-test-" }),
    );
    return yield* program(directory, root);
  });
  return yield* Effect.provideContext(setup, services);
});

// Negative fixtures intentionally cross the loader's schema boundary.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
const rejection = (input: unknown, directory: string, explicitlyTrusted = true) =>
  loadTrustedNativeArtifact(input, { explicitlyTrusted, ownerControlledDirectory: directory }).pipe(
    Effect.flip,
    Effect.scoped,
  );

it.live("invalid trust/hash/contract/path never evaluates marker bytes", () =>
  fixture((directory) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const marker = path.join(directory, "marker");
      const bytes = `import {writeFileSync} from 'node:fs'; writeFileSync(${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(marker)}, 'evaluated');`;
      const file = path.join(directory, "artifact.mjs");
      yield* fs.writeFileString(file, bytes);
      const saved = yield* descriptor(file, bytes);
      expect((yield* rejection(saved, directory, false)).reason).toBe("trust");
      expect((yield* rejection({ ...saved, sha256: "0".repeat(64) }, directory)).reason).toBe(
        "integrity",
      );
      expect((yield* rejection({ ...saved, contractVersion: "v2" }, directory)).reason).toBe(
        "descriptor",
      );
      expect(
        (yield* rejection({ ...saved, fileUrl: saved.fileUrl + "?v=1" }, directory)).reason,
      ).toBe("path");
      const link = path.join(directory, "link.mjs");
      yield* fs.symlink(file, link);
      expect((yield* rejection(yield* descriptor(link, bytes), directory)).reason).toBe("path");
      expect((yield* rejection(yield* descriptor(directory, bytes), directory)).reason).toBe(
        "path",
      );
      expect(yield* fs.readDirectory(directory)).not.toContain("marker");
      expect((yield* rejection(saved, directory)).reason).toBe("exports");
      expect(yield* fs.readDirectory(directory)).toContain("marker");
      expect(
        (yield* fs.readDirectory(directory)).some((name) => name.startsWith(".verified-native-")),
      ).toBe(false);
      yield* fs.writeFileString(file, "throw new Error('bad artifact');");
      expect(
        (yield* rejection(yield* descriptor(file, "throw new Error('bad artifact');"), directory))
          .reason,
      ).toBe("evaluation");
    }),
  ),
);

it.live(
  "real bundled A/B/A subscription factories execute verified snapshots with scoped staging",
  () =>
    fixture((directory, root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* sdkCall(() =>
          build({
            configFile: false,
            root,
            logLevel: "silent",
            build: {
              write: false,
              minify: false,
              lib: {
                entry: path.join(root, "src/agent/native-artifact-entry.ts"),
                formats: ["es"],
              },
              rollupOptions: {
                external: (id) =>
                  !id.startsWith(".") && !id.startsWith("/") && !id.startsWith("\0"),
              },
            },
          }),
        );
        const outputs = Array.isArray(result) ? result : [result];
        expect(outputs).toHaveLength(1);
        // SAFETY: finite non-watch build returns output; single output checked above.
        const output = outputs[0] as Extract<
          Awaited<ReturnType<typeof build>>,
          { output: unknown }
        >;
        const chunks = output.output.filter((item) => item.type === "chunk");
        expect(chunks).toHaveLength(1);
        const code = chunks[0]!.code;
        const a = path.join(directory, "a.mjs");
        const b = path.join(directory, "b.mjs");
        yield* fs.writeFileString(a, code);
        yield* fs.writeFileString(b, code + "\n// generation B\n");
        const urls: string[] = [];
        for (const saved of [
          yield* descriptor(a, code),
          yield* descriptor(b, code + "\n// generation B\n"),
          yield* descriptor(a, code),
        ]) {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const loaded = yield* loadTrustedNativeArtifact(saved, {
                explicitlyTrusted: true,
                ownerControlledDirectory: directory,
              });
              urls.push(loaded.stagedUrl);
              // Replacing the source after acquisition cannot replace the verified evaluated snapshot.
              yield* fs.writeFileString(
                yield* path.fromFileUrl(new URL(saved.fileUrl)),
                "throw new Error('source replaced');",
              );
              const implementation =
                loaded.factories.createSubscriptionRuntimeImplementation("openai");
              let clients = 0;
              const bound = implementation.bind({
                client: () => {
                  clients++;
                  return {
                    stream: function () {
                      return nativeStream(
                        Stream.suspend(() =>
                          Stream.fromIterable(
                            (function* (): Generator<NormalizedStreamEvent> {
                              yield { type: "text" as const, text: "unused" };
                            })(),
                          ),
                        ),
                      );
                    },
                  };
                },
              });
              expect(bound.runMiddleware().name).toContain("subscription-run");
              expect(clients).toBe(0);
            }),
          );
          yield* fs.writeFileString(a, code);
          yield* fs.writeFileString(b, code + "\n// generation B\n");
          expect(
            (yield* fs.readDirectory(directory)).some((name) =>
              name.startsWith(".verified-native-"),
            ),
          ).toBe(false);
        }
        expect(EffectArray.dedupe(urls).length).toBe(3);
      }),
    ),
  60_000,
);
