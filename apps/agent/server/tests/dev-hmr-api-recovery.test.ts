import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Array as EffectArray } from "effect";
// Native server integration test uses host environment, SDK Promise callbacks and I/O fixtures.
import { isTruthy } from "../../app/truthy.ts";
import { createServer as createHttpServer, type Server } from "node:http";
import { Cause, Effect, FileSystem, Layer, Path, Predicate, Schema, Stream } from "effect";
import { AgentChat, Database, Sessions, Workflows } from "memory-agent";
import { createServer } from "vite-plus";
import { expect, vi } from "vite-plus/test";
import { testRuntime } from "../../../../packages/memory-agent/tests/support/runtime.ts";
import { developmentApiProxy } from "../../vite.config";
import { createDevelopmentBoundary, developmentRequestDecision } from "../dev-safety";

// Node HTTP and Vite are real interoperability boundaries; Scope closes both
// listeners even when an assertion fails. No user dev server or storage is used.
const sdkCall = <A>(call: () => A | PromiseLike<A>) =>
  Effect.tryPromise(() => Promise.resolve(call()));
const withPlatform = Effect.fn("DevHmrTest.platform")(function* <A, E, R>(
  program: Effect.Effect<A, E, R>,
) {
  const services = yield* Layer.build(Layer.merge(NodeFileSystem.layer, NodePath.layer));
  return yield* Effect.provideContext(program, services);
});
const listen = Effect.fn("listenDevFixture")(function* (server: Server) {
  yield* Effect.callback<void, Cause.UnknownError>((resume) => {
    const onError = (error: Error) => resume(Effect.fail(new Cause.UnknownError(error)));
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => resume(Effect.void));
    return Effect.sync(() => {
      server.off("error", onError);
    });
  });
  const { port } = yield* Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Int }))(
    server.address(),
  );
  return `http://127.0.0.1:${port}`;
});
const close = (server: Server) =>
  Effect.callback<void>((resume) => {
    server.closeAllConnections();
    server.close(() => resume(Effect.void));
  });

it.live(
  "real two-listener Vite proxy preserves contracts through UI edits and durable SSE reconnect",
  () => {
    vi.stubEnv("CONTEXT_AGENT_GOAL_WORKER", "1");
    return Effect.scoped(
      withPlatform(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllEnvs()));
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const context = yield* sdkCall(() => testRuntime({ testProvider: {} }));
          yield* sdkCall(() => context.provider!.select(context.runtime));
          const services = yield* context.runtime.contextEffect;
          const runNative = Effect.runPromiseWith(services);
          const { chat, db, sessions, workflows } = yield* Effect.provideContext(
            Effect.all({ chat: AgentChat, db: Database, sessions: Sessions, workflows: Workflows }),
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
          const boundary = createDevelopmentBoundary("startup-contract", "finite-test-owner");
          yield* Effect.scoped(
            Effect.gen(function* () {
              const backend = yield* Effect.acquireRelease(
                Effect.sync(() =>
                  createHttpServer((incoming, outgoing) => {
                    void runNative(
                      Effect.scoped(
                        Effect.gen(function* () {
                          const url = new URL(incoming.url ?? "/", "http://localhost");
                          const header = incoming.headers["x-context-agent-build-id"];
                          const decision = developmentRequestDecision(
                            boundary,
                            incoming.method,
                            url.pathname,
                            Predicate.isString(header) ? header : undefined,
                          );
                          if (decision.kind !== "allow") {
                            outgoing.writeHead(decision.status, {
                              "Content-Type": "application/json",
                            });
                            outgoing.end(decision.body);
                            return;
                          }
                          const chunks = yield* Stream.runCollect(
                            Stream.fromAsyncIterable(
                              incoming,
                              (cause) => new Cause.UnknownError(cause),
                            ),
                          );
                          const headers = new Headers();
                          for (const [key, value] of Object.entries(incoming.headers))
                            if (Predicate.isString(value)) headers.set(key, value);
                          const init: RequestInit = { method: incoming.method, headers };
                          if (incoming.method === "POST")
                            init.body = Buffer.concat(
                              chunks.map((chunk) => Buffer.from(chunk)),
                            ).toString();
                          const request = new Request(url, init);
                          const sessionId = url.searchParams.get("session")!;
                          const response = yield* Effect.provideContext(
                            incoming.method === "POST"
                              ? chat.handle(request, sessionId)
                              : chat.hydrate(request, sessionId),
                            services,
                          );
                          outgoing.writeHead(response.status, Object.fromEntries(response.headers));
                          if (isTruthy(response.body))
                            yield* Stream.runForEach(
                              Stream.fromAsyncIterable(
                                response.body,
                                (cause) => new Cause.UnknownError(cause),
                              ),
                              (chunk) =>
                                Effect.sync(() => {
                                  outgoing.write(chunk);
                                }),
                            );
                          outgoing.end();
                        }),
                      ).pipe(
                        Effect.catchCause(() =>
                          Effect.sync(() => {
                            outgoing.writeHead(500);
                            outgoing.end("finite test HTTP adapter failed");
                          }),
                        ),
                      ),
                    );
                  }),
                ),
                close,
              );
              const backendUrl = yield* listen(backend);
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
                return yield* sdkCall(() =>
                  fetch(`${base}/api/chat?session=${sessionId}`, {
                    method: "POST",
                    signal: AbortSignal.timeout(10000),
                    headers,
                    body,
                  }),
                );
              });
              const rejected = yield* post(context.session.id, "incompatible", "other-contract");
              expect(rejected.status).toBe(409);
              expect(context.provider!.adapter.invocations).toHaveLength(0);
              const first = yield* post(context.session.id, "run-a");
              expect(first.status).toBe(200);
              const firstStream = yield* sdkCall(() => first.text());
              expect(firstStream).toContain("Hello from fast-1");
              // A real UI-only file edit must not revoke the backend's startup contract.
              yield* fs.writeFileString(
                path.join(context.project.root, "ui.tsx"),
                "export const label = 'edited UI';\n",
              );
              const valid = yield* post(second.id, "run-b", boundary.buildId);
              expect(valid.status).toBe(200);
              yield* sdkCall(() => valid.text());
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
              yield* sdkCall(() => duplicate.text());
              const wrongGoal = yield* post(second.id, "run-a", boundary.buildId);
              expect(wrongGoal.status).toBe(409);
              const ids = [...firstStream.matchAll(/^id: (.+)$/gm)].map((match) => match[1]!);
              expect(ids.length).toBeGreaterThan(1);
              const reconnect = yield* sdkCall(() =>
                fetch(
                  `${frontendUrl}/api/chat?session=${context.session.id}&runId=run-a&offset=-1`,
                  {
                    headers: { "Last-Event-ID": ids[0]! },
                    signal: AbortSignal.timeout(10000),
                  },
                ),
              );
              expect(reconnect.status).toBe(200);
              const resumed = yield* sdkCall(() => reconnect.text());
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
    );
  },
  30000,
);
