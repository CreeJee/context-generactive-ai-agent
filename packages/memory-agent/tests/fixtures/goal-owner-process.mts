import { testHttpServer, HttpServerRequest, HttpServerResponse } from "../support/http.ts";
import { withTestPlatform } from "../support/platform.ts";
import { optionalProperty } from "../../src/optional-property.ts";
import type { LanguageModel } from "effect/ai";
// Native subprocess signals, IPC, environment and SDK AsyncGenerator are the fixture owner boundary.
import {
  Cause,
  Console,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  ManagedRuntime,
  Path,
  Schema,
  Stream,
} from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import {
  BtwApiHandlers,
  ChatApiHandlers,
  memoryAgentLayer,
  Projects,
  Sessions,
} from "../../src/index.ts";
import { ChatApi, SameSite } from "../../src/api/chat-api.ts";
import { SqlClient } from "effect/sql";
import { SecretStore } from "../../src/config/secrets.ts";
import { fakeEmbedderLayer } from "../../src/testing/fake-embedder.ts";
import { fakeMorphLayer } from "../../src/testing/fake-morph.ts";
import { Workflows } from "../../src/workflow/workflow.ts";
import { testProvider, turnGate } from "../support/provider.ts";
import { sqlAll } from "../support/sql.ts";

const [base, mode] = process.argv.slice(2);
if (base === undefined || base === "") throw new Error("Missing owned temporary root");
const gate = turnGate();
let appendModelCall = Effect.void;
// Preserve the scripted model; only wrap its stream in this owned subprocess to hold the run
// behind its text.
const heldAfterText = (model: LanguageModel.LanguageModel): LanguageModel.LanguageModel => ({
  ...model,
  // SAFETY: the parts pass through unchanged; only their timing changes.
  streamText: ((options: Parameters<LanguageModel.LanguageModel["streamText"]>[0]) =>
    model
      .streamText(options)
      .pipe(
        Stream.flatMap((part) =>
          Stream.concat(
            Stream.succeed(part),
            Stream.fromEffect(part.type === "text-delta" ? gate.waitFor : Effect.void).pipe(
              Stream.drain,
            ),
          ),
        ),
      )) as LanguageModel.LanguageModel["streamText"],
});
const provider = testProvider({
  responder: Effect.fn("recordFixtureModelCall")(function* () {
    yield* appendModelCall;
    return mode === "blocked"
      ? { text: "never completed", waitFor: gate.waitFor }
      : { text: "completed owner turn" };
  }),
  ...optionalProperty("model", mode === "partial" ? heldAfterText : undefined),
});
const sdkCall = <A,>(call: () => A | PromiseLike<A>) =>
  Effect.tryPromise(() => Promise.resolve(call()));

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = path.join(base, "home");
      yield* fs.makeDirectory(home, { recursive: true });
      appendModelCall = fs
        .writeFileString(path.join(base, "model-calls"), `${process.pid}\n`, { flag: "a" })
        .pipe(Effect.orDie);
      const runtime = yield* Effect.acquireRelease(
        Effect.sync(() =>
          ManagedRuntime.make(
            memoryAgentLayer(path.join(base, "storage"), {
              embedder: fakeEmbedderLayer,
              morphAnalyzer: fakeMorphLayer,
              interpretAutomatically: false,
              summarizeAutomatically: false,
              secrets: SecretStore.memory,
              skillsHome: home,
              skillsBuiltin: path.join(base, "builtin"),
              importsHome: home,
              importsWatching: false,
              sweepSecrets: false,
              providerRegistry: provider.layer,
            }),
          ),
        ),
        (runtime) => sdkCall(() => runtime.dispose()).pipe(Effect.orDie),
      );
      yield* sdkCall(() => provider.select(runtime));
      const services = yield* runtime.contextEffect;
      const runNative = Effect.runPromiseWith(services);
      const { sql, workflows } = yield* Effect.provideContext(
        Effect.all({ sql: SqlClient.SqlClient, workflows: Workflows }),
        services,
      );
      // The chat API as the app serves it; these requests come from the test itself.
      const chatApi = yield* Effect.acquireRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            HttpApiBuilder.layer(ChatApi).pipe(
              Layer.provide(Layer.merge(ChatApiHandlers, BtwApiHandlers)),
              Layer.provide(Layer.succeed(SameSite, (httpEffect) => httpEffect)),
              Layer.provide(Layer.succeedContext(services)),
              Layer.provide(HttpServer.layerServices),
            ),
            { disableLogger: true },
          ),
        ),
        (web) => sdkCall(() => web.dispose()).pipe(Effect.orDie),
      );
      let sessionId: string;
      if (mode === "reopen") sessionId = yield* fs.readFileString(path.join(base, "session"));
      else {
        yield* fs.makeDirectory(path.join(base, "project"), { recursive: true });
        sessionId = yield* Effect.provideContext(
          Effect.gen(function* () {
            const project = yield* (yield* Projects).add(path.join(base, "project"));
            return (yield* (yield* Sessions).create(project.id)).id;
          }),
          services,
        );
        yield* fs.writeFileString(path.join(base, "session"), sessionId);
        yield* Effect.provideContext(
          workflows.updateGoal(sessionId, {
            statement: "Preserve OS owner evidence",
            outcomes: ["Never replay interrupted model work"],
            constraints: [],
            nonGoals: [],
            assumptions: [],
            openQuestions: [],
            status: "active",
          }),
          services,
        );
      }
      const { port } = yield* testHttpServer(
        Effect.gen(function* () {
          const incoming = yield* HttpServerRequest.HttpServerRequest;
          const url = new URL(incoming.url, "http://127.0.0.1");
          if (url.pathname === "/inspect")
            return yield* Effect.all({
              runs: sqlAll("SELECT * FROM chat_runs ORDER BY started_at"),
              bindings: sqlAll("SELECT * FROM workflow_run_bindings"),
              operations: sqlAll("SELECT * FROM owner_rpc_operations"),
              revisions: sqlAll("SELECT * FROM workflow_state_revisions"),
              executions: sqlAll(
                "SELECT json_extract(payload_json, '$.identity.runId') AS runId, status FROM owner_workflow_executions WHERE workflow_name = 'GoalExecution'",
              ),
            }).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
              Effect.flatMap(HttpServerResponse.json),
            );
          const request = yield* HttpServerRequest.toWeb(incoming);
          return HttpServerResponse.fromWeb(yield* sdkCall(() => chatApi.handler(request)));
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
          ),
        ),
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => gate.release()));
      yield* Console.log(
        "OWNER_READY " +
          (yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({ port, sessionId })),
      );
      const stopping = yield* Deferred.make<void>();
      const stop = () => {
        void runNative(Deferred.succeed(stopping, undefined));
      };
      process.on("SIGTERM", stop);
      process.on("disconnect", stop);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          process.off("SIGTERM", stop);
          process.off("disconnect", stop);
        }),
      );
      yield* Deferred.await(stopping).pipe(Effect.timeoutOption("45 seconds"));
    }).pipe(withTestPlatform),
  ),
);
process.exit(0);
