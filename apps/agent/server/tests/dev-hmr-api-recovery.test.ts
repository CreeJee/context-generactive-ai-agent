import { selectTestModel } from "../../../../packages/memory-agent/tests/support/provider.ts";
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { Array as EffectArray } from "effect";
// Native server integration test uses host environment, SDK Promise callbacks and I/O fixtures.
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { createServer as createHttpServer } from "node:http";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { AgentChat, Database, Sessions, Workflows } from "memory-agent";
import { createServer } from "vite-plus";
import { expect } from "vite-plus/test";
import {
  TestEnv,
  testAgent,
  type AgentServices,
} from "../../../../packages/memory-agent/tests/support/test-env.ts";
import { developmentApiProxy } from "../../vite.config";
import { createDevelopmentBoundary, developmentRequestDecision } from "../dev-safety";

// Node HTTP and Vite are real interoperability boundaries; Scope closes both
// listeners even when an assertion fails. No user dev server or storage is used.
const sdkCall = <A>(call: () => A | PromiseLike<A>) =>
  Effect.tryPromise(() => Promise.resolve(call()));
const withPlatform = Effect.fn("DevHmrTest.platform")(function* <A, E, R>(
  program: Effect.Effect<A, E, R>,
) {
  const services = yield* Layer.build(
    Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, FetchHttpClient.layer),
  );
  return yield* Effect.provideContext(program, services);
});

testAgent({ testProvider: {} })("dev HMR API recovery", (it) => {
  it.effect(
    "real two-listener Vite proxy preserves contracts through UI edits and durable SSE reconnect",
    () =>
      Effect.scoped(
        withPlatform(
          Effect.gen(function* () {
            const http = yield* HttpClient.HttpClient;
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const context = yield* TestEnv;
            const services = yield* Effect.context<AgentServices>();
            yield* selectTestModel();
            const { chat, db, sessions, workflows } = yield* Effect.provideContext(
              Effect.all({
                chat: AgentChat,
                db: Database,
                sessions: Sessions,
                workflows: Workflows,
              }),
              services,
            );
            const second = yield* Effect.provideContext(
              sessions.create(context.project.id),
              services,
            );
            for (const session of [context.session, second])
              yield* Effect.provideContext(
                workflows.updateGoal(session.id, {
                  statement: `Keep ${session.id} isolated`,
                  outcomes: ["No duplicate run"],
                  constraints: [],
                  nonGoals: [],
                  assumptions: [],
                  openQuestions: [],
                  status: "active",
                }),
                services,
              );
            yield* fs.writeFileString(
              path.join(context.project.root, "ui.tsx"),
              "export const label = 'initial UI';\n",
            );
            const boundary = createDevelopmentBoundary({
              buildId: "startup-contract",
              instanceId: "finite-test-owner",
            });
            yield* Effect.scoped(
              Effect.gen(function* () {
                const backendServices = yield* Layer.build(
                  Layer.fresh(
                    NodeHttpServer.layer(createHttpServer, {
                      port: 0,
                      host: "127.0.0.1",
                      gracefulShutdownTimeout: "100 millis",
                    }),
                  ),
                );
                const backend = yield* Effect.provideContext(
                  HttpServer.HttpServer,
                  backendServices,
                );
                yield* Effect.provideContext(
                  HttpServer.serveEffect(
                    Effect.gen(function* () {
                      const incoming = yield* HttpServerRequest.HttpServerRequest;
                      const url = new URL(incoming.url, "http://localhost");
                      const decision = developmentRequestDecision(
                        boundary,
                        incoming.method,
                        url.pathname,
                        incoming.headers["x-context-agent-build-id"],
                      );
                      if (decision.kind !== "allow")
                        return HttpServerResponse.text(decision.body, {
                          status: decision.status,
                          contentType: "application/json",
                        });
                      const request = yield* HttpServerRequest.toWeb(incoming);
                      const sessionId = url.searchParams.get("session")!;
                      const response = yield* Effect.provideContext(
                        incoming.method === "POST"
                          ? chat.handle(request, sessionId)
                          : chat.hydrate(request, sessionId),
                        services,
                      );
                      return HttpServerResponse.fromWeb(response);
                    }).pipe(
                      Effect.catchCause(() =>
                        Effect.succeed(
                          HttpServerResponse.text("finite test HTTP adapter failed", {
                            status: 500,
                          }),
                        ),
                      ),
                    ),
                  ),
                  backendServices,
                );
                const backendAddress = backend.address;
                if (backendAddress._tag === "UnixPathAddress")
                  return yield* Effect.die(new Error("HTTP fixture requires TCP"));
                const backendUrl = `http://127.0.0.1:${backendAddress.port}`;
                const frontend = yield* Effect.acquireRelease(
                  sdkCall(() =>
                    createServer({
                      configFile: false,
                      root: context.project.root,
                      appType: "custom",
                      server: {
                        host: "127.0.0.1",
                        port: 0,
                        proxy: { "/api": developmentApiProxy(backendUrl, boundary.buildId) },
                      },
                    }),
                  ),
                  (server) => sdkCall(() => server.close()).pipe(Effect.orDie),
                );
                yield* sdkCall(() => frontend.listen());
                const address = frontend.httpServer!.address();
                const { port: frontendPort } = yield* Schema.decodeUnknownEffect(
                  Schema.Struct({ port: Schema.Int }),
                )(address);
                const frontendUrl = `http://127.0.0.1:${frontendPort}`;
                const post = Effect.fn("postDevFixture")(function* (
                  sessionId: string,
                  runId: string,
                  buildId?: string,
                  base = frontendUrl,
                ) {
                  const headers = new Headers({ "Content-Type": "application/json" });
                  if (buildId !== undefined) headers.set("x-context-agent-build-id", buildId);
                  const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
                    threadId: sessionId,
                    runId,
                    messages: [{ id: runId, role: "user", content: "finite dev request" }],
                    tools: [],
                    context: [],
                  });
                  return yield* http
                    .post(`${base}/api/chat?session=${sessionId}`, {
                      headers,
                      body: HttpBody.text(body, "application/json"),
                    })
                    .pipe(Effect.timeout(10000));
                });
                const rejected = yield* post(context.session.id, "incompatible", "other-contract");
                expect(rejected.status).toBe(409);
                expect(context.provider!.adapter.invocations).toHaveLength(0);
                const first = yield* post(context.session.id, "run-a");
                expect(first.status).toBe(200);
                const firstStream = yield* first.text;
                expect(firstStream).toContain("Hello from fast-1");
                // A real UI-only file edit must not revoke the backend's startup contract.
                yield* fs.writeFileString(
                  path.join(context.project.root, "ui.tsx"),
                  "export const label = 'edited UI';\n",
                );
                const valid = yield* post(second.id, "run-b", boundary.buildId);
                expect(valid.status, valid.status === 200 ? "" : yield* valid.text).toBe(200);
                yield* valid.text;
                const direct = yield* post(
                  second.id,
                  "direct-mismatch",
                  "other-contract",
                  backendUrl,
                );
                expect(direct.status).toBe(409);
                const calls = context.provider!.adapter.invocations.length;
                const duplicate = yield* post(context.session.id, "run-a", boundary.buildId);
                expect(duplicate.status).toBe(409);
                yield* duplicate.text;
                const wrongGoal = yield* post(second.id, "run-a", boundary.buildId);
                expect(wrongGoal.status).toBe(409);
                const ids = [...firstStream.matchAll(/^id: (.+)$/gm)].map((match) => match[1]!);
                expect(ids.length).toBeGreaterThan(1);
                const reconnect = yield* http
                  .get(
                    `${frontendUrl}/api/chat?session=${context.session.id}&runId=run-a&offset=-1`,
                    { headers: { "Last-Event-ID": ids[0]! } },
                  )
                  .pipe(Effect.timeout(10000));
                expect(reconnect.status).toBe(200);
                const resumed = yield* reconnect.text;
                const resumedIds = [...resumed.matchAll(/^id: (.+)$/gm)].map((match) => match[1]!);
                expect(resumedIds).toEqual(ids.slice(1));
                expect(EffectArray.dedupe(resumedIds).length).toBe(resumedIds.length);
                expect(context.provider!.adapter.invocations).toHaveLength(calls);
                expect(
                  db.sqlite
                    .prepare("SELECT run_id, session_id FROM workflow_run_bindings ORDER BY run_id")
                    .all(),
                ).toEqual([
                  { run_id: "run-a", session_id: context.session.id },
                  { run_id: "run-b", session_id: second.id },
                ]);
              }),
            );
          }),
        ),
      ),
    30000,
  );
});
