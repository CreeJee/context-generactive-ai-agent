import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chat } from "@tanstack/ai";
import { Effect, Layer } from "effect";
import { Embedder } from "../src/memory/embedding/embedder.ts";
import { fakeVector } from "../src/testing/fake-embedder.ts";
import { build } from "vite";
import { expect, test } from "vite-plus/test";
import type * as NativeArtifact from "../src/agent/native-artifact-entry.ts";
import { Graph } from "../src/memory/graph.ts";
import { Interpretations } from "../src/memory/interpretations.ts";
import { KnowledgePromotions } from "../src/memory/knowledge.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { MemorySearch } from "../src/memory/search.ts";
import { ScriptedTextAdapter } from "../src/testing/scripted-adapter.ts";
import { permissionReviewInterrupt } from "../src/tools/definitions.ts";
import { testRuntime } from "./support/runtime.ts";

test("factory bundle imports shared host packages and binds fresh central services", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  // Keep output under the package so native Node imports resolve the host's dependencies.
  const temporary = await mkdtemp(join(root, ".native-artifact-test-"));
  try {
    const allowedPackages = new Set([
      "effect",
      "@tanstack/ai",
      "@secretlint/core",
      "@secretlint/profiler",
      "@secretlint/secretlint-rule-preset-recommend",
    ]);
    const external = (id: string) => {
      if (id.startsWith("node:")) return true;
      if (id.startsWith(".") || id.startsWith("/") || id.startsWith("\0")) return false;
      const name = id.startsWith("@") ? id.split("/").slice(0, 2).join("/") : id.split("/")[0];
      if (!allowedPackages.has(name)) throw new Error(`Unexpected host dependency: ${id}`);
      return true;
    };
    const result = await build({
      configFile: false,
      root,
      logLevel: "silent",
      build: {
        write: false,
        minify: false,
        lib: { entry: join(root, "src/agent/native-artifact-entry.ts"), formats: ["es"] },
        rollupOptions: { external },
      },
    });
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
    const bundle = join(temporary, "native.mjs");
    await writeFile(bundle, chunk.code);
    const counts = { embedderOwners: 0, embeddings: 0 };
    const owner = await testRuntime({
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
    });
    const env = await owner.runtime.runPromise(
      Effect.all({
        search: MemorySearch,
        nodes: Nodes,
        graph: Graph,
        interpretations: Interpretations,
        knowledge: KnowledgePromotions,
      }),
    );
    const before = env.nodes.session(owner.session.id).length;
    const beforeImport = { ...counts };
    const artifact: typeof NativeArtifact = await import(
      /* @vite-ignore */ pathToFileURL(bundle).href
    );
    expect(env.nodes.session(owner.session.id)).toHaveLength(before);
    expect(counts).toEqual(beforeImport);
    expect(counts.embedderOwners).toBe(1);
    let clients = 0;
    const subscription = artifact.createSubscriptionRuntimeImplementation("openai").bind({
      client: () => {
        clients++;
        return {
          stream: async function* () {
            yield { type: "text" as const, text: "unused" };
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
      expect(await memory.tools[1].execute!({ id: user.id })).toMatchObject({ text: runId });
      const recording = await owner.runtime.runPromise(
        artifact.makeRecordingMiddleware({
          projectId: owner.project.id,
          sessionId: owner.session.id,
          runId,
          userNodeId: user.id,
        }),
      );
      const gate = await owner.runtime.runPromise(
        artifact.makePermissionGateMiddleware({
          project: owner.project,
          sessionId: owner.session.id,
          selection: { provider: "openai", model: "fixture", reasoningEffort: "none" },
          gated: new Set(),
          decider: "user",
        }),
      );
      // Factory binding must not construct another host embedder owner.
      expect(counts.embedderOwners).toBe(1);
      await chat({
        adapter: new ScriptedTextAdapter([{ text: runId }]),
        messages: [{ role: "user", content: runId }],
        runId,
        interrupts: [permissionReviewInterrupt],
        middleware: [gate, recording, ...(memory.middleware ? [memory.middleware] : [])],
        stream: false,
      });
      expect(
        env.nodes
          .session(owner.session.id)
          .filter((node) => node.runId === runId && node.kind === "assistant"),
      ).toHaveLength(1);
    }
    expect(clients).toBe(0);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 60_000);
