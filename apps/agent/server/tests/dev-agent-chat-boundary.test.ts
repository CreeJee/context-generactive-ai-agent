import { selectTestModel } from "../../../../packages/memory-agent/tests/support/provider.ts";
import { isTruthy } from "../../app/truthy.ts";
import { Cause, Effect, Schema } from "effect";
import { RouterContextProvider } from "react-router";
import { SessionLeases, Sessions, Workflows } from "memory-agent";
import { expect } from "vite-plus/test";
import {
  TestEnv,
  testAgent,
  type AgentServices,
} from "../../../../packages/memory-agent/tests/support/test-env.ts";

const sdkCall = Effect.fn("devChatBoundaryTest.sdkCall")(function* <A>(
  operation: () => A | PromiseLike<A>,
) {
  return yield* Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: (cause) => new Cause.UnknownError(cause),
  });
});
const callRoute = Effect.fn("devChatBoundaryTest.callRoute")(function* (
  handler: (args: { request: Request }) => Promise<Response>,
  args: { request: Request },
) {
  return yield* sdkCall(() => handler(args));
});

import { makeChatHandlers } from "../../app/.server/chat-handlers";
import { sqlAll, sqlGet } from "../../../../packages/memory-agent/tests/support/sql.ts";

const request = Effect.fn("devChatBoundaryTest.request")(function* (
  sessionId: string,
  runId: string,
  holder: string | null,
  origin: string,
) {
  const headers = new Headers({ "Content-Type": "application/json", Origin: origin });
  if (isTruthy(holder)) headers.set("X-Session-Holder", holder);
  return new Request(`http://localhost/api/chat?session=${sessionId}`, {
    method: "POST",
    headers,
    body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
      threadId: sessionId,
      runId,
      messages: [{ id: "m1", role: "user", content: "dev session lease boundary" }],
      tools: [],
      context: [],
    }),
  });
});
const routeArgs = (request: Request) => ({
  request,
  params: {},
  context: new RouterContextProvider(),
  url: new URL(request.url),
  pattern: "/api/chat",
});

testAgent({ testProvider: {} })("dev chat route boundary", (it) => {
  it.effect(
    "chat route handlers map a leased local session to its bound Goal/run without cross-site writes",
    () =>
      Effect.gen(function* () {
        const context = yield* TestEnv;
        const services = yield* Effect.context<AgentServices>();
        const { action, loader } = makeChatHandlers({
          runPromise: Effect.runPromiseWith(services),
        });
        yield* Effect.provideContext(selectTestModel(), services);
        const { leases, workflows } = yield* Effect.provideContext(
          Effect.all({ leases: SessionLeases, workflows: Workflows }),
          services,
        );
        yield* Effect.provideContext(
          workflows.updateGoal(context.session.id, {
            statement: "Preserve the local leased session boundary",
            outcomes: ["No unauthorized page or origin creates a run"],
            constraints: [],
            nonGoals: [],
            assumptions: [],
            openQuestions: [],
            status: "active",
          }),
          services,
        );
        expect(leases.claim(context.session.id, "owning-page")).toEqual({ claimed: true });
        const foreign = yield* callRoute(
          action,
          routeArgs(
            yield* request(context.session.id, "foreign", "owning-page", "http://evil.example"),
          ),
        );
        expect(foreign.status).toBe(403);
        const nonHolder = yield* callRoute(
          action,
          routeArgs(
            yield* request(context.session.id, "non-holder", "other-page", "http://localhost"),
          ),
        );
        expect(nonHolder.status).toBe(423);
        const missingHolder = yield* callRoute(
          action,
          routeArgs(yield* request(context.session.id, "missing-holder", null, "http://localhost")),
        );
        expect(missingHolder.status).toBe(423);
        expect(context.provider!.adapter.invocations).toHaveLength(0);
        for (const table of [
          "workflow_run_bindings",
          "workflow_worker_dispatches",
          "chat_runs",
          "nodes",
        ])
          expect(yield* sqlGet(`SELECT count(*) AS n FROM ${table}`)).toEqual({ n: 0 });
        const valid = yield* callRoute(
          action,
          routeArgs(
            yield* request(
              context.session.id,
              "owned-local-run",
              "owning-page",
              "http://localhost",
            ),
          ),
        );
        expect(valid.status).toBe(200);
        expect(yield* sdkCall(() => valid.text())).toContain("Hello from fast-1");
        expect(
          yield* sqlGet(
            `SELECT b.session_id, b.goal_instance_id = i.goal_instance_id AS current_goal
      FROM workflow_run_bindings b JOIN workflow_goal_identities i ON i.session_id = b.session_id
      WHERE b.run_id = ?`,
            "owned-local-run",
          ),
        ).toEqual({ session_id: context.session.id, current_goal: 1 });
        const hydrate = yield* callRoute(
          loader,
          routeArgs(
            new Request(
              `http://localhost/api/chat?session=${context.session.id}&threadId=${context.session.id}`,
            ),
          ),
        );
        expect(hydrate.status).toBe(200);
        expect(yield* sdkCall(() => hydrate.text())).toContain("Hello from fast-1");
        // Leases enforce local page ownership, not login identity. The route currently
        // still permits a same-origin script when a session has no live page lease.
        leases.release(context.session.id, "owning-page");
        const unleased = yield* callRoute(
          action,
          routeArgs(
            yield* request(context.session.id, "unleased-local-run", null, "http://localhost"),
          ),
        );
        expect(unleased.status).toBe(200);
        yield* sdkCall(() => unleased.text());
      }),
    20000,
  );
});

testAgent({ testProvider: {} })("dev chat route boundary", (it) => {
  it.effect(
    "cross-site metadata cannot borrow a valid holder or create durable Goal effects",
    () =>
      Effect.gen(function* () {
        const context = yield* TestEnv;
        const services = yield* Effect.context<AgentServices>();
        const { action } = makeChatHandlers({
          runPromise: Effect.runPromiseWith(services),
        });
        yield* Effect.provideContext(selectTestModel(), services);
        const { leases, workflows } = yield* Effect.provideContext(
          Effect.all({ leases: SessionLeases, workflows: Workflows }),
          services,
        );
        yield* Effect.provideContext(
          workflows.updateGoal(context.session.id, {
            statement: "Reject foreign browser requests before any Goal execution",
            outcomes: ["Origin and fetch metadata remain independent of page ownership"],
            constraints: [],
            nonGoals: [],
            assumptions: [],
            openQuestions: [],
            status: "active",
          }),
          services,
        );
        expect(leases.claim(context.session.id, "valid-page")).toEqual({ claimed: true });
        const tables = [
          "nodes",
          "chat_runs",
          "workflow_run_bindings",
          "workflow_worker_dispatches",
          "owner_rpc_operations",
          "workflow_run_events",
          "workflow_goal_worker_generations",
          "session_workflows",
          "workflow_state_revisions",
          "workflow_goal_identities",
        ];
        const snapshot = Effect.forEach(tables, (table) =>
          sqlAll(`SELECT * FROM ${table} ORDER BY rowid`),
        );
        const before = yield* snapshot;
        const cases = [
          { site: "cross-site", origin: "http://localhost" },
          { site: "same-site", origin: "http://localhost" },
          { site: "same-origin", origin: "null" },
          { site: "none", origin: "http://evil.example" },
        ];
        for (const [index, headers] of cases.entries()) {
          const value = yield* request(
            context.session.id,
            `foreign-metadata-${index}`,
            "valid-page",
            headers.origin,
          );
          value.headers.set("Sec-Fetch-Site", headers.site);
          expect((yield* callRoute(action, routeArgs(value))).status).toBe(403);
        }
        expect(context.provider!.adapter.invocations).toHaveLength(0);
        expect(yield* snapshot).toEqual(before);
      }),
    20000,
  );
});

testAgent({ testProvider: {} })("dev chat route boundary", (it) => {
  it.effect(
    "headerless local requests preserve lease and cross-session run authority",
    () =>
      Effect.gen(function* () {
        const context = yield* TestEnv;
        const services = yield* Effect.context<AgentServices>();
        const { action } = makeChatHandlers({
          runPromise: Effect.runPromiseWith(services),
        });
        yield* Effect.provideContext(selectTestModel(), services);
        const { leases, workflows, sessions } = yield* Effect.provideContext(
          Effect.all({ leases: SessionLeases, workflows: Workflows, sessions: Sessions }),
          services,
        );
        const second = yield* Effect.provideContext(sessions.create(context.project.id), services);
        for (const sessionId of [context.session.id, second.id])
          yield* Effect.provideContext(
            workflows.updateGoal(sessionId, {
              statement: "Keep local session authority distinct",
              outcomes: ["No cross-session run reuse"],
              constraints: [],
              nonGoals: [],
              assumptions: [],
              openQuestions: [],
              status: "active",
            }),
            services,
          );
        const native = Effect.fn("devChatBoundaryTest.nativeRequest")(function* (
          sessionId: string,
          runId: string,
          holder: string | null,
        ) {
          const value = yield* request(sessionId, runId, holder, "http://localhost");
          value.headers.delete("Origin");
          return routeArgs(value);
        });
        const original = yield* callRoute(
          action,
          yield* native(context.session.id, "session-a-run", null),
        );
        expect(original.status).toBe(200);
        expect(yield* sdkCall(() => original.text())).toContain("Hello from fast-1");
        expect(leases.claim(second.id, "page-b")).toEqual({ claimed: true });
        const tables = [
          "nodes",
          "chat_runs",
          "workflow_run_bindings",
          "workflow_worker_dispatches",
          "owner_rpc_operations",
          "workflow_run_events",
          "workflow_goal_worker_generations",
        ];
        const snapshot = Effect.forEach(tables, (table) =>
          sqlAll(`SELECT * FROM ${table} ORDER BY rowid`),
        );
        const before = yield* snapshot;
        const calls = context.provider!.adapter.invocations.length;
        expect(
          (yield* callRoute(action, yield* native(second.id, "missing-holder", null))).status,
        ).toBe(423);
        expect(
          (yield* callRoute(action, yield* native(second.id, "wrong-holder", "page-a"))).status,
        ).toBe(423);
        expect(
          (yield* callRoute(action, yield* native(second.id, "session-a-run", "page-b"))).status,
        ).toBe(409);
        expect(context.provider!.adapter.invocations).toHaveLength(calls);
        expect(yield* snapshot).toEqual(before);
        leases.release(second.id, "page-b");
        const allowed = yield* callRoute(action, yield* native(second.id, "session-b-run", null));
        expect(
          allowed.status,
          allowed.status === 200 ? "" : yield* sdkCall(() => allowed.text()),
        ).toBe(200);
        yield* sdkCall(() => allowed.text());
        expect(
          yield* sqlGet(
            "SELECT session_id FROM workflow_run_bindings WHERE run_id = ?",
            "session-b-run",
          ),
        ).toEqual({ session_id: second.id });
      }),
    20000,
  );
});
