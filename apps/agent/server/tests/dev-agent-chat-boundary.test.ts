import { Effect } from "effect";
import { RouterContextProvider } from "react-router";
import { Database, SessionLeases, Sessions, Workflows } from "memory-agent";
import { expect, test, vi } from "vite-plus/test";
import { testRuntime } from "../../../../packages/memory-agent/tests/support/runtime.ts";

type TestRuntime = Awaited<ReturnType<typeof testRuntime>>;
interface TestOwner {
  runtime: TestRuntime["runtime"] | null;
}
const owner = vi.hoisted(() => {
  const value: TestOwner = { runtime: null };
  return value;
});

// Exercise the real React Router API export without opening the user's default
// app storage. All Effect services still come from one real test owner runtime.
vi.mock("../../app/.server/agent", () => ({
  agent: {
    runPromise: (...args: Parameters<TestRuntime["runtime"]["runPromise"]>) => {
      if (!owner.runtime) throw new Error("Test owner is not initialized");
      return owner.runtime.runPromise(...args);
    },
  },
}));

import { action, loader } from "../../app/routes/api/chat";

const request = (sessionId: string, runId: string, holder: string | null, origin: string) => {
  const headers = new Headers({ "Content-Type": "application/json", Origin: origin });
  if (holder) headers.set("X-Session-Holder", holder);
  return new Request(`http://localhost/api/chat?session=${sessionId}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      threadId: sessionId,
      runId,
      messages: [{ id: "m1", role: "user", content: "dev session lease boundary" }],
      tools: [],
      context: [],
    }),
  });
};
const routeArgs = (request: Request) => ({
  request,
  params: {},
  context: new RouterContextProvider(),
  url: new URL(request.url),
  pattern: "/api/chat",
});

test("real chat route maps a leased local session to its bound Goal/run without cross-site writes", async () => {
  const previous = process.env.CONTEXT_AGENT_GOAL_WORKER;
  process.env.CONTEXT_AGENT_GOAL_WORKER = "1";
  try {
    const context = await testRuntime({ testProvider: {} });
    owner.runtime = context.runtime;
    await context.provider!.select(context.runtime);
    const { leases, workflows, db } = await context.runtime.runPromise(
      Effect.all({ leases: SessionLeases, workflows: Workflows, db: Database }),
    );
    await context.runtime.runPromise(
      workflows.updateGoal(context.session.id, {
        statement: "Preserve the local leased session boundary",
        outcomes: ["No unauthorized page or origin creates a run"],
        constraints: [],
        nonGoals: [],
        assumptions: [],
        openQuestions: [],
        status: "active",
      }),
    );
    expect(leases.claim(context.session.id, "owning-page")).toEqual({ claimed: true });
    const foreign = await action(
      routeArgs(request(context.session.id, "foreign", "owning-page", "http://evil.example")),
    );
    expect(foreign.status).toBe(403);
    const nonHolder = await action(
      routeArgs(request(context.session.id, "non-holder", "other-page", "http://localhost")),
    );
    expect(nonHolder.status).toBe(423);
    const missingHolder = await action(
      routeArgs(request(context.session.id, "missing-holder", null, "http://localhost")),
    );
    expect(missingHolder.status).toBe(423);
    expect(context.provider!.adapter.invocations).toHaveLength(0);
    for (const table of [
      "workflow_run_bindings",
      "workflow_worker_dispatches",
      "chat_runs",
      "nodes",
    ])
      expect(db.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    const valid = await action(
      routeArgs(request(context.session.id, "owned-local-run", "owning-page", "http://localhost")),
    );
    expect(valid.status).toBe(200);
    expect(await valid.text()).toContain("Hello from fast-1");
    expect(
      db.sqlite
        .prepare(`SELECT b.session_id, b.goal_instance_id = i.goal_instance_id AS current_goal
      FROM workflow_run_bindings b JOIN workflow_goal_identities i ON i.session_id = b.session_id
      WHERE b.run_id = ?`)
        .get("owned-local-run"),
    ).toEqual({ session_id: context.session.id, current_goal: 1 });
    const hydrate = await loader(
      routeArgs(
        new Request(
          `http://localhost/api/chat?session=${context.session.id}&threadId=${context.session.id}`,
        ),
      ),
    );
    expect(hydrate.status).toBe(200);
    expect(await hydrate.text()).toContain("Hello from fast-1");
    // Leases enforce local page ownership, not login identity. The route currently
    // still permits a same-origin script when a session has no live page lease.
    leases.release(context.session.id, "owning-page");
    const unleased = await action(
      routeArgs(request(context.session.id, "unleased-local-run", null, "http://localhost")),
    );
    expect(unleased.status).toBe(200);
    await unleased.text();
  } finally {
    owner.runtime = null;
    if (previous === undefined) delete process.env.CONTEXT_AGENT_GOAL_WORKER;
    else process.env.CONTEXT_AGENT_GOAL_WORKER = previous;
  }
}, 20000);

test("cross-site metadata cannot borrow a valid holder or create durable Goal effects", async () => {
  const previous = process.env.CONTEXT_AGENT_GOAL_WORKER;
  process.env.CONTEXT_AGENT_GOAL_WORKER = "1";
  try {
    const context = await testRuntime({ testProvider: {} });
    owner.runtime = context.runtime;
    await context.provider!.select(context.runtime);
    const { leases, workflows, db } = await context.runtime.runPromise(
      Effect.all({ leases: SessionLeases, workflows: Workflows, db: Database }),
    );
    await context.runtime.runPromise(
      workflows.updateGoal(context.session.id, {
        statement: "Reject foreign browser requests before any Goal execution",
        outcomes: ["Origin and fetch metadata remain independent of page ownership"],
        constraints: [],
        nonGoals: [],
        assumptions: [],
        openQuestions: [],
        status: "active",
      }),
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
    const before = tables.map((table) =>
      db.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    );
    const cases = [
      { site: "cross-site", origin: "http://localhost" },
      { site: "same-site", origin: "http://localhost" },
      { site: "same-origin", origin: "null" },
      { site: "none", origin: "http://evil.example" },
    ];
    for (const [index, headers] of cases.entries()) {
      const value = request(
        context.session.id,
        `foreign-metadata-${index}`,
        "valid-page",
        headers.origin,
      );
      value.headers.set("Sec-Fetch-Site", headers.site);
      expect((await action(routeArgs(value))).status).toBe(403);
    }
    expect(context.provider!.adapter.invocations).toHaveLength(0);
    expect(
      tables.map((table) => db.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
    ).toEqual(before);
  } finally {
    owner.runtime = null;
    if (previous === undefined) delete process.env.CONTEXT_AGENT_GOAL_WORKER;
    else process.env.CONTEXT_AGENT_GOAL_WORKER = previous;
  }
}, 20000);

test("headerless local requests preserve lease and cross-session run authority", async () => {
  const previous = process.env.CONTEXT_AGENT_GOAL_WORKER;
  process.env.CONTEXT_AGENT_GOAL_WORKER = "1";
  try {
    const context = await testRuntime({ testProvider: {} });
    owner.runtime = context.runtime;
    await context.provider!.select(context.runtime);
    const { leases, workflows, sessions, db } = await context.runtime.runPromise(
      Effect.all({ leases: SessionLeases, workflows: Workflows, sessions: Sessions, db: Database }),
    );
    const second = await context.runtime.runPromise(sessions.create(context.project.id));
    for (const sessionId of [context.session.id, second.id])
      await context.runtime.runPromise(
        workflows.updateGoal(sessionId, {
          statement: "Keep local session authority distinct",
          outcomes: ["No cross-session run reuse"],
          constraints: [],
          nonGoals: [],
          assumptions: [],
          openQuestions: [],
          status: "active",
        }),
      );
    const native = (sessionId: string, runId: string, holder: string | null) => {
      const value = request(sessionId, runId, holder, "http://localhost");
      value.headers.delete("Origin");
      return routeArgs(value);
    };
    const original = await action(native(context.session.id, "session-a-run", null));
    expect(original.status).toBe(200);
    expect(await original.text()).toContain("Hello from fast-1");
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
    const before = tables.map((table) =>
      db.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    );
    const calls = context.provider!.adapter.invocations.length;
    expect((await action(native(second.id, "missing-holder", null))).status).toBe(423);
    expect((await action(native(second.id, "wrong-holder", "page-a"))).status).toBe(423);
    expect((await action(native(second.id, "session-a-run", "page-b"))).status).toBe(409);
    expect(context.provider!.adapter.invocations).toHaveLength(calls);
    expect(
      tables.map((table) => db.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
    ).toEqual(before);
    leases.release(second.id, "page-b");
    const allowed = await action(native(second.id, "session-b-run", null));
    expect(allowed.status).toBe(200);
    await allowed.text();
    expect(
      db.sqlite
        .prepare("SELECT session_id FROM workflow_run_bindings WHERE run_id = ?")
        .get("session-b-run"),
    ).toEqual({ session_id: second.id });
  } finally {
    owner.runtime = null;
    if (previous === undefined) delete process.env.CONTEXT_AGENT_GOAL_WORKER;
    else process.env.CONTEXT_AGENT_GOAL_WORKER = previous;
  }
}, 20000);
