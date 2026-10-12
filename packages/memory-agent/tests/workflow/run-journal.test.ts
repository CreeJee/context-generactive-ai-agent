import { DateTime, Effect, Schema } from "effect";
import { expect } from "vite-plus/test";
import { encodeFullLoopValue } from "../../src/agent/full-loop-codec.ts";
import { ownerRpcFingerprint } from "../../src/agent/owner-rpc-fingerprint.ts";
import { makeSqliteOwnerRpcLedger } from "../../src/agent/owner-rpc-ledger.ts";
import { Database } from "../../src/db/database.ts";
import { Nodes } from "../../src/memory/nodes.ts";
import { type Admission, workflowRunBindings } from "../../src/workflow/run-bindings.ts";
import { workflowRunEvents } from "../../src/workflow/run-events.ts";
import { Workflows } from "../../src/workflow/workflow.ts";
import { TestEnv, freshSession, testAgent } from "../support/test-env.ts";

const goal = {
  statement: "Preserve an active Goal",
  outcomes: ["Safe evidence"],
  constraints: [],
  nonGoals: [],
  assumptions: [],
  openQuestions: [],
  status: "active" as const,
};

/** A fresh session with an active Goal. */
const withGoal = Effect.fnUntraced(function* (outcomes = goal.outcomes) {
  const session = yield* freshSession;
  yield* (yield* Workflows).updateGoal(session, { ...goal, outcomes });
  return session;
});

const latestRevision = (db: Database["Service"], session: string) =>
  Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.Finite }))(
    db.sqlite
      .prepare("SELECT max(id) AS id FROM workflow_state_revisions WHERE session_id = ?")
      .get(session),
  ).pipe(Effect.map((row) => row.id));

const goalInstance = (db: Database["Service"], session: string) =>
  Schema.decodeUnknownEffect(Schema.Struct({ goal_instance_id: Schema.String }))(
    db.sqlite
      .prepare("SELECT goal_instance_id FROM workflow_goal_identities WHERE session_id = ?")
      .get(session),
  ).pipe(Effect.map((row) => row.goal_instance_id));

/** Bind a run to the session's latest revision. */
const bindLatest = Effect.fnUntraced(function* (session: string, runId: string) {
  const db = yield* Database;
  return workflowRunBindings(db).bind(session, runId, yield* latestRevision(db, session));
});

const finishRun = (db: Database["Service"], session: string, runId: string, status: string) =>
  db.sqlite
    .prepare("INSERT INTO chat_runs (run_id, thread_id, status, started_at) VALUES (?, ?, ?, ?)")
    .run(runId, session, status, DateTime.toEpochMillis(DateTime.nowUnsafe()));

const boundRun = (admission: Admission) => {
  switch (admission.status) {
    case "bound":
      return admission.binding;
    case "refused":
      return expect.unreachable(`run refused: ${admission.reason}`);
  }
};

testAgent()("workflow run bindings", (it) => {
  it.effect(
    "the owner binds a new run to an immutable Goal/Plan revision, not a caller-provided Goal",
    () =>
      Effect.gen(function* () {
        const session = yield* freshSession;
        const db = yield* Database;
        const owner = workflowRunBindings(db);
        expect(owner.bind(session, `${session}:legacy`, 0)).toEqual({
          status: "refused",
          reason: "legacy_unbound",
        });
        yield* (yield* Workflows).updateGoal(session, goal);
        const first = `${session}:first`;
        const second = `${session}:second`;
        const revision = yield* latestRevision(db, session);
        const goalInstanceId = yield* goalInstance(db, session);
        expect(owner.bind(session, first, revision)).toMatchObject({
          status: "bound",
          binding: { goalInstanceId, goalVersion: 1, planVersion: null },
        });
        expect(owner.bind(session, first, revision)).toEqual({
          status: "refused",
          reason: "run_id_conflict",
        });
        expect(owner.bind(session, second, revision)).toEqual({
          status: "refused",
          reason: "run_outcome_uncertain",
        });
        finishRun(db, session, first, "completed");
        yield* (yield* Workflows).updateGoal(session, { ...goal, outcomes: ["New outcome"] });
        expect(owner.bind(session, second, revision)).toEqual({
          status: "refused",
          reason: "workflow_changed",
        });
        expect(yield* bindLatest(session, second)).toMatchObject({
          status: "bound",
          binding: { goalInstanceId, goalVersion: 2 },
        });
        expect(
          db.sqlite
            .prepare("SELECT goal_version FROM workflow_run_bindings WHERE run_id = ?")
            .get(first),
        ).toEqual({ goal_version: 1 });
      }),
  );

  it.effect(
    "another session can neither adopt a run ID nor be assembled into a forged binding",
    () =>
      Effect.gen(function* () {
        const db = yield* Database;
        const session = yield* withGoal();
        const other = yield* withGoal();
        const goalInstanceId = yield* goalInstance(db, session);
        const revision = yield* latestRevision(db, session);
        expect(yield* goalInstance(db, other)).not.toBe(goalInstanceId);
        const shared = `${session}:shared`;
        expect((yield* bindLatest(session, shared)).status).toBe("bound");
        expect(yield* bindLatest(other, shared)).toEqual({
          status: "refused",
          reason: "run_id_conflict",
        });
        finishRun(db, session, shared, "failed");
        const operation = db.sqlite.prepare(
          "INSERT INTO owner_rpc_operations VALUES (?, 'key', ?, ?, 1, '{}', ?)",
        );
        const step = (id: number, kind: "tool" | "toolAuthorize", name: string, status: string) =>
          operation.run(
            shared,
            id,
            ownerRpcFingerprint(
              kind,
              encodeFullLoopValue({ name, toolCallId: `${name}-call`, args: {} }),
            ),
            status,
          );
        const admits = () =>
          workflowRunBindings(db).bind(
            session,
            `${session}:different`,
            revision,
            undefined,
            "preview",
          ).status;
        // Owner bookkeeping, an authorization and a read the next run cannot know of repeat nothing.
        operation.run(shared, 1, JSON.stringify({ operation: "middleware" }), "succeeded");
        step(2, "toolAuthorize", "run_shell", "succeeded");
        step(3, "tool", "read_file", "succeeded");
        expect(admits()).toBe("bound");
        // An effectful tool is known to the next run only through its recorded result.
        step(4, "tool", "run_shell", "succeeded");
        expect(admits()).toBe("refused");
        (yield* Nodes).append({
          projectId: (yield* TestEnv).project.id,
          sessionId: session,
          runId: shared,
          kind: "tool_result",
          text: "done",
          detail: { toolName: "run_shell", toolCallId: "run_shell-call", ok: true },
        });
        expect(admits()).toBe("bound");
        // A tool the run left uncertain may have changed something.
        step(5, "tool", "read_file", "uncertain");
        expect(yield* bindLatest(session, `${session}:different`)).toEqual({
          status: "refused",
          reason: "run_outcome_uncertain",
        });
        expect(() =>
          db.sqlite
            .prepare("UPDATE workflow_run_bindings SET goal_version = 3 WHERE run_id = ?")
            .run(shared),
        ).toThrow("run binding is immutable");
        expect(() =>
          db.sqlite
            .prepare(`
              INSERT INTO workflow_run_bindings
                (run_id, session_id, goal_instance_id, goal_version, plan_version, workflow_revision_id, created_at)
              VALUES (?, ?, ?, 1, NULL, ?, ?)
            `)
            .run(
              `${session}:forged`,
              other,
              goalInstanceId,
              revision,
              DateTime.formatIso(DateTime.nowUnsafe()),
            ),
        ).toThrow("run binding session mismatch");
      }),
  );

  it.effect.each([
    { status: "pending", sideEffect: true, blocked: true },
    { status: "pending", sideEffect: false, blocked: true },
    { status: "uncertain", sideEffect: true, blocked: true },
    { status: "uncertain", sideEffect: false, blocked: false },
    { status: "succeeded", sideEffect: true, blocked: false },
  ] as const)(
    "completed run receipt $status sideEffect=$sideEffect fences=$blocked across Goal versions",
    ({ status, sideEffect, blocked }) =>
      Effect.gen(function* () {
        const db = yield* Database;
        const session = yield* withGoal();
        const old = `${session}:old`;
        const binding = boundRun(yield* bindLatest(session, old));
        finishRun(db, session, old, "completed");
        const ledger = makeSqliteOwnerRpcLedger(db);
        const key = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(binding);
        expect(ledger.reserve(key, 1, "effect", sideEffect)).toEqual({ type: "reserved" });
        switch (status) {
          case "pending":
            break;
          case "uncertain":
            ledger.settle(key, 1, { type: "uncertain", operationId: 1 });
            break;
          case "succeeded":
            ledger.settle(key, 1, { type: "succeeded", operationId: 1, output: null });
            break;
        }
        yield* (yield* Workflows).updateGoal(session, { ...goal, outcomes: ["Revised outcome"] });
        const receipts = () =>
          db.sqlite.prepare("SELECT * FROM owner_rpc_operations WHERE run_id = ?").all(old);
        const before = receipts();
        expect(yield* bindLatest(session, `${session}:new`)).toMatchObject(
          blocked ? { status: "refused", reason: "run_outcome_uncertain" } : { status: "bound" },
        );
        expect(receipts()).toEqual(before);
      }),
  );
});

// Reopening replaces the agent, so the journal gets its own and reads services through `env.use`.
testAgent()("workflow run event journal", (it) => {
  it.effect(
    "the owner journals bound output with idempotent keys and replays it after reopening",
    () =>
      Effect.gen(function* () {
        const env = yield* TestEnv;
        const db = yield* Database;
        const session = yield* withGoal(["Replay output"]);
        const other = yield* freshSession;
        const run = `${session}:journaled`;
        expect((yield* bindLatest(session, run)).status).toBe("bound");
        const events = workflowRunEvents(db);
        expect(() => events.append(other, run, "chunk:0", "chunk", { text: "stolen" })).toThrow(
          "Run event has no owner binding",
        );
        const first = events.append(session, run, "chunk:0", "chunk", { text: "before restart" });
        expect(events.append(session, run, "chunk:0", "chunk", { text: "before restart" })).toEqual(
          first,
        );
        expect(() =>
          events.append(session, run, "chunk:0", "chunk", { text: "different" }),
        ).toThrow("Run event key was reused for different content");
        const second = events.append(session, run, "chunk:1", "chunk", { text: "after first" });
        expect(second.cursor).toBeGreaterThan(first.cursor);
        expect(events.replay(other, run)).toEqual([]);
        expect(events.replay(session, run, first.cursor)).toEqual([second]);
        expect(
          db.sqlite
            .prepare("SELECT count(*) AS n FROM workflow_run_events WHERE run_id = ?")
            .get(run),
        ).toEqual({ n: 2 });
        yield* env.reopen;
        const replay = workflowRunEvents(yield* env.use(Database));
        expect(replay.replay(session, run)).toEqual([first, second]);
        expect(() => replay.replay(session, run, -1)).toThrow("Invalid run cursor");
      }),
  );
});
