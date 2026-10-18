import { chatRoute } from "../support/chat-route.ts";
import { testHttpServer, HttpServerRequest, HttpServerResponse } from "../support/http.ts";
import { withTestPlatform } from "../support/platform.ts";
import { nativeStream } from "../../src/runtime/native-stream.ts";
// Native subprocess signals, IPC, environment and SDK AsyncGenerator are the fixture owner boundary.
import {
  Cause,
  Console,
  Deferred,
  Effect,
  FileSystem,
  ManagedRuntime,
  Path,
  Schema,
  Stream,
} from "effect";
import { memoryAgentLayer, Projects, Sessions } from "../../src/index.ts";
import { AgentChat } from "../../src/agent/chat.ts";
import { Database } from "../../src/db/database.ts";
import { SecretStore } from "../../src/config/secrets.ts";
import { fakeEmbedderLayer } from "../../src/testing/fake-embedder.ts";
import { fakeMorphLayer } from "../../src/testing/fake-morph.ts";
import { Workflows } from "../../src/workflow/workflow.ts";
import { testProvider, turnGate } from "../support/provider.ts";

const [base, mode] = process.argv.slice(2);
if (base === undefined || base === "") throw new Error("Missing owned temporary root");
const gate = turnGate();
let appendModelCall = Effect.void;
const provider = testProvider({
  responder: Effect.fn("recordFixtureModelCall")(function* () {
    yield* appendModelCall;
    return mode === "blocked"
      ? { text: "never completed", waitFor: gate.waitFor }
      : { text: "completed owner turn" };
  }),
});
// Preserve the original adapter instance, capabilities and methods; only wrap
// its stream in this owned subprocess to hold the terminal behind a text chunk.
if (mode === "partial") {
  const original = provider.adapter.chatStream.bind(provider.adapter);
  provider.adapter.chatStream = (...args) =>
    nativeStream(
      Stream.fromAsyncIterable(original(...args), (cause) => new Cause.UnknownError(cause)).pipe(
        Stream.flatMap((chunk) =>
          Stream.concat(
            Stream.succeed(chunk),
            Stream.fromEffect(
              chunk.type === "TEXT_MESSAGE_CONTENT" ? gate.waitFor : Effect.void,
            ).pipe(Stream.drain),
          ),
        ),
      ),
    );
}
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
      const { chat, db, workflows } = yield* Effect.provideContext(
        Effect.all({ chat: AgentChat, db: Database, workflows: Workflows }),
        services,
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
            return yield* HttpServerResponse.json({
              runs: db.sqlite.prepare("SELECT * FROM chat_runs ORDER BY started_at").all(),
              bindings: db.sqlite.prepare("SELECT * FROM workflow_run_bindings").all(),
              operations: db.sqlite.prepare("SELECT * FROM owner_rpc_operations").all(),
              revisions: db.sqlite.prepare("SELECT * FROM workflow_state_revisions").all(),
              dispatches: db.sqlite.prepare("SELECT * FROM workflow_worker_dispatches").all(),
              executions: db.sqlite
                .prepare(
                  "SELECT json_extract(payload_json, '$.identity.runId') AS runId, status FROM owner_workflow_executions WHERE workflow_name = 'GoalExecution'",
                )
                .all(),
            });
          const request = yield* HttpServerRequest.toWeb(incoming);
          const response = yield* Effect.provideContext(
            chatRoute(chat, request, sessionId),
            services,
          );
          return HttpServerResponse.fromWeb(response);
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
