import { layer } from "@effect/vitest";
import { Data, Effect, Layer, Schema } from "effect";
import { expect } from "vite-plus/test";
import { Sessions } from "../../src/sessions/sessions.ts";
import type { JsonValue } from "../../src/json.ts";
import { Admission, workflowRunBindings } from "../../src/workflow/run-bindings.ts";
import { WorkflowTools } from "../../src/workflow/tools.ts";
import { NewGoalSettlement, Workflows, type WorkflowState } from "../../src/workflow/workflow.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";
import { callTool } from "../support/run-tools.ts";
import { sqlAll, sqlGet, sqlRun } from "../support/sql.ts";

const goal = {
  statement: "first",
  outcomes: ["first success"],
  constraints: [],
  nonGoals: [],
  assumptions: [],
  openQuestions: [],
  status: "active" as const,
};

const plan = {
  summary: "method",
  steps: [],
  risks: [],
  openQuestions: [],
  status: "ready" as const,
};

const transition = (previousGoalInstanceId: string | null) => ({
  action: "new_independent_goal" as const,
  previousGoalInstanceId,
  reason: "explicit independent task",
  goal: { ...goal, statement: "second", outcomes: ["different success"] },
});

const closingProgress = {
  goalStatus: "completed" as const,
  goalEvidence: ["old proof"],
  planEvidence: [],
  steps: [],
  verification: { status: "passed" as const, summary: "old success", evidence: ["old proof"] },
  detail: "verified first",
};

/** Rows a session owns; run-keyed tables are reached through the session's run bindings. */
const sessionRows = {
  revisions: "SELECT * FROM workflow_state_revisions WHERE session_id = ? ORDER BY id",
  bindings: "SELECT * FROM workflow_run_bindings WHERE session_id = ? ORDER BY rowid",
  events: `SELECT * FROM workflow_run_events WHERE run_id IN
    (SELECT run_id FROM workflow_run_bindings WHERE session_id = ?) ORDER BY cursor`,
  dispatches: `SELECT * FROM workflow_worker_dispatches WHERE run_id IN
    (SELECT run_id FROM workflow_run_bindings WHERE session_id = ?) ORDER BY rowid`,
  receipts: `SELECT * FROM owner_rpc_operations WHERE run_id IN
    (SELECT run_id FROM workflow_run_bindings WHERE session_id = ?) ORDER BY rowid`,
  goalInstances: "SELECT * FROM workflow_goal_instances WHERE session_id = ? ORDER BY rowid",
  requests: "SELECT * FROM workflow_new_goal_requests WHERE session_id = ? ORDER BY rowid",
} as const;

const rows = (table: keyof typeof sessionRows, session: string) =>
  sqlAll(sessionRows[table], session);

/** Everything a new Goal must leave as it was: earlier revisions and every bound run's record. */
const history = ["revisions", "bindings", "events", "dispatches", "receipts"] as const;
const snapshot = (session: string) => Effect.forEach(history, (table) => rows(table, session));
const expectHistoryKept = (session: string, before: Effect.Success<ReturnType<typeof snapshot>>) =>
  Effect.forEach(
    history,
    (table, index) =>
      Effect.map(rows(table, session), (actual) =>
        // A new Goal appends revisions; the ones before it stay untouched.
        expect(table === "revisions" ? actual.slice(0, before[index]?.length) : actual).toEqual(
          before[index],
        ),
      ),
    { discard: true },
  );

const identity = (session: string) =>
  Effect.gen(function* () {
    return yield* Schema.decodeUnknownEffect(Schema.Struct({ goal_instance_id: Schema.String }))(
      yield* sqlGet(
        "SELECT goal_instance_id FROM workflow_goal_identities WHERE session_id = ?",
        session,
      ),
    ).pipe(Effect.map((row) => row.goal_instance_id));
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

const bindRun = Effect.fnUntraced(function* (session: string, runId: string) {
  expect(
    Admission.$is("bound")(
      yield* (yield* workflowRunBindings).bind(session, runId, yield* latestRevision(session)),
    ),
  ).toBe(true);
});

const startRun = (session: string, runId: string, status: string) =>
  sqlRun(
    "INSERT INTO chat_runs (run_id, thread_id, status, started_at) VALUES (?, ?, ?, 1)",
    runId,
    session,
    status,
  );

const setRun = (runId: string, status: string) =>
  sqlRun("UPDATE chat_runs SET status = ? WHERE run_id = ?", status, runId);

/**
 * A fresh session in Goal with a ready Plan, whose completed run is bound to the first Goal and
 * left its journal, worker dispatch and owner receipt. Run IDs are global, so they carry the
 * session.
 */
const withHistory = Effect.fnUntraced(function* () {
  const { project } = yield* TestEnv;
  const workflows = yield* Workflows;
  const session = (yield* (yield* Sessions).create(project.id)).id;
  yield* workflows.setPhase(session, "goal");
  yield* workflows.updateGoal(session, goal);
  yield* workflows.updatePlan(session, plan);
  const historical = `${session}:historical`;
  yield* bindRun(session, historical);
  yield* startRun(session, historical, "completed");
  yield* sqlRun(
    `INSERT INTO workflow_run_events (run_id, event_key, kind, payload_json, created_at)
        VALUES (?, 'done', 'run_completed', '{"bytes":"old\\r\\n"}', 'old')`,
    historical,
  );
  yield* sqlRun(
    "INSERT INTO workflow_worker_dispatches VALUES (?, 'old-generation', 'old')",
    historical,
  );
  yield* sqlRun(
    `INSERT INTO owner_rpc_operations VALUES (?, 'key', 1, 'fingerprint', 1, '{"status":"old"}', 'succeeded')`,
    historical,
  );
  return { workflows, session, historical, old: yield* identity(session) };
});

/** `withHistory`, plus the bound run that asks for the new Goal and is still running. */
const withInvokingRun = Effect.fnUntraced(function* () {
  const f = yield* withHistory();
  const invoking = `${f.session}:invoking`;
  yield* bindRun(f.session, invoking);
  yield* startRun(f.session, invoking, "running");
  const request = (runId = invoking) =>
    f.workflows.requestNewGoal(f.session, runId, transition(f.old));
  const settle = () => f.workflows.settleNewGoalRequest(f.session, invoking);
  return { ...f, invoking, request, settle };
});

/** What `startNewGoal` does in a case: apply the new Goal, or refuse it for `reason`. */
type Expected = Data.TaggedEnum<{ applied: {}; refused: { readonly reason: string } }>;
const Expected = Data.taggedEnum<Expected>();

const applied = Expected.applied();
const refused = (reason: string) => Expected.refused({ reason });

/** Goal phase, the earlier run completed with a settled receipt, and the current Goal named. */
const admissible = {
  phase: "goal",
  closed: false,
  historicalRun: "completed",
  ownerEffect: "succeeded",
  previous: "current",
} as const;

const transitionCases: ReadonlyArray<{
  readonly name: string;
  readonly phase: WorkflowState["phase"];
  /** Verify passed before the transition; a `completed` phase also finishes the run. */
  readonly closed: boolean;
  readonly historicalRun: "completed" | "running" | "failed" | "missing";
  readonly ownerEffect: "succeeded" | "pending" | "uncertain";
  readonly previous: "current" | "stale" | "none";
  readonly admission: Expected;
}> = [
  { ...admissible, name: "goal with an existing Goal", admission: applied },
  { ...admissible, name: "plan with an existing Goal", phase: "plan", admission: applied },
  { ...admissible, name: "closed verify", phase: "verify", closed: true, admission: applied },
  {
    ...admissible,
    name: "completed workflow",
    phase: "completed",
    closed: true,
    admission: applied,
  },
  {
    ...admissible,
    name: "unclosed verify",
    phase: "verify",
    admission: refused("phase_not_authorized"),
  },
  { ...admissible, name: "execute", phase: "execute", admission: refused("phase_not_authorized") },
  { ...admissible, name: "chat", phase: "chat", admission: refused("phase_not_authorized") },
  ...(["running", "failed", "missing"] as const).map((historicalRun) => ({
    ...admissible,
    name: `${historicalRun} bound worker execution`,
    historicalRun,
    admission: refused("run_outcome_uncertain"),
  })),
  {
    ...admissible,
    name: "closed verify while its run is still active",
    phase: "verify",
    closed: true,
    historicalRun: "running",
    admission: refused("run_outcome_uncertain"),
  },
  ...(["pending", "uncertain"] as const).map((ownerEffect) => ({
    ...admissible,
    name: `completed run with ${ownerEffect} owner effect`,
    ownerEffect,
    admission: refused("owner_effect_uncertain"),
  })),
  ...(["stale", "none"] as const).map((previous) => ({
    ...admissible,
    name: `${previous} previous Goal ID`,
    previous,
    admission: refused("workflow_changed"),
  })),
];

/** The session's start_new_goal, called as the model would. */
const goalTool = Effect.fnUntraced(function* (session: string) {
  const tools = (yield* WorkflowTools).toolsFor(session, "goal");
  return (input: JsonValue) => callTool(tools, "start_new_goal", input);
});

testAgent()("explicit new Goal transition", (it) => {
  it.effect.each(transitionCases)("startNewGoal from $name", (c) =>
    Effect.gen(function* () {
      const { workflows, session, historical, old } = yield* withHistory();
      if (c.closed) {
        yield* workflows.setPhase(session, "verify");
        yield* workflows.updateProgress(session, closingProgress);
        if (c.phase === "completed") yield* workflows.finishRun(session, "verify");
      } else if (c.phase !== "goal") yield* workflows.setPhase(session, c.phase);
      expect((yield* workflows.get(session)).phase).toBe(c.phase);
      switch (c.historicalRun) {
        case "completed":
          break;
        case "running":
        case "failed":
          yield* setRun(historical, c.historicalRun);
          break;
        case "missing":
          yield* sqlRun("DELETE FROM chat_runs WHERE run_id = ?", historical);
          break;
      }
      yield* sqlRun(
        "UPDATE owner_rpc_operations SET status = ? WHERE run_id = ?",
        c.ownerEffect,
        historical,
      );
      const previous = (() => {
        switch (c.previous) {
          case "current":
            return old;
          case "stale":
            return "stale";
          case "none":
            return null;
        }
      })();
      const before = yield* rows("revisions", session);
      yield* Expected.$match(c.admission, {
        applied: () =>
          Effect.gen(function* () {
            expect(yield* workflows.startNewGoal(session, transition(previous))).toMatchObject({
              goal: { version: 1 },
              plan: null,
            });
            expect(yield* identity(session)).not.toBe(old);
          }),
        refused: ({ reason }) =>
          Effect.gen(function* () {
            expect(
              yield* Effect.flip(workflows.startNewGoal(session, transition(previous))),
            ).toMatchObject({ reason });
            expect(yield* identity(session)).toBe(old);
            expect(yield* rows("revisions", session)).toEqual(before);
          }),
      });
    }),
  );

  it.effect("owner tool is exposed at potential source phases and checks latest state", () =>
    Effect.gen(function* () {
      const { workflows, session, old } = yield* withHistory();
      const tools = yield* WorkflowTools;
      const exposed = (phase: WorkflowState["phase"]) =>
        tools.toolsFor(session, phase).some(({ tool }) => tool.name === "start_new_goal");
      (["chat", "execute"] as const).forEach((phase) => expect(exposed(phase)).toBe(false));
      (["goal", "plan", "verify", "completed"] as const).forEach((phase) =>
        expect(exposed(phase)).toBe(true),
      );
      const execute = yield* goalTool(session);
      yield* workflows.setPhase(session, "execute");
      expect(yield* execute(transition(old))).toMatchObject({
        error: "new_goal_transition_refused",
        reason: "phase_not_authorized",
      });
      yield* workflows.setPhase(session, "plan");
      expect(yield* execute(transition(old))).toMatchObject({ goal: { version: 1 }, plan: null });
    }),
  );

  it.effect("legacy historical Goal and revisions remain unbound after explicit new Goal", () =>
    Effect.gen(function* () {
      const { project } = yield* TestEnv;
      const workflows = yield* Workflows;
      const session = (yield* (yield* Sessions).create(project.id)).id;
      yield* workflows.setPhase(session, "goal");
      // Represent a real legacy artifact directly, without assigning any historical ID.
      yield* sqlRun(
        "UPDATE session_workflows SET state_json = ? WHERE session_id = ?",
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
          phase: "goal",
          goal: {
            ...goal,
            version: 4,
            evidence: ["legacy"],
            verification: {
              status: "passed",
              summary: "old",
              evidence: ["legacy"],
              recoveryPhase: null,
              updatedAt: null,
            },
            updatedAt: "old",
          },
          plan: null,
          ledger: [],
        }),
        session,
      );
      const before = yield* rows("revisions", session);
      expect(yield* workflows.startNewGoal(session, transition(null))).toMatchObject({
        goal: { version: 1, evidence: [] },
      });
      expect((yield* rows("revisions", session)).slice(0, before.length)).toEqual(before);
      expect(yield* rows("goalInstances", session)).toHaveLength(1);
    }),
  );
});

testAgent()("deferred new Goal request", (it) => {
  it.effect.each(["failed", "aborted", "missing", "interrupted"] as const)(
    "%s invoking run never applies accepted new Goal",
    (status) =>
      Effect.gen(function* () {
        const f = yield* withInvokingRun();
        expect(yield* f.request()).toMatchObject({ status: "accepted" });
        const before = yield* rows("revisions", f.session);
        switch (status) {
          case "missing":
            yield* sqlRun("DELETE FROM chat_runs WHERE run_id = ?", f.invoking);
            break;
          case "failed":
          case "aborted":
          case "interrupted":
            yield* setRun(f.invoking, status);
            break;
        }
        const result = yield* f.settle();
        expect(result).toEqual(
          status === "interrupted"
            ? NewGoalSettlement.accepted()
            : NewGoalSettlement.rejected({ reason: "run_outcome_uncertain" }),
        );
        expect(yield* f.settle()).toEqual(result);
        expect(yield* identity(f.session)).toBe(f.old);
        expect(yield* rows("revisions", f.session)).toEqual(before);
      }),
  );

  it.effect("stale ID, competing request and active foreign run cannot be admitted", () =>
    Effect.gen(function* () {
      const f = yield* withInvokingRun();
      const before = yield* rows("revisions", f.session);
      yield* Effect.forEach(
        ["stale", null],
        (stale) =>
          Effect.map(
            Effect.flip(
              f.workflows.requestNewGoal(f.session, f.invoking, {
                ...transition(f.old),
                previousGoalInstanceId: stale,
              }),
            ),
            (refused) => expect(refused).toMatchObject({ reason: "workflow_changed" }),
          ),
        { discard: true },
      );
      expect(yield* rows("requests", f.session)).toEqual([]);
      const other = `${f.session}:other`;
      yield* startRun(f.session, other, "running");
      expect(yield* Effect.flip(f.request())).toMatchObject({ reason: "run_outcome_uncertain" });
      yield* setRun(other, "completed");
      expect(yield* f.request()).toMatchObject({ status: "accepted" });
      expect(yield* Effect.flip(f.request(other))).toMatchObject({
        reason: "run_outcome_uncertain",
      });
      const competing = `${f.session}:competing`;
      yield* startRun(f.session, competing, "running");
      expect(yield* Effect.flip(f.request(competing))).toMatchObject({
        reason: "transition_pending",
      });
      expect(
        yield* Effect.flip(f.workflows.startNewGoal(f.session, transition(f.old))),
      ).toMatchObject({ reason: "transition_pending" });
      expect(yield* rows("requests", f.session)).toHaveLength(1);
      expect(yield* identity(f.session)).toBe(f.old);
      expect(yield* rows("revisions", f.session)).toEqual(before);
    }),
  );

  it.effect.each(["pending", "uncertain"] as const)(
    "%s owner effect blocks settlement without altering old history",
    (ownerStatus) =>
      Effect.gen(function* () {
        const f = yield* withInvokingRun();
        yield* f.request();
        yield* sqlRun(
          "UPDATE owner_rpc_operations SET status = ? WHERE run_id = ?",
          ownerStatus,
          f.historical,
        );
        yield* setRun(f.invoking, "completed");
        const before = yield* rows("revisions", f.session);
        expect(yield* f.settle()).toEqual(
          NewGoalSettlement.rejected({ reason: "owner_effect_uncertain" }),
        );
        expect(yield* identity(f.session)).toBe(f.old);
        expect(yield* rows("revisions", f.session)).toEqual(before);
      }),
  );
});

// Reopening replaces the agent, so these tests read every service through `env.use`.
testAgent()("new Goal transition across reopening", (it) => {
  it.effect(
    "explicit new identity preserves prior revisions, bindings, receipts and evidence through reopen",
    () =>
      Effect.gen(function* () {
        const env = yield* TestEnv;
        const { workflows, session, old } = yield* env.use(withHistory());
        yield* workflows.updateProgress(session, closingProgress);
        yield* workflows.setPhase(session, "verify");
        const before = yield* snapshot(session);
        const next = yield* workflows.startNewGoal(session, transition(old));
        const newId = yield* identity(session);
        expect(newId).not.toBe(old);
        expect(next).toMatchObject({
          phase: "goal",
          plan: null,
          goal: { version: 1, evidence: [], verification: { status: "not_run", evidence: [] } },
        });
        yield* expectHistoryKept(session, before);
        expect(yield* rows("goalInstances", session)).toHaveLength(2);
        yield* workflows.updatePlan(session, plan);
        expect(yield* identity(session)).toBe(newId);
        expect((yield* workflows.get(session)).goal?.version).toBe(1);
        yield* workflows.updateGoal(session, { ...goal, outcomes: ["revised second purpose"] });
        expect(yield* identity(session)).toBe(newId);
        expect((yield* workflows.get(session)).goal?.version).toBe(2);
        yield* env.reopen;
        expect(yield* identity(session)).toBe(newId);
        expect(
          yield* sqlGet(
            "SELECT goal_instance_id FROM workflow_run_bindings WHERE run_id = ?",
            `${session}:historical`,
          ),
        ).toEqual({ goal_instance_id: old });
        const revisionsOf = (goalInstanceId: string) =>
          sqlAll(
            "SELECT id FROM workflow_state_revisions WHERE goal_instance_id = ?",
            goalInstanceId,
          );
        // The first revision, recorded before any Goal existed, belongs to neither identity.
        expect(yield* revisionsOf(old)).toHaveLength(before[0]!.length - 1);
        expect(yield* revisionsOf(newId)).toHaveLength(3);
        expect(yield* sqlAll("PRAGMA foreign_key_check")).toEqual([]);
      }),
  );

  it.effect(
    "accepted request leaves identity, state, revision and history untouched until completed settlement; applies once",
    () =>
      Effect.gen(function* () {
        const env = yield* TestEnv;
        const f = yield* env.use(withInvokingRun());
        const before = yield* snapshot(f.session);
        const state = yield* f.workflows.get(f.session);
        expect(yield* f.request()).toEqual({ status: "accepted", runId: f.invoking });
        expect(yield* f.request()).toEqual({ status: "accepted", runId: f.invoking });
        expect(yield* f.settle()).toEqual(NewGoalSettlement.accepted());
        expect(yield* identity(f.session)).toBe(f.old);
        expect(yield* f.workflows.get(f.session)).toEqual(state);
        const source = yield* latestRevision(f.session);
        expect(yield* rows("revisions", f.session)).toEqual(before[0]);
        expect(yield* rows("requests", f.session)).toMatchObject([
          { status: "accepted", source_revision_id: source },
        ]);
        yield* setRun(f.invoking, "completed");
        const applied = yield* f.settle();
        const newId = yield* identity(f.session);
        expect(newId).not.toBe(f.old);
        expect(applied).toEqual(NewGoalSettlement.applied({ goalInstanceId: newId }));
        expect(yield* f.settle()).toEqual(applied);
        expect(yield* rows("goalInstances", f.session)).toHaveLength(2);
        yield* expectHistoryKept(f.session, before);
        expect(yield* f.workflows.get(f.session)).toMatchObject({
          phase: "goal",
          goal: { statement: "second", version: 1 },
          plan: null,
        });
        yield* env.reopen;
        const workflows = yield* env.use(Workflows);
        expect(yield* workflows.settleNewGoalRequest(f.session, f.invoking)).toEqual(applied);
        expect(yield* identity(f.session)).toBe(newId);
        expect(yield* sqlAll("PRAGMA foreign_key_check")).toEqual([]);
      }),
  );

  it.effect("revision race rejects accepted request; persisted rejection survives reopen", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const f = yield* env.use(withInvokingRun());
      yield* f.request();
      yield* f.workflows.updatePlan(f.session, { ...plan, summary: "concurrent revision" });
      const before = yield* rows("revisions", f.session);
      yield* setRun(f.invoking, "completed");
      expect(yield* f.settle()).toEqual(NewGoalSettlement.rejected({ reason: "workflow_changed" }));
      expect(yield* identity(f.session)).toBe(f.old);
      expect(yield* rows("revisions", f.session)).toEqual(before);
      yield* env.reopen;
      const workflows = yield* env.use(Workflows);
      expect(yield* workflows.settleNewGoalRequest(f.session, f.invoking)).toEqual(
        NewGoalSettlement.rejected({ reason: "workflow_changed" }),
      );
    }),
  );

  it.effect(
    "restart recovers an unfinished run without silently applying its accepted intent",
    () =>
      Effect.gen(function* () {
        const env = yield* TestEnv;
        const f = yield* env.use(withInvokingRun());
        yield* f.request();
        const before = yield* rows("revisions", f.session);
        yield* env.reopen;
        const workflows = yield* env.use(Workflows);
        // Startup resolves orphaned running chat runs; it cannot infer a successful outcome.
        expect(
          yield* sqlGet("SELECT status FROM chat_runs WHERE run_id = ?", f.invoking),
        ).not.toEqual({ status: "completed" });
        // The startup check settles it before any run asks again.
        expect(yield* rows("requests", f.session)).toMatchObject([
          { status: "rejected", reason: "run_outcome_uncertain" },
        ]);
        const result = yield* workflows.settleNewGoalRequest(f.session, f.invoking);
        expect(result).toEqual(NewGoalSettlement.rejected({ reason: "run_outcome_uncertain" }));
        expect(yield* workflows.settleNewGoalRequest(f.session, f.invoking)).toEqual(result);
        expect(yield* identity(f.session)).toBe(f.old);
        expect(yield* rows("goalInstances", f.session)).toHaveLength(1);
        expect(yield* rows("revisions", f.session)).toEqual(before);
        // The settled request no longer holds the session: the next run may ask again.
        const next = `${f.session}:next`;
        yield* env.use(bindRun(f.session, next));
        yield* startRun(f.session, next, "running");
        expect(yield* workflows.requestNewGoal(f.session, next, transition(f.old))).toEqual({
          status: "accepted",
          runId: next,
        });
      }),
  );

  it.effect("a kanban Goal edit keeps the phase while the cards are sorted again", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const { workflows, session, old } = yield* env.use(withHistory());
      yield* workflows.setPhase(session, "execute");
      yield* sqlRun(
        `INSERT INTO kanban_goals (goal_instance_id, session_id, project_id, project_root, mode,
           goal_version, status, created_at, updated_at)
         VALUES (?, ?, 'p1', '/tmp/p1', 'sequential', 1, 'active', 1, 1)`,
        old,
        session,
      );
      const edited = yield* workflows.updateGoal(session, { ...goal, statement: "revised" });
      expect(edited.phase).toBe("execute");
      expect(yield* workflows.display(session, edited)).toBe("card_reclassifying");
    }),
  );
});

// Compatible code rollback only disables the new action, retaining the pointer and history.
layer(
  Workflows.layerWithOptions({ allowNewGoal: false }).pipe(Layer.provideMerge(TestEnv.layer())),
  { excludeTestServices: true },
)("new Goal transition disabled by rollback", (it) => {
  it.effect("refuses the action and keeps the current identity and history", () =>
    Effect.gen(function* () {
      const { workflows, session, old } = yield* withHistory();
      const before = yield* snapshot(session);
      expect(yield* Effect.flip(workflows.startNewGoal(session, transition(old)))).toMatchObject({
        reason: "disabled",
      });
      expect(yield* identity(session)).toBe(old);
      expect(yield* rows("goalInstances", session)).toHaveLength(1);
      yield* expectHistoryKept(session, before);
      expect(yield* rows("revisions", session)).toEqual(before[0]);
    }),
  );
});
