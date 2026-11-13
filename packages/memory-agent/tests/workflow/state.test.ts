import { Deferred, Effect, Fiber, Result, Schema, Struct } from "effect";
import { SqlClient, SqlError } from "effect/sql";
import { expect, vi } from "vite-plus/test";
import { AgentChat } from "../../src/agent/chat.ts";
import { AppEvents } from "../../src/events/app-events.ts";
import {
  evaluateWorkflowAction,
  WorkflowActionRequest,
  workflowActions,
} from "../../src/workflow/actions.ts";
import { BoardAuthor } from "../../src/workflow/card.ts";
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
      outcomes: [],
    },
  ],
  risks: [],
  openQuestions: [],
  status: "ready" as const,
};

/** A state as a test stores it, in whatever shape a released version saved. */
const stateJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/** Goal and ready Plan recorded, and the Plan running. */
const executing = Effect.fnUntraced(function* (sessionId: string) {
  const workflows = yield* Workflows;
  yield* workflows.updateGoal(sessionId, goal);
  yield* workflows.updatePlan(sessionId, plan);
  return yield* workflows.move(sessionId, "run");
});

const orchestrator = BoardAuthor.cases.Orchestrator.make({ runId: "test" });

/** Moves the card through the board to done, as the orchestrator does. */
const finishCard = Effect.fnUntraced(function* (sessionId: string, cardId: string) {
  const workflows = yield* Workflows;
  yield* workflows.transitionCard(
    sessionId,
    { cardId, from: "ready", to: "in_progress" },
    orchestrator,
  );
  yield* workflows.transitionCard(
    sessionId,
    { cardId, from: "in_progress", to: "verify" },
    orchestrator,
  );
  return yield* workflows.transitionCard(
    sessionId,
    { cardId, from: "verify", to: "done" },
    orchestrator,
  );
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
  it.effect("versions artifacts and runs a ready Plan", () =>
    Effect.gen(function* () {
      const id = yield* freshSession;
      const workflows = yield* Workflows;
      yield* workflows.move(id, "goal");
      yield* workflows.updateGoal(id, goal);
      yield* workflows.move(id, "plan");
      yield* workflows.updatePlan(id, plan);
      const state = yield* workflows.move(id, "run");
      expect(state.phase).toBe("running");
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
      const updateGoal = yield* workflowTool(id, "shaping", "update_goal");
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

  it.effect("refuses Plan steps that name outcomes the Goal does not have", () =>
    Effect.gen(function* () {
      const id = yield* freshSession;
      const workflows = yield* Workflows;
      yield* workflows.updateGoal(id, goal);
      const updatePlan = yield* workflowTool(id, "shaping", "update_plan");
      const [store] = plan.steps;
      expect(
        yield* updatePlan({ ...plan, steps: [{ ...store!, outcomes: ["O1", "O9"] }] }),
      ).toEqual({
        error: "plan_outcomes_rejected",
        issues: ["step store names outcome O9, which the current Goal does not have"],
      });
      expect((yield* workflows.get(id)).plan).toBeNull();

      yield* workflows.updatePlan(id, plan);
      const runId = yield* startRun(id);
      const added = { ...store!, id: "expose", outcomes: ["O2"] };
      const refused = yield* Effect.flip(
        workflows.editPlan(
          id,
          { planVersion: 1, edits: [{ action: "add", step: added }] },
          BoardAuthor.cases.Orchestrator.make({ runId }),
        ),
      );
      expect(refused).toMatchObject({
        _tag: "PlanOutcomesRejected",
        unknown: [{ stepId: "expose", outcomeId: "O2" }],
      });
      yield* workflows.editPlan(
        id,
        { planVersion: 1, edits: [{ action: "add", step: { ...added, outcomes: ["O1"] } }] },
        BoardAuthor.cases.Orchestrator.make({ runId }),
      );

      // Once the Goal drops O1, its cards still take edits that do not name outcomes.
      yield* workflows.updateGoal(id, { ...goal, outcomes: [{ id: "O2", text: "Replaced" }] });
      const edited = yield* workflows.editPlan(
        id,
        { planVersion: 2, edits: [{ action: "edit", stepId: "expose", patch: { title: "Show" } }] },
        BoardAuthor.cases.Orchestrator.make({ runId }),
      );
      expect(edited.plan?.steps[1]).toMatchObject({
        id: "expose",
        title: "Show",
        outcomes: ["O1"],
      });
    }),
  );

  it.effect("reads steps saved before steps named outcomes as serving none", () =>
    Effect.gen(function* () {
      const id = yield* freshSession;
      const workflows = yield* Workflows;
      yield* workflows.updateGoal(id, goal);
      const saved = yield* workflows.updatePlan(id, plan);
      yield* storeWorkflowState(
        id,
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
          ...saved,
          plan: {
            ...saved.plan,
            steps: saved.plan?.steps.map((step) => Struct.omit(step, ["outcomes"])),
          },
        }),
      );
      expect((yield* workflows.get(id)).plan?.steps[0]?.outcomes).toEqual([]);
    }),
  );

  it.effect("refuses to run until a Plan is ready", () =>
    Effect.gen(function* () {
      const id = yield* freshSession;
      const result = yield* Effect.result((yield* Workflows).move(id, "run"));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result))
        expect(result.failure).toMatchObject({ reason: "plan_not_ready" });
    }),
  );

  it.effect("returns a running Plan to shaping when the Plan is revised", () =>
    Effect.gen(function* () {
      const id = yield* freshSession;
      yield* executing(id);
      const state = yield* (yield* Workflows).updatePlan(id, {
        ...plan,
        summary: "Revised execution scope",
      });
      expect(state.phase).toBe("shaping");
      expect(state.plan).toMatchObject({
        version: 2,
        status: "ready",
        summary: "Revised execution scope",
        steps: [{ status: "ready", evidence: [] }],
      });
      expect(state.ledger.slice(-2)).toMatchObject([
        { kind: "plan_replanned", detail: "plan v2 (ready)" },
        { kind: "phase_changed", detail: "running -> shaping (plan revised)" },
      ]);
      expect(state.ledger.at(-1)?.sequence).toBe(state.ledger.at(-2)!.sequence + 1);
    }),
  );

  it.effect("keeps the progress of steps a replan leaves unchanged", () =>
    Effect.gen(function* () {
      const id = yield* freshSession;
      const workflows = yield* Workflows;
      yield* executing(id);
      yield* finishCard(id, "store");
      const [store] = plan.steps;
      const expose = {
        ...store!,
        id: "expose",
        title: "Expose artifacts",
        dependsOn: ["store"],
      };
      const kept = yield* workflows.updatePlan(id, { ...plan, steps: [store!, expose] });
      expect(kept.plan?.steps).toMatchObject([
        { id: "store", status: "done" },
        { id: "expose", status: "ready" },
      ]);
      // Which outcomes a step serves is not its work: naming one keeps the step's progress.
      const tagged = yield* workflows.updatePlan(id, {
        ...plan,
        steps: [{ ...store!, outcomes: ["O1"] }, expose],
      });
      expect(tagged.plan?.steps).toMatchObject([
        { id: "store", outcomes: ["O1"], status: "done" },
        { id: "expose", status: "ready" },
      ]);
      // A step whose fields change starts over.
      const changed = yield* workflows.updatePlan(id, {
        ...plan,
        steps: [{ ...store!, description: "Persist elsewhere" }, expose],
      });
      expect(changed.plan?.steps).toMatchObject([
        { id: "store", status: "ready" },
        { id: "expose", status: "backlog" },
      ]);
    }),
  );

  it.effect("edits some steps through edit_plan as one next version", () =>
    Effect.gen(function* () {
      const id = yield* freshSession;
      const workflows = yield* Workflows;
      yield* executing(id);
      yield* finishCard(id, "store");
      const editPlan = yield* workflowTool(id, "running", "edit_plan");
      const step = {
        title: "Expose artifacts",
        description: "Show the Plan on the page",
        dependsOn: ["store"],
        acceptanceCriteria: ["The page shows the Plan"],
        ruleRefs: [],
        outcomes: [],
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
        phase: "running",
        plan: {
          version: 2,
          steps: [
            { id: "store", status: "done" },
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

  it.effect("edits parts of the Goal through edit_goal as one next version", () =>
    Effect.gen(function* () {
      const id = yield* freshSession;
      const workflows = yield* Workflows;
      yield* workflows.move(id, "goal");
      yield* workflows.updateGoal(id, goal);
      const editGoal = yield* workflowTool(id, "shaping", "edit_goal");
      expect(
        yield* editGoal({
          goalVersion: 1,
          edits: [
            { action: "add_outcome", outcome: { id: "O2", text: "The page shows the Plan" } },
            {
              action: "edit_item",
              list: "constraints",
              text: "Keep prompts thin",
              newText: "No prompt over 2KB",
            },
            { action: "remove_item", list: "nonGoals", text: "Automatic execution" },
            {
              action: "add_question",
              question: { id: "q1", question: "Which page?", blocking: false },
            },
            { action: "edit_question", questionId: "q1", blocking: true },
          ],
        }),
      ).toMatchObject({ phase: "shaping", goal: { version: 2, status: "active" } });
      expect((yield* workflows.get(id)).goal).toMatchObject({
        version: 2,
        statement: goal.statement,
        outcomes: [goal.outcomes[0], { id: "O2", text: "The page shows the Plan" }],
        constraints: ["No prompt over 2KB"],
        nonGoals: [],
        assumptions: goal.assumptions,
        openQuestions: [{ id: "q1", question: "Which page?", blocking: true }],
      });
      // A refused edit saves none of the call's edits and names its position.
      expect(
        yield* editGoal({
          goalVersion: 2,
          edits: [
            { action: "set_statement", statement: "Changed" },
            { action: "remove_outcome", outcomeId: "O9" },
          ],
        }),
      ).toEqual({ error: "goal_edit_refused", reason: "outcome_missing", edit: 1 });
      expect(
        yield* editGoal({ goalVersion: 1, edits: [{ action: "set_status", status: "draft" }] }),
      ).toEqual({ error: "goal_edit_refused", reason: "goal_version_conflict", edit: null });
      expect((yield* workflows.get(id)).goal).toMatchObject({
        version: 2,
        statement: goal.statement,
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
      const execute = yield* Effect.result(workflows.move(id, "run"));
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
      yield* workflows.transitionCard(
        id,
        { cardId: "store", from: "ready", to: "in_progress" },
        orchestrator,
      );
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

  it.effect("records pause, resume and stop as durable Goal lifecycle events", () =>
    Effect.gen(function* () {
      const id = yield* freshSession;
      const workflows = yield* Workflows;
      yield* workflows.move(id, "goal");
      yield* workflows.updateGoal(id, goal);
      yield* workflows.controlGoal(id, "pause");
      const resumed = yield* workflows.controlGoal(id, "resume");
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

  it.effect("reconciles a running phase whose Plan no longer runs back to shaping", () =>
    Effect.gen(function* () {
      const id = yield* freshSession;
      const workflows = yield* Workflows;
      const current = yield* executing(id);
      yield* storeWorkflowState(
        id,
        yield* stateJson({ ...current, plan: { ...current.plan, status: "ready" } }),
      );
      const state = yield* workflows.reconcile(id);
      expect(state.phase).toBe("shaping");
      expect(state.ledger.at(-1)?.detail).toBe("running -> shaping (state reconciled)");
    }),
  );

  it.effect("reads a phase saved before modes as its mode and place", () =>
    Effect.gen(function* () {
      const id = yield* freshSession;
      const workflows = yield* Workflows;
      const current = yield* executing(id);
      const stored = (phase: string) =>
        stateJson({ ...Struct.omit(current, ["mode"]), phase }).pipe(
          Effect.andThen((json) => storeWorkflowState(id, json)),
          Effect.andThen(workflows.get(id)),
          Effect.map(({ phase, mode }) => ({ phase, mode })),
        );
      expect(yield* stored("goal")).toEqual({ phase: "shaping", mode: "goal" });
      expect(yield* stored("plan")).toEqual({ phase: "shaping", mode: "plan" });
      expect(yield* stored("execute")).toEqual({ phase: "running", mode: "plan" });
      expect(yield* stored("verify")).toEqual({ phase: "running", mode: "plan" });
    }),
  );
});

testAgent()("WorkflowTools live refresh", (it) => {
  it.effect(
    "a running Plan synchronizes authorized Goal changes without running the stale Plan",
    () =>
      Effect.gen(function* () {
        const id = yield* freshSession;
        const workflows = yield* Workflows;
        yield* executing(id);
        const before = yield* workflows.get(id);
        expect(before.phase).toBe("running");
        const identity = yield* workflows.goalInstanceId(id);
        const updateGoal = yield* workflowTool(id, "running", "update_goal");
        expect(yield* updateGoal({ ...goal, nonGoals: [] })).toMatchObject({
          phase: "shaping",
          goal: { version: 2 },
          goalInstanceId: identity,
        });
        const revised = yield* workflows.get(id);
        expect(revised.goal?.nonGoals).toEqual([]);
        expect(revised.plan).toEqual(before.plan);
        expect(revised.goal?.verification.status).toBe("not_run");
        expect(revised.ledger.at(-1)).toMatchObject({
          kind: "phase_changed",
          detail: "running -> shaping (goal revised)",
        });
        yield* workflows.updatePlan(id, plan);
        expect((yield* workflows.get(id)).plan?.goalVersion).toBe(2);
        expect((yield* workflows.move(id, "run")).phase).toBe("running");
      }),
  );

  it.effect.each(["update_goal", "update_plan"])(
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
        const tool = yield* workflowTool(id, name === "update_goal" ? "shaping" : "running", name);
        const input =
          name === "update_goal"
            ? { ...goal, statement: "Revised goal" }
            : { ...plan, summary: "Revised plan" };
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
          { ...state, phase: "shaping", plan: { ...state.plan!, status: "executing" } },
          { ...state, phase: "running", plan: { ...state.plan!, status: "executing" } },
          { ...state, phase: "shaping", mode: "goal" },
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
          decision: ReturnType<typeof workflowActions>["moves"]["chat"],
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
              ["chat", "plan", "goal", "run"] as const,
              (move) => matches(current, advertised.moves[move], workflows.move(id, move)),
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
      const state = yield* workflows.move(id, "plan");
      expect(workflowActions(state).moves.run).toEqual({ allowed: true, intent: "continue" });
      expect((yield* workflows.move(id, "run")).plan).toEqual(state.plan);
    }),
  );

  it.effect("running denies navigation and resume but preserves pause/stop cancellation", () =>
    Effect.gen(function* () {
      const id = yield* freshSession;
      const workflows = yield* Workflows;
      yield* workflows.updateGoal(id, goal);
      const state = yield* workflows.updatePlan(id, plan);
      const actions = workflowActions(state, { running: true, lease: { state: "mine" } });
      Object.values(actions.moves).forEach((decision) =>
        expect(decision).toEqual({ allowed: false, reason: "run_in_progress" }),
      );
      expect(actions.controls.resume).toEqual({ allowed: false, reason: "run_in_progress" });
      expect(actions.controls.pause.allowed).toBe(true);
      expect(actions.controls.stop.allowed).toBe(true);
      const held = workflowActions(state, { running: true, lease: { state: "other", since: 0 } });
      [...Object.values(held.moves), ...Object.values(held.controls)].forEach((decision) =>
        expect(decision).toEqual({ allowed: false, reason: "session_in_use" }),
      );
      expect(
        evaluateWorkflowAction(state, WorkflowActionRequest.move({ move: "run" }), {
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
          const changed = yield* Effect.result(agent.moveWorkflow(id, holder, "run"));
          expect(Result.isSuccess(changed)).toBe(snapshot.actions.moves.run.allowed);
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
