import type { NormalizedStreamEvent } from "../src/oauth/protocol.ts";
import { nativeStream } from "../src/runtime/native-stream.ts";
import { Stream } from "effect";
import { it } from "@effect/vitest";
import { withTestPlatform } from "./support/platform.ts";
import { HashSet } from "effect";
import { chat } from "@tanstack/ai";
import { Cause, Effect, FileSystem, Layer, Path } from "effect";
import { Embedder } from "../src/memory/embedding/embedder.ts";
import { fakeVector } from "../src/testing/fake-embedder.ts";
import { build } from "vite";
import { expect } from "vite-plus/test";
import type * as NativeArtifact from "../src/agent/native-artifact-entry.ts";
import { Graph } from "../src/memory/graph.ts";
import { Interpretations } from "../src/memory/interpretations.ts";
import { KnowledgePromotions } from "../src/memory/knowledge.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { MemorySearch } from "../src/memory/search.ts";
import { ScriptedTextAdapter } from "../src/testing/scripted-adapter.ts";
import { permissionReviewInterrupt } from "../src/tools/definitions.ts";
const sdkCall = Effect.fn("nativeBuildTest.sdkCall")(function* <A>(
  operation: () => A | PromiseLike<A>,
) {
  return yield* Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: (cause) => new Cause.UnknownError(cause),
  });
});
import { testRuntime } from "./support/runtime.ts";

it.live(
  "factory bundle imports shared host packages and binds fresh central services",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* path.fromFileUrl(new URL("../", import.meta.url));
      // Keep output under the package so native Node imports resolve the host's dependencies.
      const temporary = yield* fs.makeTempDirectoryScoped({
        directory: root,
        prefix: ".native-artifact-test-",
      });
      const allowedPackages = HashSet.fromIterable([
        "effect",
        "@effect/platform-node",
        "@tanstack/ai",
        "@secretlint/core",
        "@secretlint/profiler",
        "@secretlint/secretlint-rule-preset-recommend",
      ]);
      const external = (id: string) => {
        if (id.startsWith("node:")) return true;
        if (id.startsWith(".") || id.startsWith("/") || id.startsWith("\0")) return false;
        const name = id.startsWith("@") ? id.split("/").slice(0, 2).join("/") : id.split("/")[0];
        if (!HashSet.has(allowedPackages, name))
          throw new Error(`Unexpected host dependency: ${id}`);
        return true;
      };
      const result = yield* sdkCall(() =>
        build({
          configFile: false,
          root,
          logLevel: "silent",
          build: {
            write: false,
            minify: false,
            lib: { entry: path.join(root, "src/agent/native-artifact-entry.ts"), formats: ["es"] },
            rollupOptions: { external },
          },
        }),
      );
      const outputs = Array.isArray(result) ? result : [result];
      expect(outputs).toHaveLength(1);
      // SAFETY: configFile:false and no watch mode produce finite output; length checked above.
      const output = outputs[0] as Extract<Awaited<ReturnType<typeof build>>, { output: unknown }>;
      const chunks = output.output.filter((item) => item.type === "chunk");
      expect(chunks).toHaveLength(1);
      const chunk = chunks[0]!;
      expect(chunk.exports.toSorted()).toEqual(
        [
          "createMemoryTools",
          "createSubscriptionRuntimeImplementation",
          "makePermissionGateMiddleware",
          "makeRecordingMiddleware",
        ].toSorted(),
      );
      expect(Buffer.byteLength(chunk.code)).toBeLessThan(2_000_000);
      expect(Object.keys(chunk.modules).some((id) => id.includes("/agent/chat.ts"))).toBe(false);
      expect(chunk.imports.every(external)).toBe(true);
      expect(chunk.imports).toContain("effect");
      expect(chunk.imports).toContain("@tanstack/ai");
      const bundle = path.join(temporary, "native.mjs");
      yield* fs.writeFileString(bundle, chunk.code);
      const counts = { embedderOwners: 0, embeddings: 0 };
      const owner = yield* sdkCall(() =>
        testRuntime({
          embedder: Layer.sync(Embedder, () => {
            counts.embedderOwners++;
            return {
              identity: "fake-trigram-64",
              dimensions: 64,
              embed: (texts) =>
                Effect.sync(() => {
                  counts.embeddings++;
                  return texts.map(fakeVector);
                }),
              runtime: () => ({ kind: "other" }),
            };
          }),
        }),
      );
      const env = yield* Effect.provideContext(
        Effect.all({
          search: MemorySearch,
          nodes: Nodes,
          graph: Graph,
          interpretations: Interpretations,
          knowledge: KnowledgePromotions,
        }),
        yield* owner.runtime.contextEffect,
      );
      const before = env.nodes.session(owner.session.id).length;
      const beforeImport = { ...counts };
      const bundleUrl = yield* path.toFileUrl(bundle);
      const artifact: typeof NativeArtifact = yield* sdkCall(
        () => import(/* @vite-ignore */ bundleUrl.href),
      );
      expect(env.nodes.session(owner.session.id)).toHaveLength(before);
      expect(counts).toEqual(beforeImport);
      expect(counts.embedderOwners).toBe(1);
      let clients = 0;
      const subscription = artifact.createSubscriptionRuntimeImplementation("openai").bind({
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
      expect(subscription.runMiddleware().name).toContain("subscription-run");
      expect(clients).toBe(0);
      for (const index of [1, 2]) {
        const runId = `artifact-${index}`;
        const user = env.nodes.append({
          projectId: owner.project.id,
          sessionId: owner.session.id,
          kind: "user",
          text: runId,
        });
        const memory = artifact.createMemoryTools(env, owner.project.id, {
          projectId: owner.project.id,
          sessionId: owner.session.id,
          runId,
          userNodeId: () => user.id,
        });
        expect(yield* sdkCall(() => memory.tools[1].execute!({ id: user.id }))).toMatchObject({
          text: runId,
        });
        const recording = yield* Effect.provideContext(
          artifact.makeRecordingMiddleware({
            projectId: owner.project.id,
            sessionId: owner.session.id,
            runId,
            userNodeId: user.id,
          }),
          yield* owner.runtime.contextEffect,
        );
        const gate = yield* Effect.provideContext(
          artifact.makePermissionGateMiddleware({
            project: owner.project,
            sessionId: owner.session.id,
            selection: { provider: "openai", model: "fixture", reasoningEffort: "none" },
            gated: HashSet.empty<string>(),
            decider: "user",
          }),
          yield* owner.runtime.contextEffect,
        );
        // Factory binding must not construct another host embedder owner.
        expect(counts.embedderOwners).toBe(1);
        yield* sdkCall(() =>
          chat({
            adapter: new ScriptedTextAdapter([{ text: runId }]),
            messages: [{ role: "user", content: runId }],
            runId,
            interrupts: [permissionReviewInterrupt],
            middleware: [
              gate,
              recording,
              ...(memory.middleware !== null ? [memory.middleware] : []),
            ],
            stream: false,
          }),
        );
        expect(
          env.nodes
            .session(owner.session.id)
            .filter((node) => node.runId === runId && node.kind === "assistant"),
        ).toHaveLength(1);
      }
      expect(clients).toBe(0);
    }).pipe(withTestPlatform),
  60_000,
);
