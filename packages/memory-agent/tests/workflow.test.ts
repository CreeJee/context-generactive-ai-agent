import { isTruthy } from "../src/truthy.ts";
import { Cause, Exit, Schema, Effect, Result } from "effect";
import { it } from "@effect/vitest";
import { describe, expect, vi } from "vite-plus/test";
import { AppEvents } from "../src/events/app-events.ts";
import { Database } from "../src/db/database.ts";
import { WorkflowTools } from "../src/workflow/tools.ts";
import { Workflows } from "../src/workflow/workflow.ts";
import { testRuntime } from "./support/runtime.ts";

const stringifyJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const goal = {
  statement: "Ship a durable planning workflow",
  outcomes: ["A plan survives reloads"],
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

describe("WorkflowTools live refresh", () => {
  it.live.each(["execute", "verify"] as const)(
    "%s can synchronize authorized Goal changes without executing the stale Plan",
    (phase) =>
      Effect.gen(function* () {
        const { runtime, session } = yield* call(() => testRuntime());
        const workflows = yield* Effect.provideContext(Workflows, yield* runtime.contextEffect);
        yield* Effect.provideContext(
          workflows.updateGoal(session.id, goal),
          yield* runtime.contextEffect,
        );
        yield* Effect.provideContext(
          workflows.updatePlan(session.id, plan),
          yield* runtime.contextEffect,
        );
        yield* Effect.provideContext(
          workflows.setPhase(session.id, "execute"),
          yield* runtime.contextEffect,
        );
        if (phase === "verify") {
          yield* Effect.provideContext(
            workflows.updateProgress(session.id, {
              steps: [{ id: "store", status: "completed", evidence: ["Stored artifacts"] }],
              goalEvidence: [],
              planEvidence: [],
              detail: "Implementation complete",
            }),
            yield* runtime.contextEffect,
          );
          yield* Effect.provideContext(
            workflows.setPhase(session.id, "verify"),
            yield* runtime.contextEffect,
          );
        }
        const before = yield* Effect.provideContext(
          workflows.get(session.id),
          yield* runtime.contextEffect,
        );
        expect(before.phase).toBe(phase);
        const identity = yield* Effect.provideContext(
          workflows.goalInstanceId(session.id),
          yield* runtime.contextEffect,
        );
        const tools = (yield* Effect.provideContext(
          WorkflowTools,
          yield* runtime.contextEffect,
        )).forSession(session.id, phase);
        const update = tools.find((tool) => tool.name === "update_goal");
        if (!isTruthy(update?.execute)) throw new Error("Missing Goal synchronization tool");
        const updateExecute = update.execute;
        expect(yield* call(() => updateExecute({ ...goal, nonGoals: [] }))).toMatchObject({
          phase: "plan",
          goal: { version: 2, nonGoals: [] },
          goalInstanceId: identity,
        });
        const revised = yield* Effect.provideContext(
          workflows.get(session.id),
          yield* runtime.contextEffect,
        );
        expect(revised.plan).toEqual(before.plan);
        expect(revised.goal?.verification.status).toBe("not_run");
        expect(revised.ledger.at(-1)).toMatchObject({
          kind: "phase_changed",
          detail: `${phase} -> plan (goal revised)`,
        });
        const progress = tools.find((tool) => tool.name === "update_workflow_progress");
        if (!isTruthy(progress?.execute)) throw new Error("Missing progress tool");
        const progressExecute = progress.execute;
        expect(
          yield* call(() =>
            progressExecute({
              steps: [{ id: "store", status: "in_progress", evidence: [] }],
              goalEvidence: [],
              planEvidence: [],
              detail: "Stale execution",
            }),
          ),
        ).toEqual({ error: "workflow_progress_refused", reason: "phase_not_executable" });
        expect(
          yield* Effect.provideContext(workflows.get(session.id), yield* runtime.contextEffect),
        ).toEqual(revised);
        yield* Effect.provideContext(
          workflows.updatePlan(session.id, plan),
          yield* runtime.contextEffect,
        );
        expect(
          (yield* Effect.provideContext(workflows.get(session.id), yield* runtime.contextEffect))
            .plan?.goalVersion,
        ).toBe(2);
        yield* Effect.provideContext(
          workflows.setPhase(session.id, "execute"),
          yield* runtime.contextEffect,
        );
        expect(
          (yield* Effect.provideContext(workflows.get(session.id), yield* runtime.contextEffect))
            .phase,
        ).toBe("execute");
      }),
  );
  it.live.each(["update_goal", "update_plan", "update_workflow_progress"])(
    "%s publishes run-state after persisting the artifact",
    (name) =>
      Effect.gen(function* () {
        const { runtime, session, project } = yield* call(() => testRuntime());
        const workflows = yield* Effect.provideContext(Workflows, yield* runtime.contextEffect);
        yield* Effect.provideContext(
          Effect.gen(function* () {
            yield* workflows.updateGoal(session.id, goal);
            yield* workflows.updatePlan(session.id, plan);
            yield* workflows.setPhase(session.id, "execute");
          }),
          yield* runtime.contextEffect,
        );
        const events = yield* Effect.provideContext(AppEvents, yield* runtime.contextEffect);
        const beforeRevision = events.revision();
        const persistedAtPublish: unknown[] = [];
        const runSync = Effect.runSyncWith(yield* runtime.contextEffect);
        const publishSession = events.publishSession;
        const publish = vi.spyOn(events, "publishSession").mockImplementation((id, topic) => {
          persistedAtPublish.push(runSync(workflows.get(id)));
          return publishSession(id, topic);
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => publish.mockRestore()));
        const tools = (yield* Effect.provideContext(
          WorkflowTools,
          yield* runtime.contextEffect,
        )).forSession(session.id, name === "update_goal" ? "goal" : "execute");
        const tool = tools.find((candidate) => candidate.name === name);
        if (!isTruthy(tool?.execute)) throw new Error(`Missing server tool: ${name}`);
        const toolExecute = tool.execute;
        const input =
          name === "update_goal"
            ? { ...goal, statement: "Revised goal" }
            : name === "update_plan"
              ? { ...plan, summary: "Revised plan" }
              : {
                  steps: [{ id: "store", status: "in_progress", evidence: [] }],
                  goalEvidence: [],
                  planEvidence: [],
                  detail: "Started implementation",
                };
        const result = yield* call(() => toolExecute(input));
        const state = yield* Effect.provideContext(
          workflows.get(session.id),
          yield* runtime.contextEffect,
        );
        expect(publish).toHaveBeenCalledExactlyOnceWith(session.id, "run-state");
        expect(publish.mock.results[0]?.value).toEqual({
          scope: "session",
          projectId: project.id,
          sessionId: session.id,
          topic: "run-state",
          revision: beforeRevision + 1,
        });
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

  it.live(
    "records immutable full-state revisions instead of overwriting old Goal and Plan evidence",
    () =>
      Effect.gen(function* () {
        const { runtime, session } = yield* call(() => testRuntime());
        const workflows = yield* Effect.provideContext(Workflows, yield* runtime.contextEffect);
        const { sqlite } = yield* Effect.provideContext(Database, yield* runtime.contextEffect);
        const revisions = () =>
          sqlite
            .prepare("SELECT * FROM workflow_state_revisions WHERE session_id = ? ORDER BY id")
            .all(session.id);
        yield* Effect.provideContext(
          workflows.updateGoal(session.id, goal),
          yield* runtime.contextEffect,
        );
        yield* Effect.provideContext(
          workflows.updatePlan(session.id, plan),
          yield* runtime.contextEffect,
        );
        const original = revisions();
        expect(original).toHaveLength(2);
        const goalId = original[0]?.goal_instance_id;
        expect(goalId).toEqual(expect.any(String));
        expect(original[1]?.goal_instance_id).toBe(goalId);
        const previous = String(original[1]?.state_json);
        yield* Effect.provideContext(
          workflows.updateProgress(session.id, {
            steps: [],
            goalEvidence: ["observed old criterion"],
            planEvidence: ["old approach"],
            detail: "Document baseline",
          }),
          yield* runtime.contextEffect,
        );
        yield* Effect.provideContext(
          workflows.updateGoal(session.id, { ...goal, outcomes: ["New outcome"] }),
          yield* runtime.contextEffect,
        );
        yield* Effect.provideContext(
          workflows.updatePlan(session.id, { ...plan, summary: "New method" }),
          yield* runtime.contextEffect,
        );
        const rows = revisions();
        expect(rows).toHaveLength(5);
        expect(rows.every((row) => row.goal_instance_id === goalId)).toBe(true);
        expect(rows[1]?.state_json).toBe(previous);
        expect(
          (yield* Schema.decodeEffect(Schema.fromJsonString(RevisionState))(
            String(rows[2]?.state_json),
          )).goal.evidence,
        ).toEqual(["observed old criterion"]);
        const latest = yield* Schema.decodeEffect(Schema.fromJsonString(RevisionState))(
          String(rows[4]?.state_json),
        );
        expect(latest.goal.version).toBe(2);
        expect(latest.goal.outcomes).toEqual(["New outcome"]);
        expect(latest.goal.evidence).toEqual([]);
        expect(latest.plan.version).toBe(2);
        expect(latest.plan.goalVersion).toBe(2);
        expect(() =>
          sqlite
            .prepare("UPDATE workflow_state_revisions SET state_json = '{}' WHERE id = ?")
            .run(rows[0]?.id),
        ).toThrow("workflow revisions are immutable");
      }),
  );

  it.live("method-only Plan revisions keep the same Goal identity and version", () =>
    Effect.gen(function* () {
      const { runtime, session } = yield* call(() => testRuntime());
      const workflows = yield* Effect.provideContext(Workflows, yield* runtime.contextEffect);
      const { sqlite } = yield* Effect.provideContext(Database, yield* runtime.contextEffect);
      yield* Effect.provideContext(
        workflows.updateGoal(session.id, goal),
        yield* runtime.contextEffect,
      );
      yield* Effect.provideContext(
        workflows.updatePlan(session.id, plan),
        yield* runtime.contextEffect,
      );
      yield* Effect.provideContext(
        workflows.updatePlan(session.id, { ...plan, summary: "Another method" }),
        yield* runtime.contextEffect,
      );
      const rows = sqlite
        .prepare(
          "SELECT goal_instance_id, goal_version, plan_version FROM workflow_state_revisions WHERE session_id = ? ORDER BY id",
        )
        .all(session.id);
      expect(rows.map(({ goal_version, plan_version }) => [goal_version, plan_version])).toEqual([
        [1, null],
        [1, 1],
        [1, 2],
      ]);
      expect(rows.every((row) => row.goal_instance_id === rows[0]?.goal_instance_id)).toBe(true);
      expect(rows[0]?.goal_instance_id).toEqual(expect.any(String));
    }),
  );

  it.live("rolls back a new Goal identity and current state if its evidence snapshot fails", () =>
    Effect.gen(function* () {
      const { runtime, session } = yield* call(() => testRuntime());
      const workflows = yield* Effect.provideContext(Workflows, yield* runtime.contextEffect);
      const { sqlite } = yield* Effect.provideContext(Database, yield* runtime.contextEffect);
      sqlite.exec(`
      CREATE TRIGGER reject_workflow_revision BEFORE INSERT ON workflow_state_revisions
      BEGIN SELECT RAISE(ABORT, 'snapshot unavailable'); END;
    `);
      const rejected = yield* Effect.exit(
        Effect.provideContext(workflows.updateGoal(session.id, goal), yield* runtime.contextEffect),
      );
      expect(Exit.isFailure(rejected)).toBe(true);
      if (Exit.isFailure(rejected))
        expect(() => {
          throw Cause.squash(rejected.cause);
        }).toThrow("snapshot unavailable");
      expect(
        sqlite
          .prepare("SELECT * FROM workflow_goal_identities WHERE session_id = ?")
          .all(session.id),
      ).toEqual([]);
      expect(
        sqlite.prepare("SELECT * FROM session_workflows WHERE session_id = ?").all(session.id),
      ).toEqual([]);
    }),
  );

  it.live("rejected progress does not publish a successful mutation event", () =>
    Effect.gen(function* () {
      const { runtime, session } = yield* call(() => testRuntime());
      const workflows = yield* Effect.provideContext(Workflows, yield* runtime.contextEffect);
      yield* Effect.provideContext(
        Effect.gen(function* () {
          yield* workflows.updateGoal(session.id, goal);
          yield* workflows.updatePlan(session.id, plan);
          yield* workflows.setPhase(session.id, "plan");
        }),
        yield* runtime.contextEffect,
      );
      const before = yield* Effect.provideContext(
        workflows.get(session.id),
        yield* runtime.contextEffect,
      );
      const events = yield* Effect.provideContext(AppEvents, yield* runtime.contextEffect);
      const beforeRevision = events.revision();
      const publish = vi.spyOn(events, "publishSession");
      yield* Effect.addFinalizer(() => Effect.sync(() => publish.mockRestore()));
      const tools = (yield* Effect.provideContext(
        WorkflowTools,
        yield* runtime.contextEffect,
      )).forSession(session.id, "execute");
      const progress = tools.find((tool) => tool.name === "update_workflow_progress");
      if (!isTruthy(progress?.execute)) throw new Error("Missing progress tool");
      const progressExecute = progress.execute;
      expect(
        yield* call(() =>
          progressExecute({
            planStatus: "executing",
            steps: [],
            goalEvidence: [],
            planEvidence: [],
            detail: "Stale progress",
          }),
        ),
      ).toEqual({ error: "workflow_progress_refused", reason: "phase_not_executable" });
      expect(publish).not.toHaveBeenCalled();
      expect(events.revision()).toBe(beforeRevision);
      expect(
        yield* Effect.provideContext(workflows.get(session.id), yield* runtime.contextEffect),
      ).toEqual(before);
    }),
  );
});

describe("Workflows", () => {
  it.live("versions artifacts and starts a ready Plan on Execute", () =>
    Effect.gen(function* () {
      const { runtime, session } = yield* call(() => testRuntime());
      const state = yield* Effect.provideContext(
        Effect.gen(function* () {
          const workflows = yield* Workflows;
          yield* workflows.setPhase(session.id, "goal");
          yield* workflows.updateGoal(session.id, goal);
          yield* workflows.setPhase(session.id, "plan");
          yield* workflows.updatePlan(session.id, plan);
          return yield* workflows.setPhase(session.id, "execute");
        }),
        yield* runtime.contextEffect,
      );
      expect(state.phase).toBe("execute");
      expect(state.goal).toMatchObject({ version: 1, status: "active" });
      expect(state.plan).toMatchObject({
        version: 1,
        goalVersion: 1,
        status: "executing",
      });
      expect(state.ledger.map((event) => event.kind)).toEqual([
        "phase_changed",
        "goal_updated",
        "phase_changed",
        "plan_updated",
        "phase_changed",
      ]);
    }),
  );

  it.live("returns Execute to Plan when the Plan is revised", () =>
    Effect.gen(function* () {
      const { runtime, session } = yield* call(() => testRuntime());
      const state = yield* Effect.provideContext(
        Effect.gen(function* () {
          const workflows = yield* Workflows;
          yield* workflows.updateGoal(session.id, goal);
          yield* workflows.updatePlan(session.id, plan);
          yield* workflows.setPhase(session.id, "execute");
          return yield* workflows.updatePlan(session.id, {
            ...plan,
            summary: "Revised execution scope",
          });
        }),
        yield* runtime.contextEffect,
      );
      expect(state.phase).toBe("plan");
      expect(state.plan).toMatchObject({
        version: 2,
        status: "ready",
        summary: "Revised execution scope",
        steps: [{ status: "pending", evidence: [] }],
      });
      expect(state.ledger.slice(-2)).toMatchObject([
        { kind: "plan_replanned", detail: "plan v2 (ready)" },
        { kind: "phase_changed", detail: "execute -> plan (plan revised)" },
      ]);
      expect(state.ledger.at(-1)?.sequence).toBe(state.ledger.at(-2)!.sequence + 1);
    }),
  );

  it.live("rejects stale execution progress after a Plan revision", () =>
    Effect.gen(function* () {
      const { runtime, session } = yield* call(() => testRuntime());
      const result = yield* Effect.provideContext(
        Effect.gen(function* () {
          const workflows = yield* Workflows;
          yield* workflows.updateGoal(session.id, goal);
          yield* workflows.updatePlan(session.id, plan);
          yield* workflows.setPhase(session.id, "execute");
          yield* workflows.updatePlan(session.id, {
            ...plan,
            summary: "Revised execution scope",
          });
          const progress = yield* Effect.result(
            workflows.updateProgress(session.id, {
              goalEvidence: [],
              planEvidence: [],
              planStatus: "executing",
              steps: [],
              detail: "stale Execute tool call",
            }),
          );
          return { progress, state: yield* workflows.get(session.id) };
        }),
        yield* runtime.contextEffect,
      );
      expect(Result.isFailure(result.progress)).toBe(true);
      if (Result.isFailure(result.progress))
        expect(result.progress.failure).toMatchObject({ reason: "phase_not_executable" });
      expect(result.state).toMatchObject({
        phase: "plan",
        plan: { version: 2, status: "ready" },
      });
    }),
  );

  it.live(
    "returns a typed tool result for stale progress instead of a generic execution error",
    () =>
      Effect.gen(function* () {
        const { runtime, session } = yield* call(() => testRuntime());
        const result = yield* Effect.provideContext(
          Effect.gen(function* () {
            const workflows = yield* Workflows;
            yield* workflows.updateGoal(session.id, goal);
            yield* workflows.updatePlan(session.id, plan);
            yield* workflows.setPhase(session.id, "execute");
            const tools = (yield* WorkflowTools).forSession(session.id, "execute");
            const progress = tools.find((tool) => tool.name === "update_workflow_progress");
            if (!isTruthy(progress?.execute))
              throw new Error("progress tool has no server implementation");
            const progressExecute = progress.execute;
            yield* workflows.updatePlan(session.id, {
              ...plan,
              summary: "Revised before stale progress arrived",
            });
            return yield* Effect.promise(() =>
              progressExecute({
                planStatus: "executing",
                steps: [],
                goalEvidence: [],
                planEvidence: [],
                detail: "stale Execute tool call",
              }),
            );
          }),
          yield* runtime.contextEffect,
        );
        expect(result).toEqual({
          error: "workflow_progress_refused",
          reason: "phase_not_executable",
        });
      }),
  );

  it.live("keeps an older Plan visibly tied to its Goal version", () =>
    Effect.gen(function* () {
      const { runtime, session } = yield* call(() => testRuntime());
      const state = yield* Effect.provideContext(
        Effect.gen(function* () {
          const workflows = yield* Workflows;
          yield* workflows.updateGoal(session.id, goal);
          yield* workflows.updatePlan(session.id, plan);
          yield* workflows.updateGoal(session.id, { ...goal, statement: "Changed goal" });
          return yield* workflows.get(session.id);
        }),
        yield* runtime.contextEffect,
      );
      expect(state.goal?.version).toBe(2);
      expect(state.plan?.goalVersion).toBe(1);
      const execute = yield* Effect.provideContext(
        Effect.gen(function* () {
          return yield* Effect.result((yield* Workflows).setPhase(session.id, "execute"));
        }),
        yield* runtime.contextEffect,
      );
      expect(Result.isFailure(execute)).toBe(true);
    }),
  );

  it.live("upgrades persisted legacy statuses and missing evidence fields", () =>
    Effect.gen(function* () {
      const { runtime, session } = yield* call(() => testRuntime());
      const state = yield* Effect.provideContext(
        Effect.gen(function* () {
          const { sqlite } = yield* Database;
          sqlite
            .prepare(
              "INSERT INTO session_workflows (session_id, state_json, updated_at) VALUES (?, ?, ?)",
            )
            .run(
              session.id,
              yield* stringifyJson({
                phase: "execute",
                goal: {
                  version: 1,
                  statement: goal.statement,
                  outcomes: goal.outcomes,
                  constraints: goal.constraints,
                  nonGoals: goal.nonGoals,
                  assumptions: goal.assumptions,
                  openQuestions: [],
                  status: "confirmed",
                  updatedAt: "2026-01-01T00:00:00.000Z",
                },
                plan: {
                  version: 1,
                  goalVersion: 1,
                  summary: plan.summary,
                  steps: [{ ...plan.steps[0], status: "pending" }],
                  risks: [],
                  openQuestions: [],
                  status: "approved",
                  updatedAt: "2026-01-01T00:00:00.000Z",
                },
                ledger: [],
              }),
              "2026-01-01T00:00:00.000Z",
            );
          return yield* (yield* Workflows).get(session.id);
        }),
        yield* runtime.contextEffect,
      );
      expect(state.goal).toMatchObject({
        status: "active",
        evidence: [],
        verification: { status: "not_run" },
      });
      expect(state.plan).toMatchObject({
        status: "executing",
        evidence: [],
        verification: { status: "not_run" },
        steps: [{ status: "pending", evidence: [] }],
      });
    }),
  );

  it.live("does not lose versions under concurrent updates", () =>
    Effect.gen(function* () {
      const { runtime, session } = yield* call(() => testRuntime());
      const count = 24;
      const state = yield* Effect.provideContext(
        Effect.gen(function* () {
          const workflows = yield* Workflows;
          yield* Effect.all(
            Array.from({ length: count }, (_, index) =>
              workflows.updateGoal(session.id, {
                ...goal,
                statement: `Concurrent goal ${index + 1}`,
              }),
            ),
            { concurrency: "unbounded" },
          );
          return yield* workflows.get(session.id);
        }),
        yield* runtime.contextEffect,
      );
      expect(state.goal?.version).toBe(count);
      const goalEvents = state.ledger.filter((event) => event.kind === "goal_updated");
      expect(goalEvents).toHaveLength(count);
      expect(goalEvents.map((event) => event.sequence)).toEqual(
        Array.from({ length: count }, (_, index) => index + 1),
      );
    }),
  );

  it.live("records step evidence and requires passed verification before completion", () =>
    Effect.gen(function* () {
      const { runtime, session } = yield* call(() => testRuntime());
      const state = yield* Effect.provideContext(
        Effect.gen(function* () {
          const workflows = yield* Workflows;
          yield* workflows.updateGoal(session.id, goal);
          yield* workflows.updatePlan(session.id, plan);
          yield* workflows.setPhase(session.id, "execute");
          yield* workflows.updateProgress(session.id, {
            steps: [{ id: "store", status: "completed", evidence: ["workflow.test.ts passed"] }],
            goalEvidence: [],
            planEvidence: ["State persisted after reload"],
            detail: "Completed the storage step",
          });
          return yield* workflows.updateProgress(session.id, {
            goalStatus: "completed",
            planStatus: "completed",
            steps: [],
            goalEvidence: ["The requested workflow is available"],
            planEvidence: [],
            verification: {
              status: "passed",
              summary: "The workflow persists and reloads",
              evidence: ["24 workflow assertions passed"],
            },
            detail: "Verification passed",
          });
        }),
        yield* runtime.contextEffect,
      );
      expect(state.goal).toMatchObject({
        status: "completed",
        verification: { status: "passed" },
      });
      expect(state.plan).toMatchObject({
        status: "completed",
        verification: { status: "passed" },
        steps: [{ id: "store", status: "completed", evidence: ["workflow.test.ts passed"] }],
      });
      expect(state.ledger.at(-1)?.kind).toBe("verification_recorded");
    }),
  );

  it.live("refuses unsupported completion claims", () =>
    Effect.gen(function* () {
      const { runtime, session } = yield* call(() => testRuntime());
      const result = yield* Effect.provideContext(
        Effect.gen(function* () {
          const workflows = yield* Workflows;
          yield* workflows.updateGoal(session.id, goal);
          return yield* Effect.result(
            workflows.updateProgress(session.id, {
              goalStatus: "completed",
              steps: [],
              goalEvidence: [],
              planEvidence: [],
              verification: {
                status: "passed",
                summary: "Claimed success",
                evidence: [],
              },
              detail: "Tried to complete without evidence",
            }),
          );
        }),
        yield* runtime.contextEffect,
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure.reason).toBe("verification_required");
    }),
  );

  it.live("refuses a completed step without evidence", () =>
    Effect.gen(function* () {
      const { runtime, session } = yield* call(() => testRuntime());
      const result = yield* Effect.provideContext(
        Effect.gen(function* () {
          const workflows = yield* Workflows;
          yield* workflows.updateGoal(session.id, goal);
          yield* workflows.updatePlan(session.id, plan);
          return yield* Effect.result(
            workflows.updateProgress(session.id, {
              steps: [{ id: "store", status: "completed", evidence: [] }],
              goalEvidence: [],
              planEvidence: [],
              detail: "Claimed the step was done",
            }),
          );
        }),
        yield* runtime.contextEffect,
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure.reason).toBe("step_evidence_required");
    }),
  );

  it.live("records pause and resume as durable Goal lifecycle events", () =>
    Effect.gen(function* () {
      const { runtime, session } = yield* call(() => testRuntime());
      const state = yield* Effect.provideContext(
        Effect.gen(function* () {
          const workflows = yield* Workflows;
          yield* workflows.updateGoal(session.id, goal);
          yield* workflows.updateProgress(session.id, {
            goalStatus: "paused",
            steps: [],
            goalEvidence: [],
            planEvidence: [],
            detail: "Paused by the user",
          });
          return yield* workflows.updateProgress(session.id, {
            goalStatus: "active",
            steps: [],
            goalEvidence: [],
            planEvidence: [],
            detail: "Resumed by the user",
          });
        }),
        yield* runtime.contextEffect,
      );
      expect(state.goal?.status).toBe("active");
      expect(state.ledger.slice(-2).map((event) => event.kind)).toEqual([
        "goal_paused",
        "goal_resumed",
      ]);
    }),
  );

  it.live("controls a Goal and records pause, resume and stop", () =>
    Effect.gen(function* () {
      const { runtime, session } = yield* call(() => testRuntime());
      const state = yield* Effect.provideContext(
        Effect.gen(function* () {
          const workflows = yield* Workflows;
          yield* workflows.setPhase(session.id, "goal");
          yield* workflows.updateGoal(session.id, goal);
          yield* workflows.controlGoal(session.id, "pause");
          yield* workflows.controlGoal(session.id, "resume");
          return yield* workflows.controlGoal(session.id, "stop");
        }),
        yield* runtime.contextEffect,
      );
      expect(state.goal?.status).toBe("failed");
      expect(state.ledger.slice(-3).map((event) => event.kind)).toEqual([
        "goal_paused",
        "goal_resumed",
        "workflow_stopped",
      ]);
    }),
  );

  it.live("keeps Execute active while any Plan step lacks completion evidence", () =>
    Effect.gen(function* () {
      const { runtime, session } = yield* call(() => testRuntime());
      const state = yield* Effect.provideContext(
        Effect.gen(function* () {
          const workflows = yield* Workflows;
          yield* workflows.updateGoal(session.id, goal);
          yield* workflows.updatePlan(session.id, plan);
          yield* workflows.setPhase(session.id, "execute");
          return yield* workflows.finishRun(session.id, "execute");
        }),
        yield* runtime.contextEffect,
      );
      expect(state.phase).toBe("execute");
      expect(state.plan?.steps[0]?.status).toBe("pending");
    }),
  );

  it.live("reconciles a stale Verify phase with unfinished steps back to Execute", () =>
    Effect.gen(function* () {
      const { runtime, session } = yield* call(() => testRuntime());
      const state = yield* Effect.provideContext(
        Effect.gen(function* () {
          const workflows = yield* Workflows;
          yield* workflows.updateGoal(session.id, goal);
          yield* workflows.updatePlan(session.id, plan);
          yield* workflows.setPhase(session.id, "execute");
          yield* workflows.setPhase(session.id, "verify");
          return yield* workflows.reconcile(session.id);
        }),
        yield* runtime.contextEffect,
      );
      expect(state.phase).toBe("execute");
      expect(state.ledger.at(-1)?.detail).toBe("verify -> execute (state reconciled)");
    }),
  );

  it.live("reconciles completed Execute work to Verify before the next turn", () =>
    Effect.gen(function* () {
      const { runtime, session } = yield* call(() => testRuntime());
      const state = yield* Effect.provideContext(
        Effect.gen(function* () {
          const workflows = yield* Workflows;
          yield* workflows.updateGoal(session.id, goal);
          yield* workflows.updatePlan(session.id, plan);
          yield* workflows.setPhase(session.id, "execute");
          yield* workflows.updateProgress(session.id, {
            steps: [{ id: "store", status: "completed", evidence: ["workflow test passed"] }],
            goalEvidence: [],
            planEvidence: [],
            detail: "Implementation complete",
          });
          return yield* workflows.reconcile(session.id);
        }),
        yield* runtime.contextEffect,
      );
      expect(state.phase).toBe("verify");
      expect(state.ledger.at(-1)?.detail).toBe("execute -> verify (state reconciled)");
    }),
  );

  it.live("advances Execute to Verify only after every step has completion evidence", () =>
    Effect.gen(function* () {
      const { runtime, session } = yield* call(() => testRuntime());
      const state = yield* Effect.provideContext(
        Effect.gen(function* () {
          const workflows = yield* Workflows;
          yield* workflows.updateGoal(session.id, goal);
          yield* workflows.updatePlan(session.id, plan);
          yield* workflows.setPhase(session.id, "execute");
          yield* workflows.updateProgress(session.id, {
            steps: [{ id: "store", status: "completed", evidence: ["workflow test passed"] }],
            goalEvidence: [],
            planEvidence: [],
            detail: "Implementation complete",
          });
          return yield* workflows.finishRun(session.id, "execute");
        }),
        yield* runtime.contextEffect,
      );
      expect(state.phase).toBe("verify");
      expect(state.plan?.status).toBe("executing");
      expect(state.ledger.at(-1)).toMatchObject({
        kind: "phase_changed",
        detail: "execute -> verify",
      });
    }),
  );

  it.live("completes verified artifacts after the Verify run", () =>
    Effect.gen(function* () {
      const { runtime, session } = yield* call(() => testRuntime());
      const state = yield* Effect.provideContext(
        Effect.gen(function* () {
          const workflows = yield* Workflows;
          yield* workflows.updateGoal(session.id, goal);
          yield* workflows.updatePlan(session.id, plan);
          yield* workflows.setPhase(session.id, "execute");
          yield* workflows.updateProgress(session.id, {
            steps: [{ id: "store", status: "completed", evidence: ["workflow test passed"] }],
            goalEvidence: [],
            planEvidence: [],
            detail: "Implementation complete",
          });
          yield* workflows.finishRun(session.id, "execute");
          yield* workflows.updateProgress(session.id, {
            steps: [],
            goalEvidence: [],
            planEvidence: [],
            verification: {
              status: "passed",
              summary: "Acceptance criteria passed",
              evidence: ["workflow test passed"],
            },
            detail: "Verification passed",
          });
          const completed = yield* workflows.finishRun(session.id, "verify");
          const repeated = yield* workflows.finishRun(session.id, "verify");
          return { completed, repeated };
        }),
        yield* runtime.contextEffect,
      );
      expect(state.completed.phase).toBe("completed");
      expect(state.completed.goal).toMatchObject({
        status: "completed",
        verification: { status: "passed" },
      });
      expect(state.completed.plan).toMatchObject({
        status: "completed",
        verification: { status: "passed" },
      });
      expect(state.repeated).toEqual(state.completed);
      expect(
        state.repeated.ledger.filter(
          (event) => event.detail === "Verification completed the workflow",
        ),
      ).toHaveLength(1);
    }),
  );

  it.live.each([
    ["failed", "execute"],
    ["invalid_criterion", "plan"],
    ["inconclusive", "plan"],
  ] as const)("routes %s verification to %s", ([status, expectedPhase]) =>
    Effect.gen(function* () {
      const { runtime, session } = yield* call(() => testRuntime());
      const state = yield* Effect.provideContext(
        Effect.gen(function* () {
          const workflows = yield* Workflows;
          yield* workflows.updateGoal(session.id, goal);
          yield* workflows.updatePlan(session.id, plan);
          yield* workflows.setPhase(session.id, "execute");
          yield* workflows.updateProgress(session.id, {
            steps: [{ id: "store", status: "completed", evidence: ["implementation evidence"] }],
            goalEvidence: [],
            planEvidence: [],
            detail: "Implementation complete",
          });
          yield* workflows.finishRun(session.id, "execute");
          yield* workflows.updateProgress(session.id, {
            steps: [],
            goalEvidence: [],
            planEvidence: [],
            verification: {
              status,
              summary: `Verification ended as ${status}`,
              evidence: ["diagnostic evidence"],
            },
            detail: `Recorded ${status}`,
          });
          return yield* workflows.finishRun(session.id, "verify");
        }),
        yield* runtime.contextEffect,
      );
      expect(state.phase).toBe(expectedPhase);
      expect(state.goal?.status).toBe("active");
      expect(state.plan?.status).toBe("executing");
      expect(state.ledger.at(-1)).toMatchObject({
        kind: "phase_changed",
        detail: `verify -> ${expectedPhase} (${status})`,
      });
      if (status === "invalid_criterion")
        expect(state.ledger.at(-2)?.kind).toBe("verification_invalidated");
    }),
  );

  it.live("routes an invalid hypothesis to its requested recovery phase", () =>
    Effect.gen(function* () {
      const { runtime, session } = yield* call(() => testRuntime());
      const state = yield* Effect.provideContext(
        Effect.gen(function* () {
          const workflows = yield* Workflows;
          yield* workflows.updateGoal(session.id, goal);
          yield* workflows.updatePlan(session.id, plan);
          yield* workflows.setPhase(session.id, "execute");
          yield* workflows.updateProgress(session.id, {
            steps: [{ id: "store", status: "completed", evidence: ["implementation evidence"] }],
            goalEvidence: [],
            planEvidence: [],
            detail: "Implementation complete",
          });
          yield* workflows.finishRun(session.id, "execute");
          yield* workflows.updateProgress(session.id, {
            steps: [],
            goalEvidence: [],
            planEvidence: [],
            verification: {
              status: "invalid_hypothesis",
              summary: "The Goal premise was disproven",
              evidence: ["The observed failure has a different cause"],
              recoveryPhase: "goal",
            },
            detail: "Invalidate the premise and revise the Goal",
          });
          return yield* workflows.finishRun(session.id, "verify");
        }),
        yield* runtime.contextEffect,
      );
      expect(state.phase).toBe("goal");
      expect(state.ledger.at(-2)?.kind).toBe("verification_invalidated");
      expect(state.ledger.at(-1)?.detail).toBe("verify -> goal (invalid_hypothesis)");
    }),
  );

  it.live("keeps a confirmed external block in Verify and marks the Plan blocked", () =>
    Effect.gen(function* () {
      const { runtime, session } = yield* call(() => testRuntime());
      const state = yield* Effect.provideContext(
        Effect.gen(function* () {
          const workflows = yield* Workflows;
          yield* workflows.updateGoal(session.id, goal);
          yield* workflows.updatePlan(session.id, plan);
          yield* workflows.setPhase(session.id, "execute");
          yield* workflows.updateProgress(session.id, {
            steps: [{ id: "store", status: "completed", evidence: ["implementation evidence"] }],
            goalEvidence: [],
            planEvidence: [],
            detail: "Implementation complete",
          });
          yield* workflows.finishRun(session.id, "execute");
          yield* workflows.updateProgress(session.id, {
            steps: [],
            goalEvidence: [],
            planEvidence: [],
            verification: {
              status: "blocked",
              summary: "A real account login is required",
              evidence: ["The provider returned an authentication challenge"],
            },
            detail: "Waiting for the user to authenticate",
          });
          return yield* workflows.finishRun(session.id, "verify");
        }),
        yield* runtime.contextEffect,
      );
      expect(state.phase).toBe("verify");
      expect(state.plan?.status).toBe("blocked");
      expect(state.plan?.verification.status).toBe("blocked");
    }),
  );

  it.live("does not route a verification outcome without evidence", () =>
    Effect.gen(function* () {
      const { runtime, session } = yield* call(() => testRuntime());
      const state = yield* Effect.provideContext(
        Effect.gen(function* () {
          const workflows = yield* Workflows;
          yield* workflows.updateGoal(session.id, goal);
          yield* workflows.updatePlan(session.id, plan);
          yield* workflows.setPhase(session.id, "execute");
          yield* workflows.updateProgress(session.id, {
            steps: [{ id: "store", status: "completed", evidence: ["implementation evidence"] }],
            goalEvidence: [],
            planEvidence: [],
            detail: "Implementation complete",
          });
          yield* workflows.finishRun(session.id, "execute");
          yield* workflows.updateProgress(session.id, {
            steps: [],
            goalEvidence: [],
            planEvidence: [],
            verification: {
              status: "invalid_criterion",
              summary: "Unsupported invalidation claim",
              evidence: [],
            },
            detail: "Tried to invalidate without evidence",
          });
          return yield* workflows.finishRun(session.id, "verify");
        }),
        yield* runtime.contextEffect,
      );
      expect(state.phase).toBe("verify");
    }),
  );

  it.live("refuses Execute until a Plan is ready", () =>
    Effect.gen(function* () {
      const { runtime, session } = yield* call(() => testRuntime());
      const result = yield* Effect.provideContext(
        Effect.gen(function* () {
          return yield* Effect.result((yield* Workflows).setPhase(session.id, "execute"));
        }),
        yield* runtime.contextEffect,
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure.reason).toBe("plan_not_ready");
    }),
  );
});

const call = <A>(execute: () => A) =>
  Effect.tryPromise({
    try: () => Promise.resolve(execute()),
    catch: (cause) => new Cause.UnknownError(cause),
  });
const RevisionState = Schema.Struct({
  goal: Schema.Struct({
    version: Schema.Finite,
    outcomes: Schema.Array(Schema.String),
    evidence: Schema.Array(Schema.String),
  }),
  plan: Schema.Struct({ version: Schema.Finite, goalVersion: Schema.Finite }),
});
