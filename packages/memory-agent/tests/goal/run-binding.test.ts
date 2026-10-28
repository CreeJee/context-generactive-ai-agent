import { Cause, Effect, Fiber, Schema, Stream } from "effect";
import { expect } from "vite-plus/test";
import { AgentChat } from "../../src/agent/chat.ts";
import { Nodes } from "../../src/memory/nodes.ts";
import { Admission, workflowRunBindings } from "../../src/workflow/run-bindings.ts";
import { workflowRunEvents } from "../../src/workflow/run-events.ts";
import { Workflows } from "../../src/workflow/workflow.ts";
import { chatApi } from "../support/chat-api.ts";
import { eventsOf, streamedText } from "../support/chat-client.ts";
import { selectTestModel, turnGate } from "../support/provider.ts";
import { TestEnv, freshSession, testAgent } from "../support/test-env.ts";
import { sqlGet, sqlRun } from "../support/sql.ts";

const goal = {
  statement: "Run safely",
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

/** Starts a run on the chat API: its stream of events, or the server's refusal. */
const post = Effect.fnUntraced(function* (
  session: string,
  runId: string,
  content = "hello",
  messageId = runId,
) {
  const api = yield* chatApi;
  return yield* api.run({
    params: { session },
    headers: {},
    payload: { runId, messages: [{ id: messageId, role: "user", content }] },
  });
});

/** Follows a run's events after `after`, or from the start, as a reload does. */
const join = Effect.fnUntraced(function* (session: string, run: string, after?: string) {
  const api = yield* chatApi;
  return yield* api.join({ params: { session, run }, query: { after } });
});

const count = (sql: string, ...params: string[]) =>
  sqlGet(`SELECT count(*) AS n FROM ${sql}`, ...params);

const latestRevision = (session: string) =>
  Effect.gen(function* () {
    return yield* Schema.decodeUnknownEffect(
      Schema.Struct({ id: Schema.Finite, goal_instance_id: Schema.String }),
    )(
      yield* sqlGet(
        "SELECT id, goal_instance_id FROM workflow_state_revisions WHERE session_id = ? ORDER BY id DESC LIMIT 1",
        session,
      ),
    );
  });

type Refusal = "unresolved-bound-run" | "foreign-session" | "changed-goal";

/**
 * Pre-bind a run directly through the owner, then name the chat request that admission must
 * refuse before persisting anything.
 */
const refusedRequest = Effect.fnUntraced(function* (refusal: Refusal, session: string) {
  const reserved = `${session}:reserved`;
  const { id } = yield* latestRevision(session);
  expect(
    Admission.$is("bound")(yield* (yield* workflowRunBindings).bind(session, reserved, id)),
  ).toBe(true);
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
    it.effect("new Goal turns automatically acquire a durable binding", () =>
      Effect.gen(function* () {
        const session = yield* withGoal;
        yield* Effect.forEach(
          [`${session}:automatic`, `${session}:another-automatic`],
          Effect.fnUntraced(function* (runId) {
            const events = yield* eventsOf(yield* post(session, runId));
            expect(streamedText(events)).toContain("Hello from fast-1");
            expect(yield* sqlGet("SELECT status FROM chat_runs WHERE run_id = ?", runId)).toEqual({
              status: "completed",
            });
          }),
          { discard: true },
        );
        expect(yield* count("nodes WHERE session_id = ? AND kind = 'user'", session)).toEqual({
          n: 2,
        });
        expect(yield* count("workflow_run_bindings WHERE session_id = ?", session)).toEqual({
          n: 2,
        });
        expect(yield* count("chat_runs WHERE thread_id = ?", session)).toEqual({ n: 2 });
      }),
    );

    it.effect.each([
      { refusal: "unresolved-bound-run", error: "run_outcome_uncertain" },
      { refusal: "foreign-session", error: "run_id_conflict" },
      { refusal: "changed-goal", error: "workflow_changed" },
    ] as const)("admission refuses $refusal before persisting a user turn", ({ refusal, error }) =>
      Effect.gen(function* () {
        const target = yield* refusedRequest(refusal, yield* withGoal);
        expect(yield* Effect.flip(post(target.session, target.runId))).toEqual({ error });
        expect(yield* count("nodes WHERE session_id = ?", target.session)).toEqual({ n: 0 });
        expect(yield* count("chat_runs WHERE run_id = ?", target.runId)).toEqual({ n: 0 });
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
        expect(yield* Effect.flip(post(target.session, target.runId))).toEqual({
          error: "run_outcome_uncertain",
        });

        const stale = yield* chat.continuePastUncertain(target.session, null, { runIds: [] });
        expect(yield* sdkCall(() => stale.json())).toEqual({ error: "uncertain_runs_changed" });
        const continued = yield* chat.continuePastUncertain(target.session, null, {
          runIds: [reserved],
        });
        expect(continued.status).toBe(200);
        const { id } = yield* latestRevision(target.session);
        expect(
          Admission.$is("bound")(
            yield* (yield* workflowRunBindings).preview(target.session, target.runId, id),
          ),
        ).toBe(true);
      }),
    );

    it.effect("a live run has one admission and replays only to its own session and run", () =>
      Effect.gen(function* () {
        const nodes = yield* Nodes;
        yield* selectTestModel();
        const session = yield* freshSession;
        const runId = `${session}:baseline`;
        yield* Effect.addFinalizer(() => Effect.sync(slowTurn.release));
        const reading = yield* Effect.forkScoped(eventsOf(yield* post(session, runId, "slow")), {
          startImmediately: true,
        });
        expect(yield* Effect.flip(post(session, runId, "slow", `${runId}:again`))).toEqual({
          error: "run_in_progress",
          runId,
        });
        slowTurn.release();
        expect(streamedText(yield* Fiber.join(reading))).toContain("done");
        const kinds = (id: string) =>
          Effect.map(nodes.session(id), (session) => session.map((node) => node.kind));
        expect((yield* kinds(session)).filter((kind) => kind === "user")).toHaveLength(1);
        expect((yield* kinds(session)).filter((kind) => kind === "assistant")).toHaveLength(1);
        expect(yield* count("chat_runs WHERE run_id = ?", runId)).toEqual({ n: 1 });
        expect(streamedText(yield* eventsOf(yield* join(session, runId)))).toContain("done");

        const other = yield* freshSession;
        expect(yield* Effect.flip(post(other, runId, "must not persist", "other-m1"))).toEqual({
          error: "run_id_conflict",
        });
        expect(yield* nodes.session(other)).toHaveLength(0);
        expect(yield* Effect.flip(join(other, runId))).toEqual({ error: "run_not_found" });
        // The place a join continues after must belong to the run it names. Otherwise an
        // authorized local run can be used to replay another session's memory log.
        const otherRunId = `${other}:owned`;
        yield* eventsOf(yield* post(other, otherRunId, "private", "other-m2"));
        const memoryOffset = (id: string) => `memory:v1:${encodeURIComponent(id)}:1`;
        expect(yield* Effect.flip(join(other, otherRunId, memoryOffset(runId)))).toEqual({
          error: "invalid_stream_offset",
        });
        const ownOffset = yield* eventsOf(yield* join(other, otherRunId, memoryOffset(otherRunId)));
        expect(streamedText(ownOffset)).toContain("Hello from fast-1");
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
        const revision = yield* latestRevision(session);
        const runId = `${session}:bound`;
        const delivered = yield* Stream.runCollect(yield* post(session, runId));
        expect(streamedText(delivered.map(({ data }) => data))).toContain("Hello from fast-1");
        expect(delivered.length).toBeGreaterThan(1);
        expect(delivered.every(({ id }) => id.startsWith("sdk-stream:v1:"))).toBe(true);
        const firstOffset = delivered[0]!.id;

        // Recreate the whole agent over the same storage: persisted evidence survives an owner
        // restart. This does not cover SSE replay from a different OS process. The chat API reads
        // the agent open now, so it follows the reopen.
        yield* env.reopen;
        expect(yield* Stream.runCollect(yield* join(session, runId, firstOffset))).toEqual(
          delivered.slice(1),
        );
        yield* Effect.forEach(
          ["memory:v1:wrong:1", "sdk-stream:v1:wrong:1", `sdk-stream:v1:${runId}:99999999`, "now"],
          Effect.fnUntraced(function* (badOffset) {
            expect(yield* Effect.flip(join(session, runId, badOffset))).toEqual({
              error: "invalid_stream_offset",
            });
          }),
          { discard: true },
        );
        const other = yield* env.use(freshSession);
        expect(yield* Effect.flip(join(other, runId, firstOffset))).toEqual({
          error: "run_not_found",
        });

        const nodes = yield* env.use(Nodes);
        expect(
          yield* sqlGet("SELECT thread_id, status FROM chat_runs WHERE run_id = ?", runId),
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
          yield* sqlGet(
            "SELECT session_id, goal_instance_id, goal_version, workflow_revision_id FROM workflow_run_bindings WHERE run_id = ?",
            runId,
          ),
        ).toEqual({
          session_id: session,
          goal_instance_id: revision.goal_instance_id,
          goal_version: 1,
          workflow_revision_id: revision.id,
        });

        const before = yield* count("nodes WHERE session_id = ?", session);
        expect(yield* Effect.flip(post(session, runId, "do it again", "again"))).toEqual({
          error: "run_already_completed",
        });
        expect(yield* count("nodes WHERE session_id = ?", session)).toEqual(before);
        expect(yield* events.replay(session, runId)).toEqual(receipts);
        // Simulate restart recovery classifying an in-flight run as failed. The same ID must
        // not re-enter the model after an uncertain tool-side effect.
        yield* sqlRun("UPDATE chat_runs SET status = 'failed' WHERE run_id = ?", runId);
        expect(yield* Effect.flip(post(session, runId, "repeat uncertain work", "retry"))).toEqual({
          error: "run_outcome_uncertain",
        });
        expect(yield* count("nodes WHERE session_id = ?", session)).toEqual(before);
      }),
  );
});
