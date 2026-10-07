import { Cause, Deferred, Effect, Fiber } from "effect";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { Database } from "../src/db/database.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { selectTestModel } from "./support/provider.ts";
import { testRuntime } from "./support/runtime.ts";

/** Baseline using the real AgentChat layer; this does NOT cross a Goal worker process boundary. */
it.live("a real turn has one live admission, persisted nodes and same-owner SSE replay", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const run = Effect.runPromiseWith(yield* Effect.context());
    yield* Effect.addFinalizer(() => Deferred.succeed(gate, undefined));
    const context = yield* Effect.tryPromise({
      try: () => testRuntime({ testProvider: { delayedTurnGate: run(Deferred.await(gate)) } }),
      catch: (cause) => new Cause.UnknownError(cause),
    });
    yield* Effect.provideContext(selectTestModel(), yield* context.runtime.contextEffect);
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
    const services = yield* context.runtime.contextEffect;
    const handle = (incoming: Request) =>
      Effect.provideContext(
        Effect.flatMap(AgentChat, (agent) => agent.handle(incoming, context.session.id)),
        services,
      );
    const response = yield* handle(request());
    expect(response.status).toBe(200);
    const reading = yield* Effect.forkScoped(
      Effect.tryPromise({
        try: () => response.text(),
        catch: (cause) => new Cause.UnknownError(cause),
      }),
      { startImmediately: true },
    );
    try {
      const duplicate = yield* handle(request());
      expect(duplicate.status).toBe(409);
      expect(
        yield* Effect.tryPromise({
          try: () => duplicate.json(),
          catch: (cause) => new Cause.UnknownError(cause),
        }),
      ).toMatchObject({ error: "run_in_progress", runId });
    } finally {
      yield* Deferred.succeed(gate, undefined);
    }
    expect(yield* Fiber.join(reading)).toContain("Hello from fast-1");
    const { db, nodes } = yield* Effect.provideContext(
      Effect.all({ db: Database, nodes: Nodes }),
      yield* context.runtime.contextEffect,
    );
    expect(nodes.session(context.session.id).filter((node) => node.kind === "user")).toHaveLength(
      1,
    );
    expect(
      nodes.session(context.session.id).filter((node) => node.kind === "assistant"),
    ).toHaveLength(1);
    expect(
      db.sqlite.prepare("SELECT count(*) AS count FROM chat_runs WHERE run_id = ?").get(runId),
    ).toEqual({ count: 1 });
    const replay = yield* Effect.provideContext(
      Effect.flatMap(AgentChat, (agent) =>
        agent.hydrate(
          new Request(`http://localhost/api/chat?runId=${runId}&offset=-1`),
          context.session.id,
        ),
      ),
      yield* context.runtime.contextEffect,
    );
    expect(replay.status).toBe(200);
    expect(
      yield* Effect.tryPromise({
        try: () => replay.text(),
        catch: (cause) => new Cause.UnknownError(cause),
      }),
    ).toContain("Hello from fast-1");
    const otherSession = yield* Effect.provideContext(
      Effect.flatMap(Sessions, (sessions) => sessions.create(context.project.id)),
      yield* context.runtime.contextEffect,
    );
    const wrongSessionPost = yield* Effect.provideContext(
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
      yield* context.runtime.contextEffect,
    );
    expect(wrongSessionPost.status).toBe(409);
    expect(
      yield* Effect.tryPromise({
        try: () => wrongSessionPost.json(),
        catch: (cause) => new Cause.UnknownError(cause),
      }),
    ).toMatchObject({ error: "run_id_conflict" });
    expect(nodes.session(otherSession.id)).toHaveLength(0);
    const wrongSessionReplay = yield* Effect.provideContext(
      Effect.flatMap(AgentChat, (agent) =>
        agent.hydrate(
          new Request(`http://localhost/api/chat?runId=${runId}&offset=-1`),
          otherSession.id,
        ),
      ),
      yield* context.runtime.contextEffect,
    );
    expect(wrongSessionReplay.status).toBe(404);
    // The checked ?runId must also be the run named by Last-Event-ID. Otherwise an
    // authorized local run can be used to replay another session's memory log.
    const otherRunId = "other-owned-run";
    const otherRun = yield* Effect.provideContext(
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
      yield* context.runtime.contextEffect,
    );
    expect(otherRun.status).toBe(200);
    yield* Effect.tryPromise({
      try: () => otherRun.text(),
      catch: (cause) => new Cause.UnknownError(cause),
    });
    const swappedOffset = yield* Effect.provideContext(
      Effect.flatMap(AgentChat, (agent) =>
        agent.hydrate(
          new Request(`http://localhost/api/chat?runId=${otherRunId}`, {
            headers: { "Last-Event-ID": `memory:v1:${encodeURIComponent(runId)}:1` },
          }),
          otherSession.id,
        ),
      ),
      yield* context.runtime.contextEffect,
    );
    expect(swappedOffset.status).toBe(400);
    const swappedHeader = yield* Effect.provideContext(
      Effect.flatMap(AgentChat, (agent) =>
        agent.hydrate(
          new Request(`http://localhost/api/chat?runId=${otherRunId}&offset=-1`, {
            headers: { "X-Run-Id": runId },
          }),
          otherSession.id,
        ),
      ),
      yield* context.runtime.contextEffect,
    );
    expect(swappedHeader.status).toBe(400);
    const ownOffset = yield* Effect.provideContext(
      Effect.flatMap(AgentChat, (agent) =>
        agent.hydrate(
          new Request(`http://localhost/api/chat?runId=${otherRunId}`, {
            headers: { "Last-Event-ID": `memory:v1:${encodeURIComponent(otherRunId)}:1` },
          }),
          otherSession.id,
        ),
      ),
      yield* context.runtime.contextEffect,
    );
    expect(ownOffset.status).toBe(200);
    expect(
      yield* Effect.tryPromise({
        try: () => ownOffset.text(),
        catch: (cause) => new Cause.UnknownError(cause),
      }),
    ).toContain("Hello from fast-");

    // Recreate the whole service layer over the same isolated DB, not just the SSE adapter.
    // This proves persisted evidence survives owner restart; it does not prove SSE replay after
    // a different OS process starts (the current stream adapter keeps an in-process log).
    const reopened = yield* Effect.tryPromise({
      try: () => context.reopen(),
      catch: (cause) => new Cause.UnknownError(cause),
    });
    const persisted = yield* Effect.provideContext(
      Effect.all({ db: Database, nodes: Nodes }),
      yield* reopened.contextEffect,
    );
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
  }),
);
