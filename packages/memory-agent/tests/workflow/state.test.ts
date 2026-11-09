import { Deferred, Effect, Fiber, Result, Schema } from "effect";
import { SqlClient, SqlError } from "effect/sql";
import { expect, vi } from "vite-plus/test";
import { AgentChat } from "../../src/agent/chat.ts";
import { AppEvents } from "../../src/events/app-events.ts";
import {
  evaluateWorkflowAction,
  WorkflowActionRequest,
  workflowActions,
} from "../../src/workflow/actions.ts";
import { WorkflowTools } from "../../src/workflow/tools.ts";
import { PlanDependencyIssue } from "../../src/workflow/plan-schedule.ts";
import {
  WorkflowStorageError,
  Workflows,
  type WorkflowState,
} from "../../src/workflow/workflow.ts";
import type { JsonValue } from "../../src/json.ts";
import { TestEnv, freshSession, testAgent } from "../support/test-env.ts";
import { callTool } from "../support/run-tools.ts";
import { sqlAll, sqlRun, sqlExec } from "../support/sql.ts";
import { storeWorkflowState } from "../support/workflow-state.ts";
import { revisionStateSql } from "../../src/workflow/state-rows.ts";

const goal = {
  statement: "Ship a durable planning workflow",
  outcomes: [{ id: "O1", text: "A plan survives reloads" }],
  constraints: ["Keep prompts thin"],
  nonGoals: ["Automatic execution"],
  assumptions: ["A session owns one active workflow"],
  openQuestions: [],
  status: "active" as const,
};

const plan = {
  summary: "Persist and expose workflow artifacts",
  steps: [
    {
      id: "store",
      title: "Store artifacts",
      description: "Persist versioned state outside the transcript",
      dependsOn: [],
      acceptanceCriteria: ["State survives a process restart"],
      ruleRefs: ["workflow.thin-context"],
    },
  ],
  risks: [],
  openQuestions: [],
  status: "ready" as const,
};

const noProgress = { steps: [], goalEvidence: [], planEvidence: [] };

/** Goal and ready Plan recorded, with Execute started. */
const executing = Effect.fnUntraced(function* (sessionId: string) {
  const workflows = yield* Workflows;
  yield* workflows.updateGoal(sessionId, goal);
  yield* workflows.updatePlan(sessionId, plan);
  return yield* workflows.setPhase(sessionId, "execute");
});

/** Every step completed and the Execute run finished, so the workflow is in Verify. */
const verifying = Effect.fnUntraced(function* (sessionId: string) {
  const workflows = yield* Workflows;
  yield* executing(sessionId);
  yield* workflows.updateProgress(sessionId, {
    ...noProgress,
    steps: [{ id: "store", status: "completed", evidence: ["implementation evidence"] }],
    detail: "Implementation complete",
  });
  return yield* workflows.finishRun(sessionId, "execute");
});

/** The session's run, still running as the owner records it; every tool of a test comes from it. */
const startRun = Effect.fnUntraced(function* (sessionId: string) {
  const runId = `${sessionId}:run`;
  yield* sqlRun(
    "INSERT OR IGNORE INTO chat_runs (run_id, thread_id, status, started_at) VALUES (?, ?, 'running', 1)",
    runId,
    sessionId,
  );
  return runId;
});

/** The workflow tool `name` of `phase`, called as the model would from the session's run. */
const workflowTool = Effect.fnUntraced(function* (
  sessionId: string,
  phase: WorkflowState["phase"],
  name: string,
) {
  const tools = (yield* WorkflowTools).toolsFor(sessionId, phase, yield* startRun(sessionId));
  return (input: JsonValue) => callTool(tools, name, input);
});

testAgent()("Workflows", (it) => {
  it.effect("versions artifacts and starts a ready Plan on Execute", () =>
    Effect.gen(function* () {
      const id = yield* freshSession;
      const workflows = yield* Workflows;
      yield* workflows.setPhase(id, "goal");
      yield* workflows.updateGoal(id, goal);
      yield* workflows.setPhase(id, "plan");
      yield* workflows.updatePlan(id, plan);
      const state = yield* workflows.setPhase(id, "execute");
      expect(state.phase).toBe("execute");
      expect(state.goal).toMatchObject({ version: 1, status: "active" });
      expect(state.plan).toMatchObject({ version: 1, goalVersion: 1, status: "executing" });
      expect(state.ledger.map((event) => event.kind)).toEqual([
        "phase_changed",
        "goal_updated",
        "phase_changed",
        "plan_updated",
        "phase_changed",
      ]);
    }),
  );

  it.effect("reads outcomes saved without ids as O1, O2, … in order", () =>
    Effect.gen(function* () {
      const id = yield* freshSession;
      const workflows = yield* Workflows;
      yield* workflows.updateGoal(id, goal);
      const saved = yield* workflows.get(id);
      yield* storeWorkflowState(
        id,
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
          ...saved,
          goal: { ...saved.goal, outcomes: ["first", "second"] },
        }),
      );
      expect((yield* workflows.get(id)).goal?.outcomes).toEqual([
        { id: "O1", text: "first" },
        { id: "O2", text: "second" },
      ]);
    }),
  );

  it.effect("refuses a Goal that names two outcomes with one id", () =>
    Effect.gen(function* () {
      const id = yield* freshSession;
      const updateGoal = yield* workflowTool(id, "goal", "update_goal");
      const failure = yield* Effect.flip(
        updateGoal({
          ...goal,
          outcomes: [
            { id: "O1", text: "one" },
            { id: "O1", text: "two" },
          ],
        }),
      );
      expect(failure.message).toContain("each outcome id is used once");
      expect((yield* (yield* Workflows).get(id)).goal).toBeNull();
    }),
  );

  it.effect("rejects a Plan with invalid dependencies without saving it", () =>
    Effect.gen(function* () {
      const id = yield* freshSession;
      const workflows = yield* Workflows;
      yield* workflows.updateGoal(id, goal);
      const failure = yield* Effect.flip(
        workflows.updatePlan(id, {
          ...plan,
          steps: plan.steps.map((step) => ({ ...step, dependsOn: ["missing"] })),
        }),
      );
      expect(failure).toMatchObject({
        issues: [
          PlanDependencyIssue.cases.UnknownDependency.make({
            stepId: "store",
            dependsOn: "missing",
          }),
        ],
      });
      expect((yield* workflows.get(id)).plan).toBeNull();
    }),
  );

  it.effect("refuses Execute until a Plan is ready", () =>
    Effect.gen(function* () {
      const id = yield* freshSession;
      const result = yield* Effect.result((yield* Workflows).setPhase(id, "execute"));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result))
        expect(result.failure).toMatchObject({ reason: "plan_not_ready" });
    }),
  );

  it.effect("returns Execute to Plan when the Plan is revised", () =>
    Effect.gen(function* () {
      const id = yield* freshSession;
      yield* executing(id);
      const state = yield* (yield* Workflows).updatePlan(id, {
        ...plan,
        summary: "Revised execution scope",
      });
      expect(state.phase).toBe("plan");
      expect(state.plan).toMatchObject({
        version: 2,
        status: "ready",
        summary: "Revised execution scope",
        steps: [{ status: "ready", evidence: [] }],
      });
      expect(state.ledger.slice(-2)).toMatchObject([
        { kind: "plan_replanned", detail: "plan v2 (ready)" },
        { kind: "phase_changed", detail: "execute -> plan (plan revised)" },
      ]);
      expect(state.ledger.at(-1)?.sequence).toBe(state.ledger.at(-2)!.sequence + 1);
    }),
  );

  it.effect("keeps the progress of steps a replan leaves unchanged", () =>
    Effect.gen(function* () {
      const id = yield* freshSession;
      const workflows = yield* Workflows;
      yield* executing(id);
      yield* workflows.updateProgress(id, {
        ...noProgress,
        steps: [{ id: "store", status: "completed", evidence: ["stored"] }],
        detail: "store done",
      });
      const [store] = plan.steps;
      const expose = {
        ...store!,
        id: "expose",
        title: "Expose artifacts",
        dependsOn: ["store"],
      };
      const kept = yield* workflows.updatePlan(id, { ...plan, steps: [store!, expose] });
      expect(kept.plan?.steps).toMatchObject([
        { id: "store", status: "done", evidence: ["stored"] },
        { id: "expose", status: "ready", evidence: [] },
      ]);
      // A step whose fields change starts over.
      const changed = yield* workflows.updatePlan(id, {
        ...plan,
        steps: [{ ...store!, description: "Persist elsewhere" }, expose],
      });
      expect(changed.plan?.steps).toMatchObject([
        { id: "store", status: "ready", evidence: [] },
        { id: "expose", status: "backlog", evidence: [] },
      ]);
    }),
  );

  it.effect("edits some steps through edit_plan as one next version", () =>
    Effect.gen(function* () {
      const id = yield* freshSession;
      const workflows = yield* Workflows;
      yield* executing(id);
      yield* workflows.updateProgress(id, {
        ...noProgress,
        steps: [{ id: "store", status: "completed", evidence: ["stored"] }],
        detail: "store done",
      });
      const editPlan = yield* workflowTool(id, "execute", "edit_plan");
      const step = {
        title: "Expose artifacts",
        description: "Show the Plan on the page",
        dependsOn: ["store"],
        acceptanceCriteria: ["The page shows the Plan"],
        ruleRefs: [],
      };
      expect(
        yield* editPlan({
          planVersion: 1,
          edits: [
            { action: "add", step: { ...step, id: "expose" } },
            { action: "add", step: { ...step, id: "docs", dependsOn: ["expose"] }, index: 0 },
            { action: "edit", stepId: "expose", patch: { title: "Expose the Plan" } },
            { action: "move", stepId: "docs", index: 2 },
          ],
        }),
      ).toMatchObject({
        phase: "execute",
        plan: {
          version: 2,
          steps: [
            { id: "store", status: "done", evidence: ["stored"] },
            { id: "expose", title: "Expose the Plan", status: "ready" },
            { id: "docs", status: "backlog" },
          ],
        },
      });
      // A refused edit saves none of the call's edits.
      expect(
        yield* editPlan({
          planVersion: 2,
          edits: [
            { action: "remove", stepId: "docs" },
            { action: "edit", stepId: "store", patch: { title: "Changed" } },
          ],
        }),
      ).toEqual({ error: "plan_edit_refused", reason: "card_finished" });
      expect(
        yield* editPlan({ planVersion: 1, edits: [{ action: "remove", stepId: "docs" }] }),
      ).toEqual({ error: "plan_edit_refused", reason: "plan_version_conflict" });
      expect((yield* workflows.get(id)).plan).toMatchObject({
        version: 2,
        steps: [{ id: "store" }, { id: "expose" }, { id: "docs" }],
      });
    }),
  );

  it.effect("rejects stale execution progress after a Plan revision, also through the tool", () =>
    Effect.gen(function* () {
      const id = yield* freshSession;
      const workflows = yield* Workflows;
      yield* executing(id);
      const progressTool = yield* workflowTool(id, "execute", "update_workflow_progress");
      yield* workflows.updatePlan(id, { ...plan, summary: "Revised execution scope" });
      const stale = {
        ...noProgress,
        planStatus: "executing" as const,
        detail: "stale Execute tool call",
      };
      const progress = yield* Effect.result(workflows.updateProgress(id, stale));
      expect(Result.isFailure(progress)).toBe(true);
      if (Result.isFailure(progress))
        expect(progress.failure).toMatchObject({ reason: "phase_not_executable" });
      expect(yield* workflows.get(id)).toMatchObject({
        phase: "plan",
        plan: { version: 2, status: "ready" },
      });
      // The model sees a typed refusal rather than a generic execution error.
      expect(yield* progressTool(stale)).toEqual({
        error: "workflow_progress_refused",
        reason: "phase_not_executable",
      });
    }),
  );

  it.effect("keeps an older Plan visibly tied to its Goal version", () =>
    Effect.gen(function* () {
      const id = yield* freshSession;
      const workflows = yield* Workflows;
      yield* workflows.updateGoal(id, goal);
      yield* workflows.updatePlan(id, plan);
      const state = yield* workflows.updateGoal(id, { ...goal, statement: "Changed goal" });
      expect(state.goal?.version).toBe(2);
      expect(state.plan?.goalVersion).toBe(1);
      const execute = yield* Effect.result(workflows.setPhase(id, "execute"));
      expect(Result.isFailure(execute)).toBe(true);
      if (Result.isFailure(execute))
        expect(execute.failure).toMatchObject({ reason: "plan_outdated" });
    }),
  );

  it.effect("does not lose versions under concurrent updates", () =>
    Effect.gen(function* () {
      const id = yield* freshSession;
      const workflows = yield* Workflows;
      const count = 24;
      yield* Effect.forEach(
        Array.from({ length: count }, (_, index) => index + 1),
        (n) => workflows.updateGoal(id, { ...goal, statement: `Concurrent goal ${n}` }),
        { concurrency: "unbounded" },
      );
      const state = yield* workflows.get(id);
      expect(state.goal?.version).toBe(count);
      const goalEvents = state.ledger.filter((event) => event.kind === "goal_updated");
      expect(goalEvents.map((event) => event.sequence)).toEqual(
        Array.from({ length: count }, (_, index) => index + 1),
      );
    }),
  );

  it.effect("finishes a Workflows call made inside an open transaction", () =>
    Effect.gen(function* () {
      const id = yield* freshSession;
      const workflows = yield* Workflows;
      const sql = yield* SqlClient.SqlClient;
      const opened = yield* Deferred.make<void>();
      // Another caller for the same session, waiting for the one connection.
      const other = yield* Effect.forkChild(
        Effect.andThen(Deferred.await(opened), workflows.updateGoal(id, goal)),
      );
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* Deferred.succeed(opened, undefined);
            yield* Effect.sleep("50 millis");
            yield* workflows.updateGoal(id, goal);
          }),
        )
        .pipe(Effect.timeout("2 seconds"));
      yield* Fiber.join(other);
      expect((yield* workflows.get(id)).goal?.version).toBe(2);
    }),
  );

  it.effect("records immutable full-state revisions and keeps one Goal identity", () =>
    Effect.gen(function* () {
      const id = yield* freshSession;
      const workflows = yield* Workflows;
      const revisions = () =>
        sqlAll(
          `SELECT r.*, ${revisionStateSql("r")} AS state_json FROM workflow_state_revisions r
           WHERE r.session_id = ? ORDER BY r.id`,
          id,
        );
      yield* workflows.updateGoal(id, goal);
      yield* workflows.updatePlan(id, plan);
      const original = yield* revisions();
      expect(original).toHaveLength(2);
      const goalId = original[0]?.goal_instance_id;
      expect(goalId).toEqual(expect.any(String));
      const previous = String(original[1]?.state_json);
      yield* workflows.updateProgress(id, {
        ...noProgress,
        goalEvidence: ["observed old criterion"],
        planEvidence: ["old approach"],
        detail: "Document baseline",
      });
      // A method-only Plan revision and a Goal revision both keep the Goal identity.
      yield* workflows.updatePlan(id, { ...plan, summary: "Another method" });
      yield* workflows.updateGoal(id, { ...goal, outcomes: [{ id: "O1", text: "New outcome" }] });
      yield* workflows.updatePlan(id, { ...plan, summary: "New method" });
      const rows = yield* revisions();
      expect(rows.map((row) => [row.goal_version, row.plan_version])).toEqual([
        [1, null],
        [1, 1],
        [1, 1],
        [1, 2],
        [2, 2],
        [2, 3],
      ]);
      expect(rows.every((row) => row.goal_instance_id === goalId)).toBe(true);
      expect(rows[1]?.state_json).toBe(previous);
      const decode = Schema.decodeEffect(Schema.fromJsonString(RevisionState));
      expect((yield* decode(String(rows[2]?.state_json))).goal.evidence).toEqual([
        "observed old criterion",
      ]);
      const latest = yield* decode(String(rows.at(-1)?.state_json));
      expect(latest.goal).toMatchObject({
        version: 2,
        outcomes: [{ id: "O1", text: "New outcome" }],
        evidence: [],
      });
      expect(latest.plan).toMatchObject({ version: 3, goalVersion: 2 });
      const rewrite = yield* Effect.flip(
        sqlRun("UPDATE workflow_state_revisions SET phase = 'plan' WHERE id = ?", rows[0]!.id),
      );
      expect(String(rewrite.reason.cause)).toContain("workflow revisions are immutable");
      const reworded = yield* Effect.flip(
        sqlRun("UPDATE workflow_ledger_events SET detail = '' WHERE session_id = ?", id),
      );
      expect(String(reworded.reason.cause)).toContain("workflow ledger events are immutable");
    }),
  );

  it.effect("records step evidence and requires passed verification before completion", () =>
    Effect.gen(function* () {
      const id = yield* freshSession;
      const workflows = yield* Workflows;
      yield* executing(id);
      const run = yield* startRun(id);
      yield* workflows.updateProgress(
        id,
        {
          ...noProgress,
          steps: [{ id: "store", status: "completed", evidence: ["workflow.test.ts passed"] }],
          planEvidence: ["State persisted after reload"],
          detail: "Completed the storage step",
        },
        run,
      );
      const staged = yield* workflows.updateProgress(
        id,
        {
          ...noProgress,
          goalStatus: "completed",
          planStatus: "completed",
          goalEvidence: ["The requested workflow is available"],
          verification: {
            status: "passed",
            summary: "The workflow persists and reloads",
            evidence: ["24 workflow assertions passed"],
          },
          detail: "Verification passed",
        },
        run,
      );
      // The running run's completion waits until the run ends.
      expect(staged).toMatchObject({
        phase: "execute",
        goal: { status: "active" },
        plan: { status: "executing" },
      });
      yield* sqlRun("UPDATE chat_runs SET status = 'completed' WHERE run_id = ?", run);
      yield* workflows.finishRun(id, "execute");
      const state = yield* workflows.finishRun(id, "verify");
      expect(state.goal).toMatchObject({ status: "completed", verification: { status: "passed" } });
      expect(state.plan).toMatchObject({
        status: "completed",
        verification: { status: "passed" },
        steps: [{ id: "store", status: "done", evidence: ["workflow.test.ts passed"] }],
      });
      // The finished runs take the completed Plan out of Execute, so 0.0.17's stuck phase cannot recur.
      expect(state.phase).toBe("completed");
    }),
  );

  it.effect("refuses unsupported completion claims and steps without evidence", () =>
    Effect.gen(function* () {
      const id = yield* freshSession;
      const workflows = yield* Workflows;
      yield* workflows.updateGoal(id, goal);
      const claim = yield* Effect.result(
        workflows.updateProgress(id, {
          ...noProgress,
          goalStatus: "completed",
          verification: { status: "passed", summary: "Claimed success", evidence: [] },
          detail: "Tried to complete without evidence",
        }),
      );
      expect(Result.isFailure(claim)).toBe(true);
      if (Result.isFailure(claim))
        expect(claim.failure).toMatchObject({ reason: "verification_required" });
      yield* workflows.updatePlan(id, plan);
      const step = yield* Effect.result(
        workflows.updateProgress(id, {
          ...noProgress,
          steps: [{ id: "store", status: "completed", evidence: [] }],
          detail: "Claimed the step was done",
        }),
      );
      expect(Result.isFailure(step)).toBe(true);
      if (Result.isFailure(step))
        expect(step.failure).toMatchObject({ reason: "step_evidence_required" });
    }),
  );

  it.effect("records pause, resume and stop as durable Goal lifecycle events", () =>
    Effect.gen(function* () {
      const id = yield* freshSession;
      const workflows = yield* Workflows;
      yield* workflows.setPhase(id, "goal");
      yield* workflows.updateGoal(id, goal);
      yield* workflows.updateProgress(id, {
        ...noProgress,
        goalStatus: "paused",
        detail: "Paused by the user",
      });
      const resumed = yield* workflows.updateProgress(id, {
        ...noProgress,
        goalStatus: "active",
        detail: "Resumed by the user",
      });
      expect(resumed.goal?.status).toBe("active");
      yield* workflows.controlGoal(id, "pause");
      yield* workflows.controlGoal(id, "resume");
      const stopped = yield* workflows.controlGoal(id, "stop");
      expect(stopped.goal?.status).toBe("failed");
      expect(stopped.ledger.slice(-5).map((event) => event.kind)).toEqual([
        "goal_paused",
        "goal_resumed",
        "goal_paused",
        "goal_resumed",
        "workflow_stopped",
      ]);
    }),
  );

  it.effect("keeps Execute active while any Plan step lacks completion evidence", () =>
    Effect.gen(function* () {
      const id = yield* freshSession;
      yield* executing(id);
      const state = yield* (yield* Workflows).finishRun(id, "execute");
      expect(state.phase).toBe("execute");
      expect(state.plan?.steps[0]?.status).toBe("ready");
    }),
  );

  it.effect("reconciles a stale Verify with unfinished steps back to Execute", () =>
    Effect.gen(function* () {
      const id = yield* freshSession;
      const workflows = yield* Workflows;
      yield* executing(id);
      yield* workflows.setPhase(id, "verify");
      const state = yield* workflows.reconcile(id);
      expect(state.phase).toBe("execute");
      expect(state.ledger.at(-1)?.detail).toBe("verify -> execute (state reconciled)");
    }),
  );

  it.effect("reconciles completed Execute work to Verify before the next turn", () =>
    Effect.gen(function* () {
      const id = yield* freshSession;
      const workflows = yield* Workflows;
      yield* executing(id);
      yield* workflows.updateProgress(id, {
        ...noProgress,
        steps: [{ id: "store", status: "completed", evidence: ["workflow test passed"] }],
        detail: "Implementation complete",
      });
      const state = yield* workflows.reconcile(id);
      expect(state.phase).toBe("verify");
      expect(state.ledger.at(-1)?.detail).toBe("execute -> verify (state reconciled)");
    }),
  );

  it.effect("advances Execute to Verify only after every step has completion evidence", () =>
    Effect.gen(function* () {
      const id = yield* freshSession;
      const state = yield* verifying(id);
      expect(state.phase).toBe("verify");
      expect(state.plan?.status).toBe("executing");
      expect(state.ledger.at(-1)).toMatchObject({
        kind: "phase_changed",
        detail: "execute -> verify",
      });
    }),
  );

  it.effect("completes verified artifacts once after the Verify run", () =>
    Effect.gen(function* () {
      const id = yield* freshSession;
      const workflows = yield* Workflows;
      yield* verifying(id);
      yield* workflows.updateProgress(id, {
        ...noProgress,
        verification: {
          status: "passed",
          summary: "Acceptance criteria passed",
          evidence: ["workflow test passed"],
        },
        detail: "Verification passed",
      });
      const completed = yield* workflows.finishRun(id, "verify");
      const repeated = yield* workflows.finishRun(id, "verify");
      expect(completed.phase).toBe("completed");
      expect(completed.goal).toMatchObject({
        status: "completed",
        verification: { status: "passed" },
      });
      expect(completed.plan).toMatchObject({
        status: "completed",
        verification: { status: "passed" },
      });
      expect(repeated).toEqual(completed);
      expect(
        repeated.ledger.filter((event) => event.detail === "Verification completed the workflow"),
      ).toHaveLength(1);
    }),
  );

  it.effect.each([
    { verification: { status: "failed" }, phase: "execute", invalidated: false },
    { verification: { status: "invalid_criterion" }, phase: "plan", invalidated: true },
    { verification: { status: "inconclusive" }, phase: "plan", invalidated: false },
    {
      verification: { status: "invalid_hypothesis", recoveryPhase: "goal" },
      phase: "goal",
      invalidated: true,
    },
  ] as const)("routes $verification.status verification to $phase", (expected) =>
    Effect.gen(function* () {
      const id = yield* freshSession;
      const workflows = yield* Workflows;
      const { status } = expected.verification;
      yield* verifying(id);
      yield* workflows.updateProgress(id, {
        ...noProgress,
        verification: {
          ...expected.verification,
          summary: `Verification ended as ${status}`,
          evidence: ["diagnostic evidence"],
        },
        detail: `Recorded ${status}`,
      });
      const state = yield* workflows.finishRun(id, "verify");
      expect(state.phase).toBe(expected.phase);
      expect(state.goal?.status).toBe("active");
      expect(state.plan?.status).toBe("executing");
      expect(state.ledger.at(-1)).toMatchObject({
        kind: "phase_changed",
        detail: `verify -> ${expected.phase} (${status})`,
      });
      if (expected.invalidated) expect(state.ledger.at(-2)?.kind).toBe("verification_invalidated");
    }),
  );

  it.effect("keeps a confirmed external block in Verify and marks the Plan blocked", () =>
    Effect.gen(function* () {
      const id = yield* freshSession;
      const workflows = yield* Workflows;
      yield* verifying(id);
      yield* workflows.updateProgress(id, {
        ...noProgress,
        verification: {
          status: "blocked",
          summary: "A real account login is required",
          evidence: ["The provider returned an authentication challenge"],
        },
        detail: "Waiting for the user to authenticate",
      });
      const state = yield* workflows.finishRun(id, "verify");
      expect(state.phase).toBe("verify");
      expect(state.plan?.status).toBe("blocked");
      expect(state.plan?.verification.status).toBe("blocked");
    }),
  );

  it.effect("does not route a verification outcome without evidence", () =>
    Effect.gen(function* () {
      const id = yield* freshSession;
      const workflows = yield* Workflows;
      yield* verifying(id);
      yield* workflows.updateProgress(id, {
        ...noProgress,
        verification: {
          status: "invalid_criterion",
          summary: "Unsupported invalidation claim",
          evidence: [],
        },
        detail: "Tried to invalidate without evidence",
      });
      expect((yield* workflows.finishRun(id, "verify")).phase).toBe("verify");
    }),
  );
});

testAgent()("WorkflowTools live refresh", (it) => {
  it.effect.each(["execute", "verify"] as const)(
    "%s can synchronize authorized Goal changes without executing the stale Plan",
    (phase) =>
      Effect.gen(function* () {
        const id = yield* freshSession;
        const workflows = yield* Workflows;
        if (phase === "execute") yield* executing(id);
        else yield* verifying(id);
        const before = yield* workflows.get(id);
        expect(before.phase).toBe(phase);
        const identity = yield* workflows.goalInstanceId(id);
        const updateGoal = yield* workflowTool(id, phase, "update_goal");
        const progress = yield* workflowTool(id, phase, "update_workflow_progress");
        expect(yield* updateGoal({ ...goal, nonGoals: [] })).toMatchObject({
          phase: "plan",
          goal: { version: 2, nonGoals: [] },
          goalInstanceId: identity,
        });
        const revised = yield* workflows.get(id);
        expect(revised.plan).toEqual(before.plan);
        expect(revised.goal?.verification.status).toBe("not_run");
        expect(revised.ledger.at(-1)).toMatchObject({
          kind: "phase_changed",
          detail: `${phase} -> plan (goal revised)`,
        });
        expect(
          yield* progress({
            ...noProgress,
            steps: [{ id: "store", status: "in_progress", evidence: [] }],
            detail: "Stale execution",
          }),
        ).toEqual({ error: "workflow_progress_refused", reason: "phase_not_executable" });
        expect(yield* workflows.get(id)).toEqual(revised);
        yield* workflows.updatePlan(id, plan);
        expect((yield* workflows.get(id)).plan?.goalVersion).toBe(2);
        expect((yield* workflows.setPhase(id, "execute")).phase).toBe("execute");
      }),
  );

  it.effect.each(["update_goal", "update_plan", "update_workflow_progress"])(
    "%s publishes run-state after persisting the artifact",
    (name) =>
      Effect.gen(function* () {
        const { project } = yield* TestEnv;
        const id = yield* freshSession;
        const workflows = yield* Workflows;
        yield* executing(id);
        const events = yield* AppEvents;
        const beforeRevision = yield* events.revision;
        const persistedAtPublish: unknown[] = [];
        const published: unknown[] = [];
        const publishSession = events.publishSession;
        const publish = vi.spyOn(events, "publishSession").mockImplementation((sessionId, topic) =>
          workflows.get(sessionId).pipe(
            Effect.orDie,
            Effect.tap((state) => Effect.sync(() => persistedAtPublish.push(state))),
            Effect.andThen(publishSession(sessionId, topic)),
            Effect.tap((event) => Effect.sync(() => published.push(event))),
          ),
        );
        yield* Effect.addFinalizer(() => Effect.sync(() => publish.mockRestore()));
        const tool = yield* workflowTool(id, name === "update_goal" ? "goal" : "execute", name);
        const input =
          name === "update_goal"
            ? { ...goal, statement: "Revised goal" }
            : name === "update_plan"
              ? { ...plan, summary: "Revised plan" }
              : {
                  ...noProgress,
                  steps: [{ id: "store", status: "in_progress", evidence: [] }],
                  detail: "Started implementation",
                };
        const result = yield* tool(input);
        const state = yield* workflows.get(id);
        expect(publish).toHaveBeenCalledExactlyOnceWith(id, "run-state");
        expect(published).toEqual([
          {
            scope: "session",
            projectId: project.id,
            sessionId: id,
            topic: "run-state",
            revision: beforeRevision + 1,
          },
        ]);
        expect(persistedAtPublish).toEqual([state]);
        expect(result).toMatchObject({ phase: state.phase });
        expect(state.goal?.version).toBe(name === "update_goal" ? 2 : 1);
        expect(state.plan?.version).toBe(name === "update_plan" ? 2 : 1);
        if (name === "update_goal") expect(state.goal?.statement).toBe("Revised goal");
        if (name === "update_plan") expect(state.plan?.summary).toBe("Revised plan");
        if (name === "update_workflow_progress")
          expect(state.plan?.steps[0]?.status).toBe("in_progress");
      }),
  );

  it.effect("rejected progress does not publish a successful mutation event", () =>
    Effect.gen(function* () {
      const id = yield* freshSession;
      const workflows = yield* Workflows;
      yield* workflows.updateGoal(id, goal);
      yield* workflows.updatePlan(id, plan);
      const before = yield* workflows.setPhase(id, "plan");
      const events = yield* AppEvents;
      const beforeRevision = yield* events.revision;
      const publish = vi.spyOn(events, "publishSession");
      yield* Effect.addFinalizer(() => Effect.sync(() => publish.mockRestore()));
      const progress = yield* workflowTool(id, "execute", "update_workflow_progress");
      expect(
        yield* progress({ ...noProgress, planStatus: "executing", detail: "Stale progress" }),
      ).toEqual({ error: "workflow_progress_refused", reason: "phase_not_executable" });
      expect(publish).not.toHaveBeenCalled();
      expect(yield* events.revision).toBe(beforeRevision);
      expect(yield* workflows.get(id)).toEqual(before);
    }),
  );
});

testAgent()("server workflow action policy", (it) => {
  it.effect(
    "advertised decisions match serialized persisted mutations across lifecycle states",
    () =>
      Effect.gen(function* () {
        const id = yield* freshSession;
        const workflows = yield* Workflows;
        yield* workflows.updateGoal(id, goal);
        const state = yield* workflows.updatePlan(id, plan);
        const states: WorkflowState[] = [
          { ...state, goal: null, plan: null },
          { ...state, plan: null },
          ...(["draft", "active", "paused", "completed", "failed"] as const).map((status) => ({
            ...state,
            goal: { ...state.goal!, status },
          })),
          ...(["draft", "ready", "executing", "completed", "blocked"] as const).map((status) => ({
            ...state,
            plan: { ...state.plan!, status },
          })),
          { ...state, goal: { ...state.goal!, version: 2 } },
          { ...state, phase: "plan", plan: { ...state.plan!, status: "executing" } },
          { ...state, phase: "verify", plan: { ...state.plan!, status: "executing" } },
        ];
        // The ledger goes on from the stored one, as a saved state's does.
        const reset = (current: WorkflowState) =>
          Effect.flatMap(workflows.get(id), ({ ledger }) => {
            const stored = { ...current, ledger };
            return Effect.as(storeWorkflowState(id, JSON.stringify(stored)), stored);
          });
        // Each advertised decision must match what the server does with the same persisted state.
        const matches = Effect.fnUntraced(function* <A, E>(
          current: WorkflowState,
          decision: ReturnType<typeof workflowActions>["phases"]["chat"],
          attempt: Effect.Effect<A, E>,
        ) {
          const stored = yield* reset(current);
          const result = yield* Effect.result(attempt);
          expect(Result.isSuccess(result)).toBe(decision.allowed);
          if (!decision.allowed && Result.isFailure(result))
            expect(result.failure).toMatchObject({ reason: decision.reason });
          if (!decision.allowed) expect(yield* workflows.get(id)).toEqual(stored);
        });
        yield* Effect.forEach(
          states,
          Effect.fnUntraced(function* (current) {
            const advertised = workflowActions(current);
            yield* Effect.forEach(
              ["chat", "goal", "plan", "execute", "verify"] as const,
              (phase) => matches(current, advertised.phases[phase], workflows.setPhase(id, phase)),
              { discard: true },
            );
            yield* Effect.forEach(
              ["pause", "resume", "stop"] as const,
              (action) =>
                matches(current, advertised.controls[action], workflows.controlGoal(id, action)),
              { discard: true },
            );
          }),
          { discard: true },
        );
      }),
  );

  it.effect("keeps Plan + executing resumable without resetting progress", () =>
    Effect.gen(function* () {
      const id = yield* freshSession;
      const workflows = yield* Workflows;
      yield* executing(id);
      const state = yield* workflows.setPhase(id, "plan");
      expect(workflowActions(state).phases.execute).toEqual({ allowed: true, intent: "continue" });
      expect((yield* workflows.setPhase(id, "execute")).plan).toEqual(state.plan);
    }),
  );

  it.effect("running denies navigation and resume but preserves pause/stop cancellation", () =>
    Effect.gen(function* () {
      const id = yield* freshSession;
      const workflows = yield* Workflows;
      yield* workflows.updateGoal(id, goal);
      const state = yield* workflows.updatePlan(id, plan);
      const actions = workflowActions(state, { running: true, lease: { state: "mine" } });
      Object.values(actions.phases).forEach((decision) =>
        expect(decision).toEqual({ allowed: false, reason: "run_in_progress" }),
      );
      expect(actions.controls.resume).toEqual({ allowed: false, reason: "run_in_progress" });
      expect(actions.controls.pause.allowed).toBe(true);
      expect(actions.controls.stop.allowed).toBe(true);
      const held = workflowActions(state, { running: true, lease: { state: "other", since: 0 } });
      [...Object.values(held.phases), ...Object.values(held.controls)].forEach((decision) =>
        expect(decision).toEqual({ allowed: false, reason: "session_in_use" }),
      );
      expect(
        evaluateWorkflowAction(state, WorkflowActionRequest.phase({ phase: "execute" }), {
          lease: { state: "free" },
        }).allowed,
      ).toBe(true);
    }),
  );

  it.effect("GET exposes the same policy with the requesting page's lease", () =>
    Effect.gen(function* () {
      const id = yield* freshSession;
      const workflows = yield* Workflows;
      const agent = yield* AgentChat;
      yield* workflows.updateGoal(id, goal);
      yield* workflows.updatePlan(id, plan);
      yield* agent.lease(id, "owner", "claim");
      yield* Effect.forEach(
        ["owner", "observer"],
        Effect.fnUntraced(function* (holder) {
          const snapshot = yield* agent.status(id, holder);
          expect(snapshot.actions).toEqual(
            workflowActions(snapshot.workflow, {
              lease: snapshot.lease,
              running: snapshot.running !== null,
            }),
          );
          const changed = yield* Effect.result(agent.setWorkflowPhase(id, holder, "execute"));
          expect(Result.isSuccess(changed)).toBe(snapshot.actions.phases.execute.allowed);
        }),
        { discard: true },
      );
    }),
  );
});

// A failing snapshot trigger stays on this database, so the test owns its agent.
testAgent()("Workflows snapshot failure", (it) => {
  it.effect("rolls back a new Goal identity and current state if its evidence snapshot fails", () =>
    Effect.gen(function* () {
      const id = yield* freshSession;
      yield* sqlExec(`
        CREATE TRIGGER reject_workflow_revision BEFORE INSERT ON workflow_state_revisions
        BEGIN SELECT RAISE(ABORT, 'snapshot unavailable'); END;
      `);
      const failure = yield* Effect.flip((yield* Workflows).updateGoal(id, goal));
      expect(failure).toBeInstanceOf(WorkflowStorageError);
      expect(failure).toMatchObject({ cause: expect.any(SqlError.SqlError) });
      expect(
        yield* sqlAll("SELECT * FROM workflow_goal_identities WHERE session_id = ?", id),
      ).toEqual([]);
      expect(yield* sqlAll("SELECT * FROM session_workflows WHERE session_id = ?", id)).toEqual([]);
    }),
  );
});

const RevisionState = Schema.Struct({
  goal: Schema.Struct({
    version: Schema.Finite,
    outcomes: Schema.Array(Schema.Struct({ id: Schema.String, text: Schema.String })),
    evidence: Schema.Array(Schema.String),
  }),
  plan: Schema.Struct({ version: Schema.Finite, goalVersion: Schema.Finite }),
});
