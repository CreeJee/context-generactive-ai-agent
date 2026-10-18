import { Result, Function as EffectFunction } from "effect";
import { strict as assert } from "node:assert";
import { pathToFileURL } from "node:url";
import { chat } from "@tanstack/ai";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import type * as NativeArtifact from "../../src/agent/native-artifact-entry.ts";
import { SecretStore } from "../../src/config/secrets.ts";
import { SqlClient } from "effect/sql";
import { memoryAgentLayer } from "../../src/layers.ts";
import { Embedder } from "../../src/memory/embedding/embedder.ts";
import { Nodes } from "../../src/memory/nodes.ts";
import { Projects } from "../../src/projects/projects.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import { fakeVector } from "../../src/testing/fake-embedder.ts";
import { fakeMorphLayer } from "../../src/testing/fake-morph.ts";
import { ScriptedTextAdapter } from "../../src/testing/scripted-adapter.ts";
import { NodeServices } from "@effect/platform-node";
import { Cause, Context, Exit, FileSystem, Path } from "effect";
const sdkCall = <A>(operation: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: operation, catch: (cause) => new Cause.UnknownError(cause) });
const encodeJson = EffectFunction.flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)),
  Result.getOrThrow,
);
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const platform = yield* Layer.build(NodeServices.layer);
      const fs = Context.get(platform, FileSystem.FileSystem);
      const path = Context.get(platform, Path.Path);

      // A separate native process verifies cold artifact imports and owner teardown after its runtime exits.

      const [base, a, b] = EffectFunction.flow(
        Schema.decodeUnknownResult(
          Schema.Tuple([Schema.NonEmptyString, Schema.NonEmptyString, Schema.NonEmptyString]),
        ),
        Result.getOrThrow,
      )(process.argv.slice(2));
      assert.equal(yield* fs.exists(path.join(base, "src")), false);
      assert.equal(yield* fs.exists(path.join(base, "storage", "agent.db")), false);
      const home = path.join(base, "home");
      const projectRoot = path.join(base, "project");
      yield* fs.makeDirectory(home);
      yield* fs.makeDirectory(projectRoot);
      const counts = { acquired: 0, released: 0 };
      // Fresh child services over a new test DB, NOT reopening/adopting a prior central owner.
      const runtime = ManagedRuntime.make(
        memoryAgentLayer(path.join(base, "storage"), {
          embedder: Layer.effect(
            Embedder,
            Effect.acquireRelease(
              Effect.sync(() => {
                counts.acquired++;
                return {
                  identity: "fake-trigram-64",
                  dimensions: 64,
                  embed: (texts: readonly string[]) => Effect.succeed(texts.map(fakeVector)),
                  runtime: () => ({ kind: "other" as const }),
                };
              }),
              () =>
                Effect.sync(() => {
                  counts.released++;
                }),
            ),
          ),
          morphAnalyzer: fakeMorphLayer,
          secrets: SecretStore.memory,
          interpretAutomatically: false,
          summarizeAutomatically: false,
          importsWatching: false,
          sweepSecrets: false,
          skillsHome: home,
          skillsBuiltin: path.join(base, "builtin-skills"),
          importsHome: home,
        }),
      );
      let sql: SqlClient.SqlClient | undefined;
      try {
        const services = yield* sdkCall(() =>
          runtime.runPromise(
            Effect.gen(function* () {
              const project = yield* (yield* Projects).add(projectRoot);
              const session = yield* (yield* Sessions).create(project.id);
              return { project, session, nodes: yield* Nodes, sql: yield* SqlClient.SqlClient };
            }),
          ),
        );
        sql = services.sql;
        for (const [runId, path, prefix] of [
          ["a-first", a, ""],
          ["b", b, "copied-B:"],
          ["a-next", a, ""],
        ] as const) {
          const artifact: typeof NativeArtifact = yield* sdkCall(
            () => import(pathToFileURL(path).href),
          );
          assert.deepEqual(
            Object.keys(artifact).sort(),
            [
              "createMemoryTools",
              "createSubscriptionRuntimeImplementation",
              "makePermissionGateMiddleware",
              "makeRecordingMiddleware",
            ].sort(),
          );
          const user = yield* services.nodes.append({
            projectId: services.project.id,
            sessionId: services.session.id,
            kind: "user",
            text: runId,
          });
          const recording = yield* sdkCall(() =>
            runtime.runPromise(
              artifact.makeRecordingMiddleware({
                projectId: services.project.id,
                sessionId: services.session.id,
                runId,
                userNodeId: user.id,
              }),
            ),
          );
          yield* sdkCall(() =>
            chat({
              adapter: new ScriptedTextAdapter([{ text: runId }]),
              messages: [{ role: "user", content: runId }],
              runId,
              middleware: [recording],
              stream: false,
            }),
          );
          const rows = (yield* services.nodes.session(services.session.id)).filter(
            (node) => node.kind === "assistant" && node.runId === runId,
          );
          assert.equal(rows.length, 1);
          assert.equal(rows[0]!.text, `${prefix}${runId}`);
          assert.equal(counts.acquired, 1);
          assert.equal(counts.released, 0);
        }
      } finally {
        yield* Effect.uninterruptible(sdkCall(() => runtime.dispose()));
      }
      assert.deepEqual(counts, { acquired: 1, released: 1 });
      assert.ok(sql);
      assert.ok(Exit.isFailure(yield* Effect.exit(sql`SELECT 1`)));
      yield* fs.writeFileString(
        path.join(base, "result.json"),
        encodeJson({ ...counts, sqliteClosed: true, pid: process.pid }),
      );
    }),
  ),
);
