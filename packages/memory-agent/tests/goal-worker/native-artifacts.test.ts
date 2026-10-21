import { layer } from "@effect/vitest";
import { chat, toolDefinition } from "@tanstack/ai";
import {
  Array as EffectArray,
  Cause,
  Context,
  Crypto,
  Effect,
  FileSystem,
  HashSet,
  Layer,
  Path,
  Schema,
  Stream,
} from "effect";
import { Hex } from "effect/encoding";
import { build } from "vite";
import { expect } from "vite-plus/test";
import type * as NativeArtifact from "../../src/agent/native-artifact-entry.ts";
import { NativeArtifactLoadError } from "../../src/agent/native-artifact-loader.ts";
import {
  OwnerNativeArtifacts,
  makeOwnerNativeArtifacts,
} from "../../src/agent/owner-native-artifacts.ts";
import { OwnerNativeBuild } from "../../src/agent/owner-native-build.ts";
import { NativeRegistrationError } from "../../src/agent/owner-native-error.ts";
import { StorageRoot } from "../../src/config/storage-root.ts";
import { Embedder } from "../../src/memory/embedding/embedder.ts";
import { Indexer } from "../../src/memory/embedding/indexer.ts";
import { Graph } from "../../src/memory/graph.ts";
import { Interpretations } from "../../src/memory/interpretations.ts";
import { KnowledgePromotions } from "../../src/memory/knowledge.ts";
import { Nodes } from "../../src/memory/nodes.ts";
import { MemorySearch } from "../../src/memory/search.ts";
import type { NormalizedStreamEvent } from "../../src/oauth/protocol.ts";
import { PermissionReviews } from "../../src/permissions/reviews.ts";
import { nativeStream } from "../../src/runtime/native-stream.ts";
import { runtimeArtifact } from "../../src/runtime/resources.ts";
import { fakeVector } from "../../src/testing/fake-embedder.ts";
import { ScriptedTextAdapter } from "../../src/testing/scripted-adapter.ts";
import { permissionReviewInterrupt } from "../../src/tools/definitions.ts";
import { WorkTraceStore } from "../../src/work-trace/store.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";
import { freshSession, goalSession, responder, responseText, rows, send } from "./goal-session.ts";
import { sqlGet, sqlRun } from "../support/sql.ts";

const sdkCall = <A>(call: () => A | PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(call()),
    catch: (cause) => new Cause.UnknownError(cause),
  });

const hostPackages = HashSet.fromIterable([
  "effect",
  "@effect/platform-node",
  "@tanstack/ai",
  "@secretlint/core",
  "@secretlint/profiler",
  "@secretlint/secretlint-rule-preset-recommend",
]);

/** Node built-ins and the allowed host packages stay external; everything else is bundled. */
const external = (id: string) => {
  if (id.startsWith("node:")) return true;
  if (id.startsWith(".") || id.startsWith("/") || id.startsWith("\0")) return false;
  const name = id.startsWith("@") ? id.split("/").slice(0, 2).join("/") : id.split("/")[0]!;
  if (!HashSet.has(hostPackages, name)) throw new Error(`Unexpected host dependency: ${id}`);
  return true;
};

/** Source helpers bundle B changes, each matched exactly once in the copied source. */
const mutations = [
  {
    file: "permissions/gate.ts",
    needle: "return { error: `blocked_by_permission_review: ${review.reason}` };",
    replacement: "return { error: `copied-B:blocked_by_permission_review: ${review.reason}` };",
  },
  {
    file: "tools/memory.ts",
    needle: 'const notFound = (id: string) => ({ error: "not_found", id });',
    replacement: 'const notFound = (id: string) => ({ error: "copied-B:not_found", id });',
  },
];

interface Bundle {
  readonly code: string;
  readonly exports: readonly string[];
  readonly modules: readonly string[];
  readonly imports: readonly string[];
}

/**
 * Two native factory bundles from one copied source tree: A as checked in, B with changed refusal
 * and not-found helpers. The copied source is deleted before any test evaluates either bundle, and
 * each test evaluates its own copy of the bytes, so module state never crosses tests.
 */
class NativeBundles extends Context.Service<
  NativeBundles,
  {
    readonly source: string;
    readonly a: Bundle;
    readonly b: Bundle;
    readonly load: (
      bundle: Bundle,
      name: string,
    ) => Effect.Effect<typeof NativeArtifact, Cause.UnknownError | Error>;
  }
>()("memory-agent/tests/goal-worker/native-artifacts.test/NativeBundles") {
  static readonly layer = Layer.effect(
    NativeBundles,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* path.fromFileUrl(new URL("../../", import.meta.url));
      // Output stays under the package so native Node imports resolve the host's dependencies.
      const temporary = yield* fs.makeTempDirectoryScoped({
        directory: root,
        prefix: ".native-artifact-test-",
      });
      const source = path.join(temporary, "src");
      yield* fs.copy(path.join(root, "src"), source);
      const bundle = Effect.fnUntraced(function* () {
        const result = yield* sdkCall(() =>
          build({
            configFile: false,
            root,
            logLevel: "silent",
            build: {
              write: false,
              minify: false,
              lib: { entry: path.join(source, "agent/native-artifact-entry.ts"), formats: ["es"] },
              rollupOptions: { external },
            },
          }),
        );
        // SAFETY: a finite build without watch mode returns build output, never a watcher.
        const outputs = [result].flat() as Extract<
          Awaited<ReturnType<typeof build>>,
          { output: unknown }
        >[];
        const chunks = outputs.flatMap((output) =>
          output.output.filter((item) => item.type === "chunk"),
        );
        if (chunks.length !== 1)
          return yield* new Cause.UnknownError(chunks, "Expected one native chunk");
        const [chunk] = chunks;
        return {
          code: chunk!.code,
          exports: chunk!.exports,
          modules: Object.keys(chunk!.modules),
          imports: chunk!.imports,
        };
      });
      const a = yield* bundle();
      for (const { file, needle, replacement } of mutations) {
        const implementation = path.join(source, file);
        const original = yield* fs.readFileString(implementation);
        if (original.split(needle).length !== 2)
          return yield* new Cause.UnknownError(undefined, `Mutation target moved: ${file}`);
        yield* fs.writeFileString(implementation, original.replace(needle, replacement));
      }
      const b = yield* bundle();
      yield* fs.remove(source, { recursive: true });
      const load = Effect.fnUntraced(function* (bundle: Bundle, name: string) {
        const file = path.join(temporary, `${name}.mjs`);
        yield* fs.writeFileString(file, bundle.code, { flag: "wx" });
        const url = (yield* path.toFileUrl(file)).href;
        const artifact: typeof NativeArtifact = yield* sdkCall(
          () => import(/* @vite-ignore */ url),
        );
        return artifact;
      });
      return { source, a, b, load };
    }),
  );
}

const embedderOwners = { count: 0, embeddings: 0 };
const countedEmbedder = Layer.sync(Embedder, () => {
  embedderOwners.count++;
  return {
    identity: "fake-trigram-384",
    dimensions: 384,
    embed: (texts) =>
      Effect.sync(() => {
        embedderOwners.embeddings++;
        return texts.map(fakeVector);
      }),
    runtime: () => ({ kind: "other" }),
  };
});

const memoryServices = Effect.all({
  search: MemorySearch,
  nodes: Nodes,
  graph: Graph,
  interpretations: Interpretations,
  knowledge: KnowledgePromotions,
});

layer(NativeBundles.layer.pipe(Layer.provideMerge(TestEnv.layer({ embedder: countedEmbedder }))), {
  excludeTestServices: true,
})("native factory bundles", (it) => {
  it.effect("bundle only the native factories over shared host packages", () =>
    Effect.gen(function* () {
      const { source, a, b } = yield* NativeBundles;
      for (const [bundle, prefix] of [
        [a, ""],
        [b, "copied-B:"],
      ] as const) {
        expect(bundle.exports.toSorted()).toEqual([
          "createMemoryTools",
          "createSubscriptionRuntimeImplementation",
          "makePermissionGateMiddleware",
          "makeRecordingMiddleware",
        ]);
        expect(bundle.modules).toEqual(
          expect.arrayContaining([`${source}/permissions/gate.ts`, `${source}/tools/memory.ts`]),
        );
        expect(bundle.modules.some((id) => id.includes("/agent/chat.ts"))).toBe(false);
        expect(bundle.imports.every(external)).toBe(true);
        expect(bundle.imports).toEqual(expect.arrayContaining(["effect", "@tanstack/ai"]));
        expect(Buffer.byteLength(bundle.code)).toBeLessThan(2_000_000);
        expect(bundle.code).toContain(`${prefix}not_found`);
      }
      expect(b.code).not.toBe(a.code);
    }),
  );

  it.effect("importing a factory bundle binds fresh central services without side effects", () =>
    Effect.gen(function* () {
      const { project } = yield* TestEnv;
      const bundles = yield* NativeBundles;
      const env = yield* memoryServices;
      const sessionId = yield* freshSession();
      const before = (yield* env.nodes.session(sessionId)).length;
      const owners = embedderOwners.count;
      const counts = { ...embedderOwners };
      const artifact = yield* bundles.load(bundles.a, "factory");
      expect(yield* env.nodes.session(sessionId)).toHaveLength(before);
      expect(embedderOwners).toEqual(counts);
      let clients = 0;
      const subscription = artifact.createSubscriptionRuntimeImplementation("openai").bind({
        client: () => {
          clients++;
          return {
            stream: () =>
              nativeStream(Stream.make<NormalizedStreamEvent[]>({ type: "text", text: "unused" })),
          };
        },
      });
      expect(subscription.runMiddleware().name).toContain("subscription-run");
      for (const runId of [`${sessionId}-artifact-1`, `${sessionId}-artifact-2`]) {
        const user = yield* env.nodes.append({
          projectId: project.id,
          sessionId,
          kind: "user",
          text: runId,
        });
        const memory = artifact.createMemoryTools(env, project.id, {
          projectId: project.id,
          sessionId,
          runId,
          userNodeId: () => user.id,
        });
        expect(yield* sdkCall(() => memory.tools[1].execute!({ id: user.id }))).toMatchObject({
          text: runId,
        });
        const recording = yield* artifact.makeRecordingMiddleware({
          projectId: project.id,
          sessionId,
          runId,
          userNodeId: user.id,
        });
        const gate = yield* artifact.makePermissionGateMiddleware({
          project,
          sessionId,
          selection: { provider: "openai", model: "fixture", reasoningEffort: "none" },
          gated: HashSet.empty<string>(),
          decider: "user",
        });
        // Binding the factories must not construct another host embedder owner.
        expect(embedderOwners.count).toBe(owners);
        yield* sdkCall(() =>
          chat({
            adapter: new ScriptedTextAdapter([{ text: runId }]),
            messages: [{ role: "user", content: runId }],
            runId,
            interrupts: [permissionReviewInterrupt],
            middleware: [
              gate,
              recording,
              ...(memory.middleware === null ? [] : [memory.middleware]),
            ],
            stream: false,
          }),
        );
        expect(
          (yield* env.nodes.session(sessionId)).filter(
            (node) => node.runId === runId && node.kind === "assistant",
          ),
        ).toHaveLength(1);
      }
      expect(clients).toBe(0);
    }),
  );

  it.effect("late-first bundles each keep their own permission refusal helper", () =>
    Effect.gen(function* () {
      const { project } = yield* TestEnv;
      const bundles = yield* NativeBundles;
      const reviews = yield* PermissionReviews;
      const owners = embedderOwners.count;
      const artifactA = yield* bundles.load(bundles.a, "permission-a");
      const artifactB = yield* bundles.load(bundles.b, "permission-b");
      const executed: string[] = [];
      for (const [label, artifact, prefix] of [
        ["a-first", artifactA, ""],
        ["b", artifactB, "copied-B:"],
        ["a-next", artifactA, ""],
      ] as const) {
        const sessionId = yield* freshSession();
        const reason = `central-${label}`;
        expect(yield* reviews.latest(sessionId, "blocked-id")).toBeNull();
        const blocked = yield* reviews.record({
          sessionId,
          toolCallId: "blocked-id",
          toolName: "blocked_tool",
          input: "{}",
          decision: "block",
          decidedBy: "classifier",
          reason,
        });
        const allowed = yield* reviews.record({
          sessionId,
          toolCallId: "allowed-id",
          toolName: "allowed_tool",
          input: "{}",
          decision: "approved",
          decidedBy: "user",
          reason: label,
        });
        const gate = yield* artifact.makePermissionGateMiddleware({
          project,
          sessionId,
          selection: { provider: "openai", model: "scripted-1", reasoningEffort: "none" },
          gated: HashSet.fromIterable(["blocked_tool", "allowed_tool"]),
          decider: "user",
        });
        const adapter = new ScriptedTextAdapter([
          {
            toolCalls: [
              { id: "blocked-id", name: "blocked_tool", arguments: "{}" },
              { id: "allowed-id", name: "allowed_tool", arguments: "{}" },
            ],
          },
          { text: "finished" },
        ]);
        yield* sdkCall(() =>
          chat({
            adapter,
            messages: [],
            runId: `${sessionId}-${label}`,
            tools: [
              toolDefinition({ name: "blocked_tool", description: "must stay blocked" }).server(
                () => {
                  executed.push(`UNSAFE:${label}`);
                  return "unexpected";
                },
              ),
              toolDefinition({
                name: "allowed_tool",
                description: "exact central approval",
              }).server(() => {
                executed.push(label);
                return `allowed-${label}`;
              }),
            ],
            interrupts: [permissionReviewInterrupt],
            middleware: [gate],
            stream: false,
          }),
        );
        expect(adapter.invocations).toHaveLength(2);
        const toolResult = (id: string) =>
          adapter.invocations[1]!.messages.find(
            (message) => message.role === "tool" && message.toolCallId === id,
          )?.content;
        expect(toolResult("blocked-id")).toBe(
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
            error: `${prefix}blocked_by_permission_review: ${reason}`,
          }),
        );
        expect(toolResult("allowed-id")).toContain(`allowed-${label}`);
        expect(yield* reviews.latest(sessionId, "blocked-id")).toEqual(blocked);
        expect(yield* reviews.latest(sessionId, "allowed-id")).toEqual(allowed);
        // Observable embedder acquisition only, not a full singleton ownership proof.
        expect(embedderOwners.count).toBe(owners);
      }
      expect(executed).toEqual(["a-first", "b", "a-next"]);
    }),
  );

  it.effect("late-first memory bundles keep their own helpers and isolate run state", () =>
    Effect.gen(function* () {
      const { project } = yield* TestEnv;
      const bundles = yield* NativeBundles;
      const env = yield* memoryServices;
      const trace = yield* WorkTraceStore;
      const owners = embedderOwners.count;
      const sessionId = yield* freshSession();
      const agentId = `${sessionId}-factory-agent`;
      yield* sqlRun(
        `INSERT INTO subagents
          (id, session_id, name, instructions, status, parent_run_id, last_task, created_at, updated_at)
          VALUES (?, ?, 'factory', 'research', 'interrupted', 'parent', 'task', 1, 1)`,
        agentId,
        sessionId,
      );
      const user = yield* env.nodes.append({
        projectId: project.id,
        sessionId,
        kind: "user",
        text: "Save this fixture decision: isolated-memory-state.",
      });
      const handle = yield* trace.startAttempt({
        sessionId,
        parentRunId: "parent",
        parentToolCallId: "factory-call",
        agentId,
        title: "Factory research",
        request: "Research factory state",
        kind: "start",
        threadId: `${sessionId}-factory-thread`,
      });
      const claimId = yield* trace.finalizeAnswerClaim({
        projectId: project.id,
        sessionId,
        parentRunId: "parent",
        parentMessageId: "research-answer",
        usedReports: [{ taskId: handle.taskId, attemptId: handle.id }],
        reflectedNotificationIds: [],
      });
      const artifactA = yield* bundles.load(bundles.a, "memory-a");
      const artifactB = yield* bundles.load(bundles.b, "memory-b");
      const promotion = artifactA.createMemoryTools(env, project.id, {
        projectId: project.id,
        sessionId,
        runId: `${sessionId}-promotion`,
        userNodeId: () => user.id,
      });
      expect(promotion.tools).toHaveLength(6);
      const promoted = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ memoryNodeId: Schema.NonEmptyString }),
      )(
        yield* sdkCall(() =>
          promotion.tools[4]!.execute!({
            claimId,
            taskId: handle.taskId,
            attemptId: handle.id,
            proposedText: "isolated-memory-state is a fixture decision",
            resolvedText: "isolated-memory-state is a fixture decision",
            disposition: "save",
          }),
        ),
      );
      yield* Effect.flatMap(Indexer, (indexer) => indexer.indexAll());
      const memoryNodeIds = [promoted.memoryNodeId];
      const usage = () =>
        Effect.map(env.knowledge.usageForTask(handle.taskId), (entries) =>
          entries.map(({ kind, parentRunId }) => ({ kind, parentRunId })),
        );
      const expectedUsage: { kind: string; parentRunId: string }[] = [];
      const sessions: string[] = [];
      for (const [label, artifact, prefix] of [
        ["a-first", artifactA, ""],
        ["b", artifactB, "copied-B:"],
        ["a-next", artifactA, ""],
      ] as const) {
        const runSession = yield* freshSession();
        sessions.push(runSession);
        const runId = `${runSession}-${label}`;
        const runUser = yield* env.nodes.append({
          projectId: project.id,
          sessionId: runSession,
          kind: "user",
          text: label,
        });
        const prepared = artifact.createMemoryTools(env, project.id, {
          projectId: project.id,
          sessionId: runSession,
          runId,
          userNodeId: () => runUser.id,
        });
        expect(prepared.tools).toHaveLength(6);
        expect(prepared.middleware).toBeDefined();
        expect(yield* sdkCall(() => prepared.tools[1].execute!({ id: "absent-evidence" }))).toEqual(
          { error: `${prefix}not_found`, id: "absent-evidence" },
        );
        expect(() => prepared.tools[5]!.execute!({ memoryNodeIds })).toThrow(
          "Only promoted memories retrieved in this run can be used",
        );
        // Finishing a fresh run before retrieval/use must not inherit the previous usedDraft.
        const finish = sdkCall(() =>
          chat({
            adapter: new ScriptedTextAdapter([{ text: label }]),
            messages: [],
            runId,
            middleware: [prepared.middleware!],
            stream: false,
          }),
        );
        yield* finish;
        expect(yield* usage()).toEqual(expectedUsage);
        expect(
          yield* sdkCall(() => prepared.tools[0].execute!({ query: "isolated-memory-state" })),
        ).toMatchObject({
          matches: expect.arrayContaining([expect.objectContaining({ id: promoted.memoryNodeId })]),
        });
        expect(
          yield* sdkCall(() => prepared.tools[1].execute!({ id: promoted.memoryNodeId })),
        ).toMatchObject({ text: "isolated-memory-state is a fixture decision" });
        expect(prepared.tools[5]!.execute!({ memoryNodeIds })).toMatchObject({
          usedMemoryCount: 1,
        });
        expectedUsage.push({ kind: "retrieved", parentRunId: runId });
        expect(yield* usage()).toEqual(expectedUsage);
        yield* finish;
        expectedUsage.push({ kind: "used", parentRunId: runId });
        expect(yield* usage()).toEqual(expectedUsage);
        // Narrow observable acquisition counter, not a DB/vector/OAuth singleton proof.
        expect(embedderOwners.count).toBe(owners);
      }
      expect(EffectArray.dedupe(sessions)).toHaveLength(3);
    }),
  );
});

const GoalInstance = Schema.Struct({ goal_instance_id: Schema.String });
const Registered = Schema.Struct({
  artifact_url: Schema.String,
  artifact_hash: Schema.String,
  source_hash: Schema.String,
  contract_version: Schema.String,
});

/** The Goal instance of a fresh session with an active Goal. */
const goalInstance = Effect.fnUntraced(function* (statement: string) {
  const id = yield* goalSession(statement);
  return (yield* Schema.decodeUnknownEffect(GoalInstance)(
    yield* sqlGet("SELECT goal_instance_id FROM workflow_goal_instances WHERE session_id = ?", id),
  )).goal_instance_id;
});

/** A writable copy of the packaged prebuilt runtime, with its manifest path. */
const prebuiltCopy = Effect.fnUntraced(function* (name: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const storage = yield* StorageRoot;
  const directory = path.join(storage.path, name);
  yield* fs.copy(path.dirname(runtimeArtifact("artifact-manifest.json")), directory, {
    overwrite: true,
  });
  return { directory, manifest: path.join(directory, "artifact-manifest.json") };
});

/** Acquire the Goal's native factories through an owner reading `manifest`. */
const acquire = Effect.fnUntraced(function* (manifest: string, goalInstanceId: string) {
  const path = yield* Path.Path;
  const storage = yield* StorageRoot;
  const artifacts = yield* makeOwnerNativeArtifacts({
    directory: path.join(storage.path, "native-artifacts"),
    manifest,
  });
  return yield* Effect.scoped(artifacts.acquire(goalInstanceId));
});

testAgent()("owner native artifacts", (it) => {
  it.effect("a missing prebuilt manifest is a typed service-startup failure", () =>
    Effect.gen(function* () {
      // The contract is the Layer's own startup failure, so this test builds that Layer directly.
      const failure = yield* Effect.flip(
        Effect.scoped(
          Layer.build(
            OwnerNativeArtifacts.layer.pipe(
              Layer.provide(
                Layer.succeed(OwnerNativeBuild, { manifest: "/missing/artifact-manifest.json" }),
              ),
            ),
          ),
        ),
      );
      expect(failure).toBeInstanceOf(NativeRegistrationError);
    }),
  );

  it.effect(
    "registers only the deterministic prebuilt artifact and revalidates it on cold acquisition",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const storage = yield* StorageRoot;
        const id = yield* goalInstance("Prebuilt native artifact");
        const { directory, manifest } = yield* prebuiltCopy("prebuilt-runtime");
        yield* acquire(manifest, id);
        const registered = yield* Schema.decodeUnknownEffect(Registered)(
          yield* sqlGet(
            "SELECT * FROM workflow_goal_native_artifacts WHERE goal_instance_id = ?",
            id,
          ),
        );
        const goalDigest = yield* (yield* Crypto.Crypto).digest(
          "SHA-256",
          new TextEncoder().encode(id),
        );
        expect(registered).toMatchObject({
          artifact_url: (yield* path.toFileUrl(
            path.join(
              storage.path,
              "native-artifacts",
              Hex.encode(goalDigest),
              registered.artifact_hash,
              "native.mjs",
            ),
          )).href,
          artifact_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
          source_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
          contract_version: "native-factories/v1",
        });
        yield* acquire(manifest, id);

        // A replaced build no longer matters once the Goal is pinned.
        yield* fs.writeFileString(
          path.join(directory, "native.mjs"),
          "// corrupt replacement build\n",
        );
        yield* acquire(manifest, id);

        const pinned = yield* path.fromFileUrl(new URL(registered.artifact_url));
        const original = yield* fs.readFile(pinned);
        yield* fs.writeFileString(pinned, "// corrupt durable pin\n");
        expect(yield* Effect.flip(acquire(manifest, id))).toBeInstanceOf(NativeArtifactLoadError);
        yield* fs.writeFile(pinned, original);
        yield* acquire(manifest, id);
      }),
    60_000,
  );

  it.effect("rejects corrupt manifests, missing worker entries, and historical backfill", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { directory, manifest } = yield* prebuiltCopy("prebuilt-failures");
      const id = yield* goalInstance("Reject corrupt build");
      const rejected = Effect.flip(acquire(manifest, id));

      const worker = path.join(directory, "full-loop-worker.mjs");
      yield* fs.remove(worker);
      expect(yield* rejected).toBeInstanceOf(NativeRegistrationError);
      yield* fs.copy(
        path.join(path.dirname(runtimeArtifact("artifact-manifest.json")), "full-loop-worker.mjs"),
        worker,
      );
      yield* fs.writeFileString(manifest, "{}\n");
      expect(yield* rejected).toBeInstanceOf(NativeRegistrationError);
      yield* fs.copy(runtimeArtifact("artifact-manifest.json"), manifest);

      yield* sqlRun(
        "INSERT INTO workflow_goal_worker_generations VALUES (?, ?, ?, ?, ?)",
        id,
        "historical-sdk-only",
        "0".repeat(64),
        "file:///tmp/old-worker.mjs",
        "test",
      );
      const historical = yield* rejected;
      expect(historical).toBeInstanceOf(NativeRegistrationError);
      expect(historical).toMatchObject({ reason: "historical_goal" });
    }),
  );
});

const Provenance = Schema.Array(
  Schema.Struct({
    run_id: Schema.String,
    goal_instance_id: Schema.String,
    artifact_url: Schema.String,
    artifact_hash: Schema.String,
  }),
);

// Reopening replaces the agent behind every service, so this block reads through `env.use` only.
testAgent({ testProvider: { responder } })("native registration across reopen", (it) => {
  it.effect(
    "real Goal workers link separate Goal runs to separate registrations",
    () =>
      Effect.gen(function* () {
        const env = yield* TestEnv;
        const answer = () => ({ text: "native registered answer" });
        const a = yield* goalSession("Native execution provenance", answer);
        const b = yield* goalSession("Native execution provenance", answer);
        const run = Effect.fnUntraced(function* (sessionId: string, runId: string) {
          const response = yield* send(sessionId, runId);
          const text = yield* responseText(response);
          expect(response.status, text).toBe(200);
          expect(text).not.toContain("RUN_ERROR");
          expect(text).toContain("native registered answer");
        });
        yield* run(a, `${a}-native`);
        yield* run(b, `${b}-native`);
        const provenance = Effect.flatMap(
          rows(
            `SELECT b.run_id, b.goal_instance_id, a.artifact_url, a.artifact_hash
          FROM workflow_run_bindings b JOIN workflow_goal_native_artifacts a USING(goal_instance_id)
          WHERE b.run_id IN (?, ?) ORDER BY b.run_id`,
            `${a}-native`,
            `${b}-native`,
          ),
          Schema.decodeUnknownEffect(Provenance),
        );
        const before = yield* provenance;
        expect(before).toHaveLength(2);
        expect(before[0]!.goal_instance_id).not.toBe(before[1]!.goal_instance_id);
        expect(before[0]!.artifact_url).not.toBe(before[1]!.artifact_url);

        yield* env.reopen;
        yield* run(a, `${a}-native-reopened`);
        expect(yield* provenance).toEqual(before);
      }),
    60_000,
  );
});
