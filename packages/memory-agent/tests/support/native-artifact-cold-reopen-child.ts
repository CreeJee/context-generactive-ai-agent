import { Result, Function as EffectFunction } from "effect";
import { strict as assert } from "node:assert";
import { pathToFileURL } from "node:url";
import { chat } from "@tanstack/ai";
import { Config, Effect, Layer, ManagedRuntime, Schema } from "effect";
import type * as NativeArtifact from "../../src/agent/native-artifact-entry.ts";
import { ChatState } from "../../src/chat-state/chat-state.ts";
import { SecretStore } from "../../src/config/secrets.ts";
import { Database } from "../../src/db/database.ts";
import { memoryAgentLayer } from "../../src/layers.ts";
import { Embedder } from "../../src/memory/embedding/embedder.ts";
import { Nodes } from "../../src/memory/nodes.ts";
import { Projects } from "../../src/projects/projects.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import { fakeVector } from "../../src/testing/fake-embedder.ts";
import { fakeMorphLayer } from "../../src/testing/fake-morph.ts";
import { ScriptedTextAdapter } from "../../src/testing/scripted-adapter.ts";
import { NodeServices } from "@effect/platform-node";
import { Cause, Context, FileSystem, Path } from "effect";
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

      // Native child entry point: HOME, persisted bytes and PID are checked across two distinct owners.

      const [base, artifactPath, phase] = EffectFunction.flow(
        Schema.decodeUnknownResult(
          Schema.Tuple([
            Schema.NonEmptyString,
            Schema.NonEmptyString,
            Schema.Literals(["first", "second"]),
          ]),
        ),
        Result.getOrThrow,
      )(process.argv.slice(2));
      assert.equal(yield* fs.exists(path.join(base, "src")), false);
      assert.equal(yield* fs.exists(path.join(base, "storage", "agent.db")), phase === "second");
      const home = path.join(base, "home");
      const projectRoot = path.join(base, "project");
      yield* fs.makeDirectory(home, { recursive: true });
      yield* fs.makeDirectory(projectRoot, { recursive: true });
      assert.equal(yield* Config.String("HOME"), home);
      const counts = { acquired: 0, released: 0 };
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
      const Snapshot = Schema.Struct({
        projectId: Schema.String,
        sessionId: Schema.String,
        nodes: Schema.String,
        run: Schema.String,
        thread: Schema.String,
        pid: Schema.Finite,
      });
      let sqlite: Database["Service"]["sqlite"] | undefined;
      let verifiedOld = false;
      try {
        const services = yield* sdkCall(() =>
          runtime.runPromise(
            Effect.gen(function* () {
              return { nodes: yield* Nodes, db: yield* Database, state: yield* ChatState };
            }),
          ),
        );
        sqlite = services.db.sqlite;
        const previous =
          phase === "second"
            ? EffectFunction.flow(
                Schema.decodeResult(Schema.fromJsonString(Snapshot)),
                Result.getOrThrow,
              )(yield* fs.readFileString(path.join(base, "snapshot.json")))
            : undefined;
        const binding =
          previous ??
          (yield* sdkCall(() =>
            runtime.runPromise(
              Effect.gen(function* () {
                const project = yield* (yield* Projects).add(projectRoot);
                const session = yield* (yield* Sessions).create(project.id);
                return { projectId: project.id, sessionId: session.id };
              }),
            ),
          ));
        const oldNodes = () =>
          encodeJson(
            services.nodes
              .session(binding.sessionId)
              .filter((node) => node.runId === "first" || node.text === "first"),
          );
        const oldRun = () =>
          services.state.persistence.stores.runs.get("first").then((run) => encodeJson(run));
        if (previous !== undefined) {
          assert.notEqual(previous.pid, process.pid);
          assert.equal(oldNodes(), previous.nodes);
          assert.equal(yield* sdkCall(() => oldRun()), previous.run);
          assert.equal(
            encodeJson(
              yield* sdkCall(() =>
                services.state.persistence.stores.messages.loadThread(binding.sessionId),
              ),
            ),
            previous.thread,
          );
          verifiedOld = true;
        }
        // Explicit NEW SDK turn, never replay/resume the first run or claim Goal admission.
        const artifact: typeof NativeArtifact = yield* sdkCall(
          () => import(pathToFileURL(artifactPath).href),
        );
        const user = services.nodes.append({ ...binding, kind: "user", text: phase });
        const recording = yield* sdkCall(() =>
          runtime.runPromise(
            artifact.makeRecordingMiddleware({ ...binding, runId: phase, userNodeId: user.id }),
          ),
        );
        const middleware: [...ReturnType<typeof services.state.middleware>, typeof recording] = [
          ...services.state.middleware(),
          recording,
        ];
        yield* sdkCall(() =>
          chat({
            adapter: new ScriptedTextAdapter([{ text: phase }]),
            messages: [{ role: "user", content: phase }],
            threadId: binding.sessionId,
            runId: phase,
            middleware,
            stream: false,
          }),
        );
        const rows = services.nodes
          .session(binding.sessionId)
          .filter((node) => node.kind === "assistant" && node.runId === phase);
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.text, phase);
        const current = yield* sdkCall(() => services.state.persistence.stores.runs.get(phase));
        assert.equal(current?.status, "completed");
        assert.equal(current?.threadId, binding.sessionId);
        if (previous !== undefined) {
          assert.equal(oldNodes(), previous.nodes);
          assert.equal(yield* sdkCall(() => oldRun()), previous.run);
        } else {
          yield* fs.writeFileString(
            path.join(base, "snapshot.json"),
            encodeJson({
              ...binding,
              nodes: oldNodes(),
              run: yield* sdkCall(() => oldRun()),
              thread: encodeJson(
                yield* sdkCall(() =>
                  services.state.persistence.stores.messages.loadThread(binding.sessionId),
                ),
              ),
              pid: process.pid,
            }),
          );
        }
        assert.deepEqual(counts, { acquired: 1, released: 0 });
      } finally {
        yield* Effect.uninterruptible(sdkCall(() => runtime.dispose()));
      }
      assert.deepEqual(counts, { acquired: 1, released: 1 });
      assert.ok(sqlite);
      assert.throws(() => sqlite.prepare("SELECT 1"));
      yield* fs.writeFileString(
        path.join(base, `${phase}.json`),
        encodeJson({ ...counts, sqliteClosed: true, pid: process.pid, verifiedOld }),
      );
    }),
  ),
);
