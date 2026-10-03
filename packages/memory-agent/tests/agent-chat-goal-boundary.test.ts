import { Effect } from "effect";
import { expect, test } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { Database } from "../src/db/database.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { turnGate } from "./support/provider.ts";
import { testRuntime } from "./support/runtime.ts";

/** Baseline using the real AgentChat layer; this does NOT cross a Goal worker process boundary. */
test("a real turn has one live admission, persisted nodes and same-owner SSE replay", async () => {
  const gate = turnGate();
  const context = await testRuntime({ testProvider: { delayedTurnGate: gate.waitFor } });
  await context.provider!.select(context.runtime);
  const runId = "goal-boundary-baseline";
  const request = () =>
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId: context.session.id,
        runId,
        messages: [{ id: "m1", role: "user", content: "hello" }],
        tools: [],
        context: [],
      }),
    });
  const handle = (incoming: Request) =>
    context.runtime.runPromise(
      Effect.flatMap(AgentChat, (agent) => agent.handle(incoming, context.session.id)),
    );
  const response = await handle(request());
  expect(response.status).toBe(200);
  const reading = response.text();
  try {
    const duplicate = await handle(request());
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ error: "run_in_progress", runId });
  } finally {
    gate.release();
  }
  expect(await reading).toContain("Hello from fast-1");
  const { db, nodes } = await context.runtime.runPromise(
    Effect.all({ db: Database, nodes: Nodes }),
  );
  expect(nodes.session(context.session.id).filter((node) => node.kind === "user")).toHaveLength(1);
  expect(
    nodes.session(context.session.id).filter((node) => node.kind === "assistant"),
  ).toHaveLength(1);
  expect(
    db.sqlite.prepare("SELECT count(*) AS count FROM chat_runs WHERE run_id = ?").get(runId),
  ).toEqual({ count: 1 });
  const replay = await context.runtime.runPromise(
    Effect.flatMap(AgentChat, (agent) =>
      agent.hydrate(
        new Request(`http://localhost/api/chat?runId=${runId}&offset=-1`),
        context.session.id,
      ),
    ),
  );
  expect(replay.status).toBe(200);
  expect(await replay.text()).toContain("Hello from fast-1");
  const otherSession = await context.runtime.runPromise(
    Effect.flatMap(Sessions, (sessions) => sessions.create(context.project.id)),
  );
  const wrongSessionPost = await context.runtime.runPromise(
    Effect.flatMap(AgentChat, (agent) =>
      agent.handle(
        new Request("http://localhost/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadId: otherSession.id,
            runId,
            messages: [{ id: "other-m1", role: "user", content: "must not persist" }],
            tools: [],
            context: [],
          }),
        }),
        otherSession.id,
      ),
    ),
  );
  expect(wrongSessionPost.status).toBe(409);
  expect(await wrongSessionPost.json()).toMatchObject({ error: "run_id_conflict" });
  expect(nodes.session(otherSession.id)).toHaveLength(0);
  const wrongSessionReplay = await context.runtime.runPromise(
    Effect.flatMap(AgentChat, (agent) =>
      agent.hydrate(
        new Request(`http://localhost/api/chat?runId=${runId}&offset=-1`),
        otherSession.id,
      ),
    ),
  );
  expect(wrongSessionReplay.status).toBe(404);
  // The checked ?runId must also be the run named by Last-Event-ID. Otherwise an
  // authorized local run can be used to replay another session's memory log.
  const otherRunId = "other-owned-run";
  const otherRun = await context.runtime.runPromise(
    Effect.flatMap(AgentChat, (agent) =>
      agent.handle(
        new Request("http://localhost/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadId: otherSession.id,
            runId: otherRunId,
            messages: [{ id: "other-m2", role: "user", content: "private" }],
            tools: [],
            context: [],
          }),
        }),
        otherSession.id,
      ),
    ),
  );
  expect(otherRun.status).toBe(200);
  await otherRun.text();
  const swappedOffset = await context.runtime.runPromise(
    Effect.flatMap(AgentChat, (agent) =>
      agent.hydrate(
        new Request(`http://localhost/api/chat?runId=${otherRunId}`, {
          headers: { "Last-Event-ID": `memory:v1:${encodeURIComponent(runId)}:1` },
        }),
        otherSession.id,
      ),
    ),
  );
  expect(swappedOffset.status).toBe(400);
  const swappedHeader = await context.runtime.runPromise(
    Effect.flatMap(AgentChat, (agent) =>
      agent.hydrate(
        new Request(`http://localhost/api/chat?runId=${otherRunId}&offset=-1`, {
          headers: { "X-Run-Id": runId },
        }),
        otherSession.id,
      ),
    ),
  );
  expect(swappedHeader.status).toBe(400);
  const ownOffset = await context.runtime.runPromise(
    Effect.flatMap(AgentChat, (agent) =>
      agent.hydrate(
        new Request(`http://localhost/api/chat?runId=${otherRunId}`, {
          headers: { "Last-Event-ID": `memory:v1:${encodeURIComponent(otherRunId)}:1` },
        }),
        otherSession.id,
      ),
    ),
  );
  expect(ownOffset.status).toBe(200);
  expect(await ownOffset.text()).toContain("Hello from fast-");

  // Recreate the whole service layer over the same isolated DB, not just the SSE adapter.
  // This proves persisted evidence survives owner restart; it does not prove SSE replay after
  // a different OS process starts (the current stream adapter keeps an in-process log).
  const reopened = await context.reopen();
  const persisted = await reopened.runPromise(Effect.all({ db: Database, nodes: Nodes }));
  expect(
    persisted.db.sqlite
      .prepare("SELECT count(*) AS count FROM chat_runs WHERE run_id = ?")
      .get(runId),
  ).toEqual({ count: 1 });
  expect(
    persisted.nodes.session(context.session.id).filter((node) => node.kind === "user"),
  ).toHaveLength(1);
  expect(
    persisted.nodes.session(context.session.id).filter((node) => node.kind === "assistant"),
  ).toHaveLength(1);
});
