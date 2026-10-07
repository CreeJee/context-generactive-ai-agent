import { it } from "@effect/vitest";
import { Cause, FileSystem, Path } from "effect";
import { withTestPlatform } from "./support/platform.ts";
import { Array as EffectArray } from "effect";
import { HashSet } from "effect";
import { chat } from "@tanstack/ai";
import { Effect, Layer, Schema } from "effect";
import { build } from "vite";
import { expect } from "vite-plus/test";
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
it.live(
  "late-first native memory bundles preserve helpers and isolate populated run state",
  () =>
    withTestPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const join = pathService.join;
        const root = yield* pathService.fromFileUrl(new URL("../", import.meta.url));
        const temporary = yield* fs.makeTempDirectoryScoped({
          directory: root,
          prefix: ".native-memory-lifetime-",
        });
        const source = join(temporary, "src");
        yield* fs.copy(join(root, "src"), source);
        const allowed = HashSet.fromIterable([
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
          if (!HashSet.has(allowed, name)) throw new Error(`Unexpected host dependency: ${id}`);
          return true;
        };
        const bundle = Effect.fn("NativeArtifactTest.bundle")(function* (name: string) {
          const result = yield* sdkCall(() =>
            build({
              configFile: false,
              root,
              logLevel: "silent",
              build: {
                write: false,
                minify: false,
                lib: { entry: join(source, "agent/native-artifact-entry.ts"), formats: ["es"] },
                rollupOptions: { external },
              },
            }),
          );
          const outputs = Array.isArray(result) ? result : [result];
          expect(outputs).toHaveLength(1);
          // SAFETY: finite non-watch build with configFile:false; output length checked above.
          const output = outputs[0] as Extract<
            Awaited<ReturnType<typeof build>>,
            { output: unknown }
          >;
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
          yield* fs.writeFileString(path, chunk.code, { flag: "wx" });
          return { path, code: chunk.code };
        });
        const a = yield* bundle("a");
        const implementation = join(source, "tools/memory.ts");
        const original = yield* fs.readFileString(implementation);
        const needle = 'const notFound = (id: string) => ({ error: "not_found", id });';
        expect(original.split(needle)).toHaveLength(2);
        // Actual read/trace tool helper; no changed grants, visibility or authorization.
        yield* fs.writeFileString(
          implementation,
          original.replace(
            needle,
            'const notFound = (id: string) => ({ error: "copied-B:not_found", id });',
          ),
        );
        const b = yield* bundle("b");
        expect(b.code).not.toBe(a.code);
        expect(yield* fs.readFileString(a.path)).toBe(a.code);
        yield* fs.remove(source, { recursive: true });

        let embedderOwners = 0;
        const fixture = yield* sdkCall(() =>
          testRuntime({
            embedder: Layer.sync(Embedder, () => {
              embedderOwners++;
              return {
                identity: "fake-trigram-64",
                dimensions: 64,
                embed: (texts) => Effect.succeed(texts.map(fakeVector)),
                runtime: () => ({ kind: "other" }),
              };
            }),
          }),
        );
        const env = yield* Effect.provideContext(
          Effect.gen(function* () {
            return {
              search: yield* MemorySearch,
              nodes: yield* Nodes,
              graph: yield* Graph,
              interpretations: yield* Interpretations,
              knowledge: yield* KnowledgePromotions,
            };
          }),
          yield* fixture.runtime.contextEffect,
        );
        const db = yield* Effect.provideContext(Database, yield* fixture.runtime.contextEffect);
        const trace = yield* Effect.provideContext(
          WorkTraceStore,
          yield* fixture.runtime.contextEffect,
        );
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
          usedReports: [
            { taskId: handle.taskId, attemptId: handle.id, evidenceRefIds: [evidence.id] },
          ],
          reflectedNotificationIds: [],
        });
        // Both initial evaluations happen only after copied source deletion.
        const artifactUrlA = (yield* pathService.toFileUrl(a.path)).href;
        const artifactA: typeof NativeArtifact = yield* sdkCall(
          () => import(/* @vite-ignore */ artifactUrlA),
        );
        const artifactUrlB = (yield* pathService.toFileUrl(b.path)).href;
        const artifactB: typeof NativeArtifact = yield* sdkCall(
          () => import(/* @vite-ignore */ artifactUrlB),
        );
        const promotion = artifactA.createMemoryTools(env, fixture.project.id, {
          projectId: fixture.project.id,
          sessionId: fixture.session.id,
          runId: "promotion",
          userNodeId: () => user.id,
        });
        if (promotion.tools.length !== 6) throw new Error("Expected run tools");
        const executePromotion = promotion.tools[4].execute!;
        const promoted = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ memoryNodeId: Schema.NonEmptyString }),
        )(
          yield* sdkCall(() =>
            executePromotion({
              claimId,
              taskId: handle.taskId,
              attemptId: handle.id,
              evidenceRefIds: [evidence.id],
              proposedText: "isolated-memory-state is a fixture decision",
              resolvedText: "isolated-memory-state is a fixture decision",
              disposition: "save",
            }),
          ),
        );
        yield* Effect.provideContext(
          Effect.flatMap(Indexer, (indexer) => indexer.indexAll()),
          yield* fixture.runtime.contextEffect,
        );
        const sessions: string[] = [];
        const expectedUsage: { kind: string; parentRunId: string }[] = [];
        for (const [label, artifact, prefix] of [
          ["a-first", artifactA, ""],
          ["b", artifactB, "copied-B:"],
          ["a-next", artifactA, ""],
        ] as const) {
          const session = yield* Effect.provideContext(
            Effect.flatMap(Sessions, (service) => service.create(fixture.project.id)),
            yield* fixture.runtime.contextEffect,
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
          if (prepared.tools.length !== 6 || prepared.middleware === undefined)
            throw new Error("Expected run tools");
          expect(
            yield* sdkCall(() => prepared.tools[1].execute!({ id: "absent-evidence" })),
          ).toEqual({
            error: `${prefix}not_found`,
            id: "absent-evidence",
          });
          const memoryNodeIds = [promoted.memoryNodeId];
          expect(() => prepared.tools[5]!.execute!({ memoryNodeIds })).toThrow(
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
          yield* sdkCall(() => finish());
          const usage = () =>
            env.knowledge.usageForTask(handle.taskId).map((entry) => ({
              kind: entry.kind,
              parentRunId: entry.parentRunId,
            }));
          expect(usage()).toEqual(expectedUsage);
          expect(
            yield* sdkCall(() => prepared.tools[0].execute!({ query: "isolated-memory-state" })),
          ).toMatchObject({
            matches: expect.arrayContaining([
              expect.objectContaining({ id: promoted.memoryNodeId }),
            ]),
          });
          expect(
            yield* sdkCall(() => prepared.tools[1].execute!({ id: promoted.memoryNodeId })),
          ).toMatchObject({
            text: "isolated-memory-state is a fixture decision",
          });
          expect(prepared.tools[5]!.execute!({ memoryNodeIds })).toMatchObject({
            usedMemoryCount: 1,
          });
          expectedUsage.push({ kind: "retrieved", parentRunId: label });
          expect(usage()).toEqual(expectedUsage);
          yield* sdkCall(() => finish());
          expectedUsage.push({ kind: "used", parentRunId: label });
          expect(usage()).toEqual(expectedUsage);
          // Narrow observable acquisition counter, NOT comprehensive DB/vector/OAuth singleton proof.
          expect(embedderOwners).toBe(1);
        }
        expect(EffectArray.dedupe(sessions).length).toBe(3);
      }),
    ),
  60_000,
);

const sdkCall = Effect.fn("NativeArtifactTest.sdkCall")(<A>(call: () => A | PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(call()),
    catch: (cause) => new Cause.UnknownError(cause),
  }),
);
