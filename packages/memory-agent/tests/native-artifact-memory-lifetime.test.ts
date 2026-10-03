import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chat } from "@tanstack/ai";
import { Effect, Layer, Schema } from "effect";
import { build } from "vite";
import { expect, test } from "vite-plus/test";
import type * as NativeArtifact from "../src/agent/native-artifact-entry.ts";
import { Database } from "../src/db/database.ts";
import { Embedder } from "../src/memory/embedding/embedder.ts";
import { Indexer } from "../src/memory/embedding/indexer.ts";
import { Graph } from "../src/memory/graph.ts";
import { Interpretations } from "../src/memory/interpretations.ts";
import { KnowledgePromotions } from "../src/memory/knowledge.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { MemorySearch } from "../src/memory/search.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { fakeVector } from "../src/testing/fake-embedder.ts";
import { ScriptedTextAdapter } from "../src/testing/scripted-adapter.ts";
import { WorkTraceStore } from "../src/work-trace/store.ts";
import { testRuntime } from "./support/runtime.ts";

// Test-only native bytes lifetime; not production loading or whole-Goal/cold-owner pinning.
test("late-first native memory bundles preserve helpers and isolate populated run state", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const temporary = await mkdtemp(join(root, ".native-memory-lifetime-"));
  try {
    const source = join(temporary, "src");
    await cp(join(root, "src"), source, { recursive: true });
    const allowed = new Set([
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
      if (!allowed.has(name)) throw new Error(`Unexpected host dependency: ${id}`);
      return true;
    };
    const bundle = async (name: string) => {
      const result = await build({
        configFile: false,
        root,
        logLevel: "silent",
        build: {
          write: false,
          minify: false,
          lib: { entry: join(source, "agent/native-artifact-entry.ts"), formats: ["es"] },
          rollupOptions: { external },
        },
      });
      const outputs = Array.isArray(result) ? result : [result];
      expect(outputs).toHaveLength(1);
      // SAFETY: finite non-watch build with configFile:false; output length checked above.
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
      expect(Object.keys(chunk.modules)).toContain(join(source, "tools/memory.ts"));
      expect(chunk.imports.every(external)).toBe(true);
      expect(chunk.imports).toContain("effect");
      expect(chunk.imports).toContain("@tanstack/ai");
      expect(Buffer.byteLength(chunk.code)).toBeLessThan(2_000_000);
      const path = join(temporary, `${name}.mjs`);
      await writeFile(path, chunk.code, { flag: "wx" });
      return { path, code: chunk.code };
    };
    const a = await bundle("a");
    const implementation = join(source, "tools/memory.ts");
    const original = await readFile(implementation, "utf8");
    const needle = 'const notFound = (id: string) => ({ error: "not_found", id });';
    expect(original.split(needle)).toHaveLength(2);
    // Actual read/trace tool helper; no changed grants, visibility or authorization.
    await writeFile(
      implementation,
      original.replace(
        needle,
        'const notFound = (id: string) => ({ error: "copied-B:not_found", id });',
      ),
    );
    const b = await bundle("b");
    expect(b.code).not.toBe(a.code);
    expect(await readFile(a.path, "utf8")).toBe(a.code);
    await rm(source, { recursive: true });

    let embedderOwners = 0;
    const fixture = await testRuntime({
      embedder: Layer.sync(Embedder, () => {
        embedderOwners++;
        return {
          identity: "fake-trigram-64",
          dimensions: 64,
          embed: (texts) => Effect.succeed(texts.map(fakeVector)),
          runtime: () => ({ kind: "other" }),
        };
      }),
    });
    const env = await fixture.runtime.runPromise(
      Effect.gen(function* () {
        return {
          search: yield* MemorySearch,
          nodes: yield* Nodes,
          graph: yield* Graph,
          interpretations: yield* Interpretations,
          knowledge: yield* KnowledgePromotions,
        };
      }),
    );
    const db = await fixture.runtime.runPromise(Database);
    const trace = await fixture.runtime.runPromise(WorkTraceStore);
    db.sqlite
      .prepare(
        `INSERT INTO subagents
          (id, session_id, name, instructions, status, parent_run_id, last_task, created_at, updated_at)
          VALUES ('factory-agent', ?, 'factory', 'research', 'interrupted', 'parent', 'task', 1, 1)`,
      )
      .run(fixture.session.id);
    const user = env.nodes.append({
      projectId: fixture.project.id,
      sessionId: fixture.session.id,
      kind: "user",
      text: "Save this fixture decision: isolated-memory-state.",
    });
    const handle = trace.startAttempt({
      sessionId: fixture.session.id,
      parentRunId: "parent",
      parentToolCallId: "factory-call",
      agentId: "factory-agent",
      title: "Factory research",
      request: "Research factory state",
      kind: "start",
      threadId: "factory-thread",
    });
    const evidence = trace.recordEvidence({
      handle,
      locator: { kind: "message", threadId: handle.threadId, messageId: "verified-answer" },
      verification: "verified",
    });
    trace.recordReportDisposition({
      handle,
      sessionId: fixture.session.id,
      disposition: "reviewed",
      parentRunId: "parent",
    });
    const claimId = trace.finalizeAnswerClaim({
      projectId: fixture.project.id,
      sessionId: fixture.session.id,
      parentRunId: "parent",
      parentMessageId: "research-answer",
      usedReports: [{ taskId: handle.taskId, attemptId: handle.id, evidenceRefIds: [evidence.id] }],
      reflectedNotificationIds: [],
    });
    // Both initial evaluations happen only after copied source deletion.
    const artifactA: typeof NativeArtifact = await import(
      /* @vite-ignore */ pathToFileURL(a.path).href
    );
    const artifactB: typeof NativeArtifact = await import(
      /* @vite-ignore */ pathToFileURL(b.path).href
    );
    const promotion = artifactA.createMemoryTools(env, fixture.project.id, {
      projectId: fixture.project.id,
      sessionId: fixture.session.id,
      runId: "promotion",
      userNodeId: () => user.id,
    });
    if (promotion.tools.length !== 6) throw new Error("Expected run tools");
    const promoted = Schema.decodeUnknownSync(
      Schema.Struct({ memoryNodeId: Schema.NonEmptyString }),
    )(
      await promotion.tools[4].execute!({
        claimId,
        taskId: handle.taskId,
        attemptId: handle.id,
        evidenceRefIds: [evidence.id],
        proposedText: "isolated-memory-state is a fixture decision",
        resolvedText: "isolated-memory-state is a fixture decision",
        disposition: "save",
      }),
    );
    await fixture.runtime.runPromise(Effect.flatMap(Indexer, (indexer) => indexer.indexAll()));
    const sessions: string[] = [];
    const expectedUsage: { kind: string; parentRunId: string }[] = [];
    for (const [label, artifact, prefix] of [
      ["a-first", artifactA, ""],
      ["b", artifactB, "copied-B:"],
      ["a-next", artifactA, ""],
    ] as const) {
      const session = await fixture.runtime.runPromise(
        Effect.flatMap(Sessions, (service) => service.create(fixture.project.id)),
      );
      sessions.push(session.id);
      const runUser = env.nodes.append({
        projectId: fixture.project.id,
        sessionId: session.id,
        kind: "user",
        text: label,
      });
      const prepared = artifact.createMemoryTools(env, fixture.project.id, {
        projectId: fixture.project.id,
        sessionId: session.id,
        runId: label,
        userNodeId: () => runUser.id,
      });
      if (prepared.tools.length !== 6 || !prepared.middleware)
        throw new Error("Expected run tools");
      expect(await prepared.tools[1].execute!({ id: "absent-evidence" })).toEqual({
        error: `${prefix}not_found`,
        id: "absent-evidence",
      });
      const memoryNodeIds = [promoted.memoryNodeId];
      expect(() => prepared.tools[5].execute!({ memoryNodeIds })).toThrow(
        "Only promoted memories retrieved in this run can be used",
      );
      // Finishing a fresh run before retrieval/use must not inherit the previous usedDraft.
      const finish = () =>
        chat({
          adapter: new ScriptedTextAdapter([{ text: label }]),
          messages: [],
          runId: label,
          middleware: [prepared.middleware!],
          stream: false,
        });
      await finish();
      const usage = () =>
        env.knowledge.usageForTask(handle.taskId).map((entry) => ({
          kind: entry.kind,
          parentRunId: entry.parentRunId,
        }));
      expect(usage()).toEqual(expectedUsage);
      expect(await prepared.tools[0].execute!({ query: "isolated-memory-state" })).toMatchObject({
        matches: expect.arrayContaining([expect.objectContaining({ id: promoted.memoryNodeId })]),
      });
      expect(await prepared.tools[1].execute!({ id: promoted.memoryNodeId })).toMatchObject({
        text: "isolated-memory-state is a fixture decision",
      });
      expect(prepared.tools[5].execute!({ memoryNodeIds })).toMatchObject({ usedMemoryCount: 1 });
      expectedUsage.push({ kind: "retrieved", parentRunId: label });
      expect(usage()).toEqual(expectedUsage);
      await finish();
      expectedUsage.push({ kind: "used", parentRunId: label });
      expect(usage()).toEqual(expectedUsage);
      // Narrow observable acquisition counter, NOT comprehensive DB/vector/OAuth singleton proof.
      expect(embedderOwners).toBe(1);
    }
    expect(new Set(sessions).size).toBe(3);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 60_000);
