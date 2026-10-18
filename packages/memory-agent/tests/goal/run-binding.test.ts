import { Cause, Effect, Fiber, Schema } from "effect";
import { expect, vi } from "vite-plus/test";
import { AgentChat } from "../../src/agent/chat.ts";
import { decodeFullLoopValue } from "../../src/agent/full-loop-codec.ts";
import * as workerPreflight from "../../src/agent/full-loop-preflight.ts";
import { ChatState } from "../../src/chat-state/chat-state.ts";
import { Database } from "../../src/db/database.ts";
import { Nodes } from "../../src/memory/nodes.ts";
import { workflowRunBindings } from "../../src/workflow/run-bindings.ts";
import { workflowRunEvents } from "../../src/workflow/run-events.ts";
import { Workflows } from "../../src/workflow/workflow.ts";
import { selectTestModel, turnGate } from "../support/provider.ts";
import { TestEnv, freshSession, testAgent } from "../support/test-env.ts";

const goal = {
  statement: "Run safely in worker",
  outcomes: ["One durable turn"],
  constraints: [],
  nonGoals: [],
  assumptions: [],
  openQuestions: [],
  status: "active" as const,
};

const sdkCall = <A>(call: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(call()),
    catch: (cause) => new Cause.UnknownError(cause),
  });

/** A fresh session with an active Goal and the test model selected. Run IDs carry the session. */
const withGoal = Effect.gen(function* () {
  yield* selectTestModel();
  const session = yield* freshSession;
  yield* (yield* Workflows).updateGoal(session, goal);
  return session;
});

const chatRequest = Effect.fnUntraced(function* (
  session: string,
  runId: string,
  content = "hello",
  messageId = "m1",
) {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
      threadId: session,
      runId,
      messages: [{ id: messageId, role: "user", content }],
      tools: [],
      context: [],
    }),
  });
});

const post = Effect.fnUntraced(function* (
  session: string,
  runId: string,
  content?: string,
  messageId?: string,
) {
  return yield* (yield* AgentChat).handle(
    yield* chatRequest(session, runId, content, messageId),
    session,
  );
});

const hydrate = Effect.fnUntraced(function* (
  session: string,
  query: string,
  headers: Record<string, string> = {},
) {
  return yield* (yield* AgentChat).hydrate(
    new Request(`http://localhost/api/chat?${query}`, { headers }),
    session,
  );
});

const count = (db: Database["Service"], sql: string, ...params: string[]) =>
  db.sqlite.prepare(`SELECT count(*) AS n FROM ${sql}`).get(...params);

const latestRevision = (db: Database["Service"], session: string) =>
  Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.Finite, goal_instance_id: Schema.String }))(
    db.sqlite
      .prepare(
        "SELECT id, goal_instance_id FROM workflow_state_revisions WHERE session_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(session),
  );

const Receipt = Schema.Struct({ fingerprint: Schema.String, status: Schema.String });
const Frame = Schema.fromJsonString(
  Schema.Struct({ operation: Schema.String, input: Schema.Json }),
);
const MiddlewareInput = Schema.Struct({ index: Schema.Finite, hook: Schema.String });

/** Owner ledger receipts of middleware hooks, named by the worker's middleware order. */
const middlewareHooks = Effect.fnUntraced(function* (
  db: Database["Service"],
  runId: string,
  middlewareNames: readonly string[],
) {
  const receipts = yield* Schema.decodeUnknownEffect(Schema.Array(Receipt))(
    db.sqlite
      .prepare("SELECT fingerprint, status FROM owner_rpc_operations WHERE run_id = ?")
      .all(runId),
  );
  // The ledger persists canonical {operation,input} in fingerprint, not input_json.
  const hooks = yield* Effect.forEach(
    receipts,
    Effect.fnUntraced(function* (receipt) {
      const frame = yield* Schema.decodeEffect(Frame)(receipt.fingerprint);
      if (frame.operation !== "middleware") return [];
      const input = yield* Schema.decodeUnknownEffect(MiddlewareInput)(
        decodeFullLoopValue(frame.input),
      );
      return [{ name: middlewareNames[input.index], hook: input.hook, status: receipt.status }];
    }),
  );
  return hooks.flat();
});

/** Replace ChatState's middleware for this test only. */
const extendMiddleware = Effect.fnUntraced(function* (
  extra: ReturnType<ChatState["Service"]["middleware"]>[number],
) {
  const state = yield* ChatState;
  const original = state.middleware.bind(state);
  vi.spyOn(state, "middleware").mockImplementation(() => [...original(), extra]);
  yield* Effect.addFinalizer(() => Effect.sync(() => vi.restoreAllMocks()));
});

type Refusal = "unresolved-bound-run" | "foreign-session" | "changed-goal";

/**
 * Pre-bind a run directly through the owner, then name the chat request that admission must
 * refuse before persisting anything.
 */
const refusedRequest = Effect.fnUntraced(function* (refusal: Refusal, session: string) {
  const db = yield* Database;
  const reserved = `${session}:reserved`;
  const { id } = yield* latestRevision(db, session);
  expect((yield* (yield* workflowRunBindings).bind(session, reserved, id)).status).toBe("bound");
  switch (refusal) {
    case "unresolved-bound-run":
      return { session, runId: `${session}:bypass` };
    case "foreign-session":
      return { session: yield* freshSession, runId: reserved };
    case "changed-goal":
      yield* (yield* Workflows).updateGoal(session, { ...goal, outcomes: ["New criterion"] });
      return { session, runId: reserved };
  }
});

// Only "slow" user turns wait for this gate, so it holds exactly the in-progress baseline run.
const slowTurn = turnGate();

testAgent({ testProvider: { delayedTurnGate: slowTurn.waitFor } })(
  "Goal chat run admission",
  (it) => {
    it.effect.each([false, true])("opt-in AgentChat full worker finalizer failure=%s", (fail) =>
      Effect.gen(function* () {
        const db = yield* Database;
        const session = yield* withGoal;
        const runId = `${session}:worker`;
        const failingCleanup = vi.fn(() => {
          throw new Error("injected owner finalizer failure");
        });
        if (fail)
          yield* extendMiddleware({
            name: "memory-agent/partial-answer",
            onFinish: failingCleanup,
          });
        let middlewareNames: readonly string[] = [];
        const preflight = workerPreflight.preflightFullLoopExecution;
        vi.spyOn(workerPreflight, "preflightFullLoopExecution").mockImplementation(
          (turn, capabilities) => {
            middlewareNames = capabilities.middleware.map((middleware) => middleware.name ?? "");
            return preflight(turn, capabilities);
          },
        );
        yield* Effect.addFinalizer(() => Effect.sync(() => vi.restoreAllMocks()));
        const response = yield* post(session, runId);
        expect(response.status).toBe(200);
        const body = yield* sdkCall(() => response.text());
        expect(body).toContain("Hello from fast-1");
        if (fail) {
          expect(failingCleanup).toHaveBeenCalledTimes(1);
          expect(body.match(/"type":"RUN_ERROR"/g)).toHaveLength(1);
          expect(body).not.toContain("injected owner finalizer failure");
        } else {
          expect(body).not.toContain("RUN_ERROR");
          const hooks = yield* middlewareHooks(db, runId, middlewareNames);
          for (const name of ["memory-agent/subagents", "memory-agent/promoted-memory-use"]) {
            expect(
              hooks.filter((entry) => entry.name === name && entry.hook === "onFinish"),
            ).toEqual([{ name, hook: "onFinish", status: "succeeded" }]);
          }
        }
        expect(count(db, "nodes WHERE session_id = ? AND kind = 'assistant'", session)).toEqual({
          n: fail ? 0 : 1,
        });
        expect(
          count(db, "owner_rpc_operations WHERE run_id = ? AND status = 'pending'", runId),
        ).toEqual({ n: 0 });
        expect(
          Number(count(db, "owner_rpc_operations WHERE run_id = ?", runId)?.n),
        ).toBeGreaterThan(0);
        expect(
          db.sqlite.prepare("SELECT status FROM chat_runs WHERE run_id = ?").get(runId),
        ).toEqual({ status: fail ? "failed" : "completed" });
        const execution = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ status: Schema.String, result_json: Schema.String }),
        )(
          db.sqlite
            .prepare(
              "SELECT status, result_json FROM owner_workflow_executions WHERE json_extract(payload_json, '$.identity.runId') = ?",
            )
            .get(runId),
        );
        expect(execution.status).toBe("completed");
        expect(execution.result_json).toContain(fail ? "Failure" : "Success");
        if (fail) expect(execution.result_json).toContain("SideEffectUncertain");
        expect(count(db, "workflow_run_bindings WHERE run_id = ?", runId)).toEqual({ n: 1 });
        expect(count(db, "workflow_worker_dispatches WHERE run_id = ?", runId)).toEqual({ n: 1 });
        expect((yield* post(session, runId)).status).toBe(409);
        expect(count(db, "nodes WHERE session_id = ? AND kind = 'user'", session)).toEqual({
          n: 1,
        });
      }),
    );

    it.effect("unsupported opt-in worker preflight creates neither binding nor user node", () =>
      Effect.gen(function* () {
        const db = yield* Database;
        const session = yield* withGoal;
        // A member the worker cannot carry, beyond what ChatState's own middleware declares.
        const unsupported = { name: "unsupported-preflight", unsupportedMember: true };
        yield* extendMiddleware(unsupported);
        const response = yield* post(session, `${session}:unsupported`);
        expect(response.status).toBe(409);
        expect(yield* sdkCall(() => response.json())).toEqual({
          error: "unsupported_worker_capabilities",
          detail: "Unsupported worker middleware member: unsupportedMember",
        });
        expect(count(db, "workflow_run_bindings WHERE session_id = ?", session)).toEqual({ n: 0 });
        expect(count(db, "nodes WHERE session_id = ?", session)).toEqual({ n: 0 });
      }),
    );

    it.effect("new Goal turns automatically acquire a durable worker binding", () =>
      Effect.gen(function* () {
        const db = yield* Database;
        const session = yield* withGoal;
        for (const runId of [`${session}:automatic`, `${session}:another-automatic`]) {
          const response = yield* post(session, runId);
          expect(response.status).toBe(200);
          expect(yield* sdkCall(() => response.text())).toContain("Hello from fast-1");
          expect(
            db.sqlite.prepare("SELECT status FROM chat_runs WHERE run_id = ?").get(runId),
          ).toEqual({ status: "completed" });
        }
        expect(count(db, "nodes WHERE session_id = ? AND kind = 'user'", session)).toEqual({
          n: 2,
        });
        expect(count(db, "workflow_run_bindings WHERE session_id = ?", session)).toEqual({ n: 2 });
        expect(count(db, "chat_runs WHERE thread_id = ?", session)).toEqual({ n: 2 });
      }),
    );

    it.effect.each([
      { refusal: "unresolved-bound-run", error: "run_outcome_uncertain" },
      { refusal: "foreign-session", error: "run_id_conflict" },
      { refusal: "changed-goal", error: "workflow_changed" },
    ] as const)("admission refuses $refusal before persisting a user turn", ({ refusal, error }) =>
      Effect.gen(function* () {
        const db = yield* Database;
        const target = yield* refusedRequest(refusal, yield* withGoal);
        const response = yield* post(target.session, target.runId);
        expect(response.status).toBe(409);
        expect(yield* sdkCall(() => response.json())).toEqual({ error });
        expect(count(db, "nodes WHERE session_id = ?", target.session)).toEqual({ n: 0 });
        expect(count(db, "chat_runs WHERE run_id = ?", target.runId)).toEqual({ n: 0 });
      }),
    );

    it.effect("the user sees a run with an unknown outcome and continues past it", () =>
      Effect.gen(function* () {
        const chat = yield* AgentChat;
        const target = yield* refusedRequest("unresolved-bound-run", yield* withGoal);
        const reserved = `${target.session}:reserved`;
        const state = yield* chat.status(target.session, null);
        expect(yield* sdkCall(() => state.json())).toMatchObject({
          uncertainRuns: [{ runId: reserved, tools: [] }],
        });
        expect((yield* post(target.session, target.runId)).status).toBe(409);

        const stale = yield* chat.continuePastUncertain(target.session, null, { runIds: [] });
        expect(yield* sdkCall(() => stale.json())).toEqual({ error: "uncertain_runs_changed" });
        const continued = yield* chat.continuePastUncertain(target.session, null, {
          runIds: [reserved],
        });
        expect(continued.status).toBe(200);
        const db = yield* Database;
        const { id } = yield* latestRevision(db, target.session);
        expect(
          yield* (yield* workflowRunBindings).preview(target.session, target.runId, id),
        ).toMatchObject({
          status: "bound",
        });
      }),
    );

    it.effect("a live run has one admission and replays only to its own session and run", () =>
      Effect.gen(function* () {
        const nodes = yield* Nodes;
        yield* selectTestModel();
        const session = yield* freshSession;
        const runId = `${session}:baseline`;
        yield* Effect.addFinalizer(() => Effect.sync(slowTurn.release));
        const response = yield* post(session, runId, "slow");
        expect(response.status).toBe(200);
        const reading = yield* Effect.forkScoped(
          sdkCall(() => response.text()),
          { startImmediately: true },
        );
        const duplicate = yield* post(session, runId, "slow");
        expect(duplicate.status).toBe(409);
        expect(yield* sdkCall(() => duplicate.json())).toMatchObject({
          error: "run_in_progress",
          runId,
        });
        slowTurn.release();
        expect(yield* Fiber.join(reading)).toContain("done");
        const kinds = (id: string) =>
          Effect.map(nodes.session(id), (session) => session.map((node) => node.kind));
        expect((yield* kinds(session)).filter((kind) => kind === "user")).toHaveLength(1);
        expect((yield* kinds(session)).filter((kind) => kind === "assistant")).toHaveLength(1);
        expect(count(yield* Database, "chat_runs WHERE run_id = ?", runId)).toEqual({ n: 1 });
        const replay = yield* hydrate(session, `runId=${runId}&offset=-1`);
        expect(replay.status).toBe(200);
        expect(yield* sdkCall(() => replay.text())).toContain("done");

        const other = yield* freshSession;
        const wrongSessionPost = yield* post(other, runId, "must not persist", "other-m1");
        expect(wrongSessionPost.status).toBe(409);
        expect(yield* sdkCall(() => wrongSessionPost.json())).toMatchObject({
          error: "run_id_conflict",
        });
        expect(yield* nodes.session(other)).toHaveLength(0);
        expect((yield* hydrate(other, `runId=${runId}&offset=-1`)).status).toBe(404);
        // The checked ?runId must also be the run named by Last-Event-ID or X-Run-Id. Otherwise an
        // authorized local run can be used to replay another session's memory log.
        const otherRunId = `${other}:owned`;
        const otherRun = yield* post(other, otherRunId, "private", "other-m2");
        expect(otherRun.status).toBe(200);
        yield* sdkCall(() => otherRun.text());
        const memoryOffset = (id: string) => `memory:v1:${encodeURIComponent(id)}:1`;
        expect(
          (yield* hydrate(other, `runId=${otherRunId}`, { "Last-Event-ID": memoryOffset(runId) }))
            .status,
        ).toBe(400);
        expect(
          (yield* hydrate(other, `runId=${otherRunId}&offset=-1`, { "X-Run-Id": runId })).status,
        ).toBe(400);
        const ownOffset = yield* hydrate(other, `runId=${otherRunId}`, {
          "Last-Event-ID": memoryOffset(otherRunId),
        });
        expect(ownOffset.status).toBe(200);
        expect(yield* sdkCall(() => ownOffset.text())).toContain("Hello from fast-1");
      }),
    );
  },
);

// Reopening replaces the agent, so this block reads services through `env.use` only.
testAgent({ testProvider: {} })("Goal chat run binding across reopen", (it) => {
  it.effect(
    "a real AgentChat turn keeps its automatically bound Goal version after the owner reopens",
    () =>
      Effect.gen(function* () {
        const env = yield* TestEnv;
        const session = yield* env.use(withGoal);
        const revision = yield* latestRevision(yield* env.use(Database), session);
        const runId = `${session}:bound`;
        const response = yield* env.use(post(session, runId));
        expect(response.status).toBe(200);
        const delivered = yield* sdkCall(() => response.text());
        expect(delivered).toContain("Hello from fast-1");
        const offsets = [...delivered.matchAll(/^id: (.+)$/gm)].map((match) => match[1]!);
        expect(offsets.length).toBeGreaterThan(1);
        expect(offsets.every((offset) => offset.startsWith("sdk-stream:v1:"))).toBe(true);
        const firstOffset = offsets[0]!;
        const replayExpected = delivered.slice(delivered.indexOf("\n\n") + 2);

        // Recreate the whole agent over the same storage: persisted evidence survives an owner
        // restart. This does not cover SSE replay from a different OS process.
        yield* env.reopen;
        const fromFirst = { "Last-Event-ID": firstOffset };
        const replay = yield* env.use(hydrate(session, `runId=${runId}`, fromFirst));
        expect(replay.status).toBe(200);
        expect(yield* sdkCall(() => replay.text())).toBe(replayExpected);
        for (const badOffset of [
          "memory:v1:wrong:1",
          "sdk-stream:v1:wrong:1",
          `sdk-stream:v1:${runId}:99999999`,
          "now",
        ]) {
          const denied = yield* env.use(
            hydrate(session, `runId=${runId}`, { "Last-Event-ID": badOffset }),
          );
          expect(denied.status).toBe(400);
        }
        const other = yield* env.use(freshSession);
        expect((yield* env.use(hydrate(other, `runId=${runId}`, fromFirst))).status).toBe(404);

        const persisted = yield* env.use(Database);
        const nodes = yield* env.use(Nodes);
        expect(
          persisted.sqlite
            .prepare("SELECT thread_id, status FROM chat_runs WHERE run_id = ?")
            .get(runId),
        ).toEqual({ thread_id: session, status: "completed" });
        const kinds = (yield* nodes.session(session)).map((node) => node.kind);
        expect(kinds.filter((kind) => kind === "user")).toHaveLength(1);
        expect(kinds.filter((kind) => kind === "assistant")).toHaveLength(1);
        const events = yield* env.use(workflowRunEvents);
        const receipts = yield* events.replay(session, runId);
        expect(receipts.length).toBeGreaterThan(0);
        expect(
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
            receipts.map((event) => event.payload),
          ),
        ).toContain("Hello from fast-1");
        expect(yield* events.replay(session, runId, receipts[0]!.cursor)).toEqual(
          receipts.slice(1),
        );
        expect(
          persisted.sqlite
            .prepare(
              "SELECT session_id, goal_instance_id, goal_version, workflow_revision_id FROM workflow_run_bindings WHERE run_id = ?",
            )
            .get(runId),
        ).toEqual({
          session_id: session,
          goal_instance_id: revision.goal_instance_id,
          goal_version: 1,
          workflow_revision_id: revision.id,
        });

        const before = count(persisted, "nodes WHERE session_id = ?", session);
        const duplicate = yield* env.use(post(session, runId, "do it again", "again"));
        expect(duplicate.status).toBe(409);
        expect(yield* sdkCall(() => duplicate.json())).toEqual({ error: "run_already_completed" });
        expect(count(persisted, "nodes WHERE session_id = ?", session)).toEqual(before);
        expect(yield* events.replay(session, runId)).toEqual(receipts);
        // Simulate restart recovery classifying an in-flight run as failed. The same ID must
        // not re-enter the model after an uncertain tool-side effect.
        persisted.sqlite
          .prepare("UPDATE chat_runs SET status = 'failed' WHERE run_id = ?")
          .run(runId);
        const failedRetry = yield* env.use(post(session, runId, "repeat uncertain work", "retry"));
        expect(failedRetry.status).toBe(409);
        expect(yield* sdkCall(() => failedRetry.json())).toEqual({
          error: "run_outcome_uncertain",
        });
        expect(count(persisted, "nodes WHERE session_id = ?", session)).toEqual(before);
      }),
  );
});
