import { it } from "@effect/vitest";
import { NodeCrypto, NodeFileSystem, NodePath } from "@effect/platform-node";
import {
  Cause,
  ConfigProvider,
  Crypto,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  ManagedRuntime,
  Path,
  Schema,
} from "effect";
import { memoryAgentLayer } from "memory-agent";
import { expect } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { OwnerNativeBuild } from "../src/agent/owner-native-build.ts";
import { SecretStore } from "../src/config/secrets.ts";
import { Database } from "../src/db/database.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { fakeEmbedderLayer } from "../src/testing/fake-embedder.ts";
import { fakeMorphLayer } from "../src/testing/fake-morph.ts";
import { Workflows } from "../src/workflow/workflow.ts";
import { testRuntime } from "./support/runtime.ts";

const Registration = Schema.Array(
  Schema.Struct({
    goal_instance_id: Schema.String,
    artifact_url: Schema.String,
    artifact_hash: Schema.String,
    source_hash: Schema.String,
  }),
);

it.live(
  "real native changed-source builds isolate simultaneous Goals and retain V1 after reopen",
  () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const join = pathService.join;
        const held = yield* Deferred.make<void>();
        const started = yield* Deferred.make<void>();
        let calls = 0;
        const context = yield* sdkCall(() =>
          testRuntime({
            testProvider: {
              responder: Effect.fn("NativeGenerationTest.responder")(function* () {
                if (calls++ === 0) {
                  yield* Deferred.succeed(started, undefined);
                  yield* Deferred.await(held);
                }
                return { text: "actual native isolation answer" };
              }),
            },
          }),
        );
        yield* sdkCall(() => context.runtime.dispose());
        const entry = join(context.base, "controlled-native-entry.ts");
        const observations = join(context.base, "native-observations.jsonl");
        yield* fs.writeFileString(observations, "");
        const productionEntry = yield* pathService.fromFileUrl(
          new URL("../src/agent/native-artifact-entry.ts", import.meta.url),
        );
        const source = Effect.fn("NativeGenerationTest.source")(function* (version: string) {
          return `
import { appendFileSync } from "node:fs";
import { Effect } from "effect";
import { makeRecordingMiddleware as original } from ${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(productionEntry)};
export { makePermissionGateMiddleware, createMemoryTools, createSubscriptionRuntimeImplementation } from ${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(productionEntry)};
export const makeRecordingMiddleware = Effect.fnUntraced(function* (binding) {
  appendFileSync(${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(observations)}, JSON.stringify({ run: binding.runId, version: ${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(version)} }) + "\\n");
  return yield* original(binding);
});
`;
        });
        yield* fs.writeFileString(entry, yield* source("V1"));
        const open = () =>
          ManagedRuntime.make(
            memoryAgentLayer(context.storage, {
              embedder: fakeEmbedderLayer,
              morphAnalyzer: fakeMorphLayer,
              secrets: SecretStore.memory,
              providerRegistry: context.provider!.layer,
              interpretAutomatically: false,
              summarizeAutomatically: false,
              skillsHome: context.home,
              skillsBuiltin: join(context.base, "builtin-skills"),
              importsHome: context.home,
              importsWatching: false,
              sweepSecrets: false,
            }).pipe(
              Layer.provide(Layer.succeed(OwnerNativeBuild, { entry })),
              Layer.provideMerge(
                ConfigProvider.layerAdd(
                  ConfigProvider.fromUnknown({
                    CONTEXT_AGENT_NATIVE_ARTIFACT: "1",
                    CONTEXT_AGENT_GOAL_WORKER: "1",
                  }),
                  { asPrimary: true },
                ),
              ),
            ),
          );
        let runtime = open();
        yield* Effect.addFinalizer(() => sdkCall(() => runtime.dispose()).pipe(Effect.orDie));
        yield* Effect.addFinalizer(() => Deferred.succeed(held, undefined));
        yield* sdkCall(() => context.provider!.select(runtime));
        const owner = yield* Effect.provideContext(
          Effect.all({ db: Database, sessions: Sessions, workflows: Workflows }),
          yield* runtime.contextEffect,
        );
        const second = yield* Effect.provideContext(
          owner.sessions.create(context.project.id),
          yield* runtime.contextEffect,
        );
        for (const session of [context.session.id, second.id])
          yield* Effect.provideContext(
            owner.workflows.updateGoal(session, {
              statement: "Native source isolation",
              outcomes: ["Pin native source per Goal"],
              constraints: [],
              nonGoals: [],
              assumptions: [],
              openQuestions: [],
              status: "active",
            }),
            yield* runtime.contextEffect,
          );
        const send = Effect.fn("NativeGenerationTest.send")(function* (
          session: string,
          run: string,
        ) {
          const request = new Request("http://localhost/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
              threadId: session,
              runId: run,
              messages: [{ id: run, role: "user", content: "hello" }],
              tools: [],
              context: [],
            }),
          });
          const response = yield* Effect.provideContext(
            Effect.flatMap(AgentChat, (chat) => chat.handle(request, session)),
            yield* runtime.contextEffect,
          );
          expect(response.status).toBe(200);
          const text = yield* sdkCall(() => response.text());
          expect(text).not.toContain("RUN_ERROR");
          expect(text).toContain("actual native isolation answer");
        });
        const first = yield* Effect.forkChild(send(context.session.id, "isolation-v1-held"), {
          startImmediately: true,
        });
        yield* Deferred.await(started);
        yield* fs.writeFileString(entry, yield* source("V2"));
        yield* send(second.id, "isolation-v2");
        yield* Deferred.succeed(held, undefined);
        yield* Fiber.join(first);
        yield* send(context.session.id, "isolation-v1-followup");
        const registrations = Effect.fn("NativeGenerationTest.registrations")(function* (
          db: Database["Service"],
        ) {
          return yield* Schema.decodeUnknownEffect(Registration)(
            db.sqlite
              .prepare(
                "SELECT goal_instance_id, artifact_url, artifact_hash, source_hash FROM workflow_goal_native_artifacts ORDER BY goal_instance_id",
              )
              .all(),
          );
        });
        const before = yield* registrations(owner.db);
        expect(before).toHaveLength(2);
        expect(before[0]!.artifact_hash).not.toBe(before[1]!.artifact_hash);
        expect(before[0]!.source_hash).not.toBe(before[1]!.source_hash);
        for (const registration of before) {
          const path = yield* pathService.fromFileUrl(new URL(registration.artifact_url));
          const bytes = yield* fs.readFile(path);
          expect(Buffer.from(yield* crypto.digest("SHA-256", bytes)).toString("hex")).toBe(
            registration.artifact_hash,
          );
        }
        yield* sdkCall(() => runtime.dispose());
        runtime = open();
        yield* send(context.session.id, "isolation-v1-reopened");
        expect(
          yield* registrations(
            yield* Effect.provideContext(Database, yield* runtime.contextEffect),
          ),
        ).toEqual(before);
        const lines = (yield* fs.readFileString(observations)).trim().split("\n");
        const seen = yield* Effect.forEach(lines, (line) =>
          Schema.decodeEffect(
            Schema.fromJsonString(Schema.Struct({ run: Schema.String, version: Schema.String })),
          )(line),
        );
        expect(seen).toEqual([
          { run: "isolation-v1-held", version: "V1" },
          { run: "isolation-v2", version: "V2" },
          { run: "isolation-v1-followup", version: "V1" },
          { run: "isolation-v1-reopened", version: "V1" },
        ]);
        const links = yield* Effect.provideContext(
          Effect.map(Database, (db) =>
            db.sqlite
              .prepare(
                "SELECT run_id FROM workflow_run_bindings b JOIN workflow_goal_native_artifacts a USING(goal_instance_id) WHERE run_id LIKE 'isolation-%'",
              )
              .all(),
          ),
          yield* runtime.contextEffect,
        );
        expect(links).toHaveLength(4);
      }),
    ),
  60000,
);

const sdkCall = Effect.fn("NativeGenerationTest.sdkCall")(<A>(call: () => A | PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(call()),
    catch: (cause) => new Cause.UnknownError(cause),
  }),
);
const withPlatform = Effect.fn("NativeGenerationTest.platform")(function* <A, E, R>(
  program: Effect.Effect<A, E, R>,
) {
  const services = yield* Layer.build(
    Layer.mergeAll(NodeCrypto.layer, NodeFileSystem.layer, NodePath.layer),
  );
  return yield* Effect.provideContext(program, services);
});
