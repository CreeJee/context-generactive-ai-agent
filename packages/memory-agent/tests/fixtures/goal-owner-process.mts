import { nativeStream } from "../../src/runtime/native-stream.ts";
// Native subprocess signals, IPC, environment and SDK AsyncGenerator are the fixture owner boundary.
import { isTruthy } from "../../src/truthy.ts";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { Cause, Deferred, Effect, ManagedRuntime, Schema, Stream } from "effect";
import { memoryAgentLayer, Projects, Sessions } from "../../src/index.ts";
import { AgentChat } from "../../src/agent/chat.ts";
import { Database } from "../../src/db/database.ts";
import { SecretStore } from "../../src/config/secrets.ts";
import { fakeEmbedderLayer } from "../../src/testing/fake-embedder.ts";
import { fakeMorphLayer } from "../../src/testing/fake-morph.ts";
import { Workflows } from "../../src/workflow/workflow.ts";
import { testProvider, turnGate } from "../support/provider.ts";

const [base, mode] = process.argv.slice(2);
if (!isTruthy(base)) throw new Error("Missing owned temporary root");
process.env.CONTEXT_AGENT_GOAL_WORKER = "1";
const gate = turnGate();
const provider = testProvider({
  responder: () => {
    appendFileSync(join(base, "model-calls"), `${process.pid}\n`);
    return mode === "blocked"
      ? { text: "never completed", waitFor: gate.waitFor }
      : { text: "completed owner turn" };
  },
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
      const home = join(base, "home");
      mkdirSync(home, { recursive: true });
      const runtime = yield* Effect.acquireRelease(
        Effect.sync(() =>
          ManagedRuntime.make(
            memoryAgentLayer(join(base, "storage"), {
              embedder: fakeEmbedderLayer,
              morphAnalyzer: fakeMorphLayer,
              interpretAutomatically: false,
              summarizeAutomatically: false,
              secrets: SecretStore.memory,
              skillsHome: home,
              skillsBuiltin: join(base, "builtin"),
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
      if (mode === "reopen") sessionId = readFileSync(join(base, "session"), "utf8");
      else {
        mkdirSync(join(base, "project"), { recursive: true });
        sessionId = yield* Effect.provideContext(
          Effect.gen(function* () {
            const project = yield* (yield* Projects).add(join(base, "project"));
            return (yield* (yield* Sessions).create(project.id)).id;
          }),
          services,
        );
        writeFileSync(join(base, "session"), sessionId);
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
      // Test-only loopback adapter; this is not the application's authentication route.
      const server = createServer((incoming, outgoing) => {
        void runNative(
          Effect.scoped(
            Effect.gen(function* () {
              const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
              if (url.pathname === "/inspect") {
                outgoing.setHeader("Content-Type", "application/json");
                outgoing.end(
                  yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
                    runs: db.sqlite.prepare("SELECT * FROM chat_runs ORDER BY started_at").all(),
                    bindings: db.sqlite.prepare("SELECT * FROM workflow_run_bindings").all(),
                    operations: db.sqlite.prepare("SELECT * FROM owner_rpc_operations").all(),
                    revisions: db.sqlite.prepare("SELECT * FROM workflow_state_revisions").all(),
                    dispatches: db.sqlite.prepare("SELECT * FROM workflow_worker_dispatches").all(),
                  }),
                );
                return;
              }
              const parts = yield* Stream.runCollect(
                Stream.fromAsyncIterable(incoming, (cause) => new Cause.UnknownError(cause)),
              );
              const headers = new Headers();
              for (const [name, value] of Object.entries(incoming.headers)) {
                if (value !== undefined)
                  headers.set(name, Array.isArray(value) ? value.join(",") : value);
              }
              const request = new Request(
                url,
                incoming.method === "POST"
                  ? {
                      method: "POST",
                      headers,
                      body: Buffer.concat(parts.map((part) => Buffer.from(part))).toString(),
                    }
                  : { headers },
              );
              const response = yield* Effect.provideContext(
                incoming.method === "POST"
                  ? chat.handle(request, sessionId)
                  : chat.hydrate(request, sessionId),
                services,
              );
              outgoing.writeHead(response.status, Object.fromEntries(response.headers));
              if (isTruthy(response.body)) {
                const reader = response.body.getReader();
                for (;;) {
                  const chunk = yield* sdkCall(() => reader.read());
                  if (chunk.done) break;
                  outgoing.write(chunk.value);
                }
              }
              outgoing.end();
            }),
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => {
                outgoing.writeHead(500);
                outgoing.end(Cause.pretty(cause));
              }),
            ),
          ),
        );
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          gate.release();
          server.closeAllConnections();
        }).pipe(
          Effect.andThen(
            Effect.callback<void>((resume) => {
              server.close(() => resume(Effect.void));
            }),
          ),
        ),
      );
      yield* Effect.callback<void>((resume) => {
        server.listen(0, "127.0.0.1", () => resume(Effect.void));
      });
      const { port } = yield* Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Int }))(
        server.address(),
      );
      process.send?.({ type: "ready", port, sessionId, pid: process.pid });
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
    }),
  ),
);
process.exit(0);
