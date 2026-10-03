import { createServer as createHttpServer, type Server } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Predicate } from "effect";
import { AgentChat, Database, Sessions, Workflows } from "memory-agent";
import { createServer } from "vite-plus";
import { expect, test } from "vite-plus/test";
import { testRuntime } from "../../../../packages/memory-agent/tests/support/runtime.ts";
import { developmentApiProxy } from "../../vite.config";
import { createDevelopmentBoundary, developmentRequestDecision } from "../dev-safety";

// Node HTTP and Vite are real interoperability boundaries; Scope closes both
// listeners even when an assertion fails. No user dev server or storage is used.
const listen = (server: Server) =>
  Effect.promise(
    () =>
      new Promise<string>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (!address || Predicate.isString(address)) return reject(new Error("No loopback port"));
          resolve(`http://127.0.0.1:${address.port}`);
        });
      }),
  );
const close = (server: Server) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );

test("real two-listener Vite proxy preserves contracts through UI edits and durable SSE reconnect", async () => {
  const previous = process.env.CONTEXT_AGENT_GOAL_WORKER;
  process.env.CONTEXT_AGENT_GOAL_WORKER = "1";
  try {
    const context = await testRuntime({ testProvider: {} });
    await context.provider!.select(context.runtime);
    const { chat, db, sessions, workflows } = await context.runtime.runPromise(
      Effect.all({ chat: AgentChat, db: Database, sessions: Sessions, workflows: Workflows }),
    );
    const second = await context.runtime.runPromise(sessions.create(context.project.id));
    for (const session of [context.session, second])
      await context.runtime.runPromise(
        workflows.updateGoal(session.id, {
          statement: `Keep ${session.id} isolated`,
          outcomes: ["No duplicate run"],
          constraints: [],
          nonGoals: [],
          assumptions: [],
          openQuestions: [],
          status: "active",
        }),
      );
    writeFileSync(join(context.project.root, "ui.tsx"), "export const label = 'initial UI';\n");
    const boundary = createDevelopmentBoundary("startup-contract", "finite-test-owner");
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const backend = yield* Effect.acquireRelease(
            Effect.sync(() =>
              createHttpServer((incoming, outgoing) => {
                void (async () => {
                  const url = new URL(incoming.url ?? "/", "http://localhost");
                  const header = incoming.headers["x-context-agent-build-id"];
                  const decision = developmentRequestDecision(
                    boundary,
                    incoming.method,
                    url.pathname,
                    Predicate.isString(header) ? header : undefined,
                  );
                  if (decision.kind !== "allow") {
                    outgoing.writeHead(decision.status, { "Content-Type": "application/json" });
                    outgoing.end(decision.body);
                    return;
                  }
                  const chunks: Buffer[] = [];
                  for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
                  const headers = new Headers();
                  for (const [key, value] of Object.entries(incoming.headers))
                    if (Predicate.isString(value)) headers.set(key, value);
                  const init: RequestInit = { method: incoming.method, headers };
                  if (incoming.method === "POST") init.body = Buffer.concat(chunks).toString();
                  const request = new Request(url, init);
                  const sessionId = url.searchParams.get("session")!;
                  const response = await context.runtime.runPromise(
                    incoming.method === "POST"
                      ? chat.handle(request, sessionId)
                      : chat.hydrate(request, sessionId),
                  );
                  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
                  if (response.body) for await (const chunk of response.body) outgoing.write(chunk);
                  outgoing.end();
                })().catch(() => {
                  outgoing.writeHead(500);
                  outgoing.end("finite test HTTP adapter failed");
                });
              }),
            ),
            close,
          );
          const backendUrl = yield* listen(backend);
          const frontend = yield* Effect.acquireRelease(
            Effect.promise(() =>
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
            (server) => Effect.promise(() => server.close()),
          );
          yield* Effect.promise(() => frontend.listen());
          const address = frontend.httpServer!.address();
          if (!address || Predicate.isString(address)) throw new Error("No frontend port");
          const frontendUrl = `http://127.0.0.1:${address.port}`;
          const post = (sessionId: string, runId: string, buildId?: string, base = frontendUrl) => {
            const headers = new Headers({ "Content-Type": "application/json" });
            if (buildId !== undefined) headers.set("x-context-agent-build-id", buildId);
            return fetch(`${base}/api/chat?session=${sessionId}`, {
              method: "POST",
              signal: AbortSignal.timeout(10000),
              headers,
              body: JSON.stringify({
                threadId: sessionId,
                runId,
                messages: [{ id: runId, role: "user", content: "finite dev request" }],
                tools: [],
                context: [],
              }),
            });
          };
          const rejected = yield* Effect.promise(() =>
            post(context.session.id, "incompatible", "other-contract"),
          );
          expect(rejected.status).toBe(409);
          expect(context.provider!.adapter.invocations).toHaveLength(0);
          const first = yield* Effect.promise(() => post(context.session.id, "run-a"));
          expect(first.status).toBe(200);
          const firstStream = yield* Effect.promise(() => first.text());
          expect(firstStream).toContain("Hello from fast-1");
          // A real UI-only file edit must not revoke the backend's startup contract.
          writeFileSync(
            join(context.project.root, "ui.tsx"),
            "export const label = 'edited UI';\n",
          );
          const valid = yield* Effect.promise(() => post(second.id, "run-b", boundary.buildId));
          expect(valid.status).toBe(200);
          yield* Effect.promise(() => valid.text());
          const direct = yield* Effect.promise(() =>
            post(second.id, "direct-mismatch", "other-contract", backendUrl),
          );
          expect(direct.status).toBe(409);
          const calls = context.provider!.adapter.invocations.length;
          const duplicate = yield* Effect.promise(() =>
            post(context.session.id, "run-a", boundary.buildId),
          );
          expect(duplicate.status).toBe(409);
          yield* Effect.promise(() => duplicate.text());
          const wrongGoal = yield* Effect.promise(() => post(second.id, "run-a", boundary.buildId));
          expect(wrongGoal.status).toBe(409);
          const ids = [...firstStream.matchAll(/^id: (.+)$/gm)].map((match) => match[1]!);
          expect(ids.length).toBeGreaterThan(1);
          const reconnect = yield* Effect.promise(() =>
            fetch(`${frontendUrl}/api/chat?session=${context.session.id}&runId=run-a&offset=-1`, {
              headers: { "Last-Event-ID": ids[0]! },
              signal: AbortSignal.timeout(10000),
            }),
          );
          expect(reconnect.status).toBe(200);
          const resumed = yield* Effect.promise(() => reconnect.text());
          const resumedIds = [...resumed.matchAll(/^id: (.+)$/gm)].map((match) => match[1]!);
          expect(resumedIds).toEqual(ids.slice(1));
          expect(new Set(resumedIds).size).toBe(resumedIds.length);
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
      ),
    );
  } finally {
    if (previous === undefined) delete process.env.CONTEXT_AGENT_GOAL_WORKER;
    else process.env.CONTEXT_AGENT_GOAL_WORKER = previous;
  }
}, 30000);
