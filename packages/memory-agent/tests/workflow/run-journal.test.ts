import { SqlClient } from "effect/sql";
import { DateTime, Effect, Match, Schema } from "effect";
import { expect } from "vite-plus/test";
import { encodeFullLoopValue } from "../../src/agent/full-loop-codec.ts";
import { ownerRpcFingerprint } from "../../src/agent/owner-rpc-fingerprint.ts";
import { makeSqliteOwnerRpcLedger } from "../../src/agent/owner-rpc-ledger.ts";
import { OwnerRpcAdmission, OwnerRpcReply } from "../../src/agent/owner-rpc.ts";
import { Nodes } from "../../src/memory/nodes.ts";
import { type Admission, workflowRunBindings } from "../../src/workflow/run-bindings.ts";
import { RunEventRejected, workflowRunEvents } from "../../src/workflow/run-events.ts";
import { UncertainRunsFailed, uncertainRuns } from "../../src/workflow/uncertain-runs.ts";
import { Workflows } from "../../src/workflow/workflow.ts";
import { TestEnv, freshSession, testAgent } from "../support/test-env.ts";
import { sqlAll, sqlGet, sqlRun, sqlExec } from "../support/sql.ts";

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

const latestRevision = (session: string) =>
  Effect.gen(function* () {
    return yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.Finite }))(
      yield* sqlGet(
        "SELECT max(id) AS id FROM workflow_state_revisions WHERE session_id = ?",
        session,
      ),
    ).pipe(Effect.map((row) => row.id));
  });

const goalInstance = (session: string) =>
  Effect.gen(function* () {
    return yield* Schema.decodeUnknownEffect(Schema.Struct({ goal_instance_id: Schema.String }))(
      yield* sqlGet(
        "SELECT goal_instance_id FROM workflow_goal_identities WHERE session_id = ?",
        session,
      ),
    ).pipe(Effect.map((row) => row.goal_instance_id));
  });

/** Bind a run to the session's latest revision. */
const bindLatest = Effect.fnUntraced(function* (session: string, runId: string) {
  return yield* (yield* workflowRunBindings).bind(session, runId, yield* latestRevision(session));
});

const finishRun = (session: string, runId: string, status: string) =>
  sqlRun(
    "INSERT INTO chat_runs (run_id, thread_id, status, started_at) VALUES (?, ?, ?, ?)",
    runId,
    session,
    status,
    DateTime.toEpochMillis(DateTime.nowUnsafe()),
  );

const boundRun = (admission: Admission) => {
  switch (admission.status) {
    case "bound":
      return admission.binding;
    case "refused":
      return expect.unreachable(`run refused: ${admission.reason}`);
  }
};

testAgent()("workflow run bindings", (it) => {
  it.effect("acknowledges only the current uncertain runs and rolls back a failed write", () =>
    Effect.gen(function* () {
      const session = yield* withGoal();
      const runId = `${session}:uncertain`;
      boundRun(yield* bindLatest(session, runId));
      yield* finishRun(session, runId, "failed");
      yield* sqlRun(
        "INSERT INTO owner_rpc_operations VALUES (?, 'key', 1, ?, 1, '{}', 'uncertain')",
        runId,
        ownerRpcFingerprint(
          "tool",
          encodeFullLoopValue({ name: "run_shell", toolCallId: "call", args: {} }),
        ),
      );
      const owner = yield* uncertainRuns;
      expect(yield* owner.list(session)).toEqual([
        {
          runId,
          tools: [{ toolCallId: "call", name: "run_shell", call: null, state: "uncertain" }],
        },
      ]);
      expect(yield* owner.acknowledge(session, ["stale"])).toEqual({
        status: "refused",
        reason: "uncertain_runs_changed",
      });
      yield* sqlExec(
        "CREATE TEMP TRIGGER reject_ack BEFORE INSERT ON workflow_uncertain_acknowledgements BEGIN SELECT RAISE(ABORT, 'fixture'); END",
      );
      const failed = yield* owner.acknowledge(session, [runId]).pipe(Effect.flip);
      expect(failed).toBeInstanceOf(UncertainRunsFailed);
      expect(
        Schema.is(UncertainRunsFailed)(failed) &&
          UncertainRunsFailed.fields.reason.guards.Acknowledge(failed.reason),
      ).toBe(true);
      expect(yield* owner.list(session)).toHaveLength(1);
      yield* sqlExec("DROP TRIGGER reject_ack");
      expect(yield* owner.acknowledge(session, [runId])).toEqual({ status: "acknowledged" });
      expect(yield* owner.list(session)).toEqual([]);
    }),
  );

  it.effect(
    "the owner binds a new run to an immutable Goal/Plan revision, not a caller-provided Goal",
    () =>
      Effect.gen(function* () {
        const session = yield* freshSession;
        const owner = yield* workflowRunBindings;
        expect(yield* owner.bind(session, `${session}:legacy`, 0)).toEqual({
          status: "refused",
          reason: "legacy_unbound",
        });
        yield* (yield* Workflows).updateGoal(session, goal);
        const first = `${session}:first`;
        const second = `${session}:second`;
        const revision = yield* latestRevision(session);
        const goalInstanceId = yield* goalInstance(session);
        expect(yield* owner.bind(session, first, revision)).toMatchObject({
          status: "bound",
          binding: { goalInstanceId, goalVersion: 1, planVersion: null },
        });
        expect(yield* owner.bind(session, first, revision)).toEqual({
          status: "refused",
          reason: "run_id_conflict",
        });
        expect(yield* owner.bind(session, second, revision)).toEqual({
          status: "refused",
          reason: "run_outcome_uncertain",
        });
        yield* finishRun(session, first, "completed");
        yield* (yield* Workflows).updateGoal(session, { ...goal, outcomes: ["New outcome"] });
        expect(yield* owner.bind(session, second, revision)).toEqual({
          status: "refused",
          reason: "workflow_changed",
        });
        expect(yield* bindLatest(session, second)).toMatchObject({
          status: "bound",
          binding: { goalInstanceId, goalVersion: 2 },
        });
        expect(
          yield* sqlGet("SELECT goal_version FROM workflow_run_bindings WHERE run_id = ?", first),
        ).toEqual({ goal_version: 1 });
      }),
  );

  it.effect(
    "another session can neither adopt a run ID nor be assembled into a forged binding",
    () =>
      Effect.gen(function* () {
        const session = yield* withGoal();
        const other = yield* withGoal();
        const goalInstanceId = yield* goalInstance(session);
        const revision = yield* latestRevision(session);
        expect(yield* goalInstance(other)).not.toBe(goalInstanceId);
        const shared = `${session}:shared`;
        expect((yield* bindLatest(session, shared)).status).toBe("bound");
        expect(yield* bindLatest(other, shared)).toEqual({
          status: "refused",
          reason: "run_id_conflict",
        });
        yield* finishRun(session, shared, "failed");
        const operation = (id: number, fingerprint: string, status: string) =>
          sqlRun(
            "INSERT INTO owner_rpc_operations VALUES (?, 'key', ?, ?, 1, '{}', ?)",
            shared,
            id,
            fingerprint,
            status,
          );
        const step = (id: number, kind: "tool" | "toolAuthorize", name: string, status: string) =>
          operation(
            id,
            ownerRpcFingerprint(
              kind,
              encodeFullLoopValue({ name, toolCallId: `${name}-call`, args: {} }),
            ),
            status,
          );
        const bindings = yield* workflowRunBindings;
        const admits = () =>
          Effect.map(
            bindings.bind(session, `${session}:different`, revision, undefined, "preview"),
            (admission) => admission.status,
          );
        // Owner bookkeeping, an authorization and a read the next run cannot know of repeat nothing.
        yield* operation(1, '{"operation":"middleware"}', "succeeded");
        yield* step(2, "toolAuthorize", "run_shell", "succeeded");
        yield* step(3, "tool", "read_file", "succeeded");
        expect(yield* admits()).toBe("bound");
        // An effectful tool is known to the next run only through its recorded result.
        yield* step(4, "tool", "run_shell", "succeeded");
        expect(yield* admits()).toBe("refused");
        yield* (yield* Nodes).append({
          projectId: (yield* TestEnv).project.id,
          sessionId: session,
          runId: shared,
          kind: "tool_result",
          text: "done",
          detail: { toolName: "run_shell", toolCallId: "run_shell-call", ok: true },
        });
        expect(yield* admits()).toBe("bound");
        // A tool the run left uncertain may have changed something.
        yield* step(5, "tool", "read_file", "uncertain");
        expect(yield* bindLatest(session, `${session}:different`)).toEqual({
          status: "refused",
          reason: "run_outcome_uncertain",
        });
        expect(
          String(
            (yield* Effect.flip(
              sqlRun("UPDATE workflow_run_bindings SET goal_version = 3 WHERE run_id = ?", shared),
            )).reason.cause,
          ),
        ).toContain("run binding is immutable");
        expect(
          String(
            (yield* Effect.flip(
              sqlRun(
                `
              INSERT INTO workflow_run_bindings
                (run_id, session_id, goal_instance_id, goal_version, plan_version, workflow_revision_id, created_at)
              VALUES (?, ?, ?, 1, NULL, ?, ?)
            `,
                `${session}:forged`,
                other,
                goalInstanceId,
                revision,
                DateTime.formatIso(DateTime.nowUnsafe()),
              ),
            )).reason.cause,
          ),
        ).toContain("run binding session mismatch");
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
        const session = yield* withGoal();
        const old = `${session}:old`;
        const binding = boundRun(yield* bindLatest(session, old));
        yield* finishRun(session, old, "completed");
        const ledger = yield* makeSqliteOwnerRpcLedger;
        const key = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(binding);
        expect(yield* ledger.reserve(key, 1, "effect", sideEffect)).toEqual(
          OwnerRpcAdmission.reserved(),
        );
        yield* Match.value(status).pipe(
          Match.when("pending", () => Effect.void),
          Match.when("uncertain", () =>
            ledger.settle(key, 1, OwnerRpcReply.uncertain({ operationId: 1 })),
          ),
          Match.when("succeeded", () =>
            ledger.settle(key, 1, OwnerRpcReply.succeeded({ operationId: 1, output: null })),
          ),
          Match.exhaustive,
        );
        yield* (yield* Workflows).updateGoal(session, { ...goal, outcomes: ["Revised outcome"] });
        const receipts = () => sqlAll("SELECT * FROM owner_rpc_operations WHERE run_id = ?", old);
        const before = yield* receipts();
        expect(yield* bindLatest(session, `${session}:new`)).toMatchObject(
          blocked ? { status: "refused", reason: "run_outcome_uncertain" } : { status: "bound" },
        );
        expect(yield* receipts()).toEqual(before);
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
        const session = yield* withGoal(["Replay output"]);
        const other = yield* freshSession;
        const run = `${session}:journaled`;
        expect((yield* bindLatest(session, run)).status).toBe("bound");
        const events = yield* workflowRunEvents;
        expect(
          yield* events
            .append(other, run, "chunk:0", "chunk", { text: "stolen" })
            .pipe(Effect.flip),
        ).toEqual(RunEventRejected.make({ reason: "unbound" }));
        const first = yield* events.append(session, run, "chunk:0", "chunk", {
          text: "before restart",
        });
        expect(
          yield* events.append(session, run, "chunk:0", "chunk", { text: "before restart" }),
        ).toEqual(first);
        expect(
          yield* events
            .append(session, run, "chunk:0", "chunk", { text: "different" })
            .pipe(Effect.flip),
        ).toEqual(RunEventRejected.make({ reason: "key-reused" }));
        const second = yield* events.append(session, run, "chunk:1", "chunk", {
          text: "after first",
        });
        expect(second.cursor).toBeGreaterThan(first.cursor);
        expect(yield* events.replay(other, run)).toEqual([]);
        expect(yield* events.replay(session, run, first.cursor)).toEqual([second]);
        expect(
          yield* sqlGet("SELECT count(*) AS n FROM workflow_run_events WHERE run_id = ?", run),
        ).toEqual({ n: 2 });
        yield* env.reopen;
        const replay = yield* workflowRunEvents.pipe(
          Effect.provideService(SqlClient.SqlClient, yield* env.use(SqlClient.SqlClient)),
        );
        expect(yield* replay.replay(session, run)).toEqual([first, second]);
        expect(yield* replay.replay(session, run, -1).pipe(Effect.flip)).toMatchObject({
          reason: "invalid-cursor",
        });
      }),
  );
});
