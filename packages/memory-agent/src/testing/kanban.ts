import { DateTime, Effect, FileSystem, Layer, Option, Path, Schedule, type Scope } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { SqlClient } from "effect/sql";
import { GlobalConfig } from "../config/global-config.ts";
import { KanbanSettings } from "../config/kanban-settings.ts";
import { StorageRoot } from "../config/storage-root.ts";
import { Database } from "../db/database.ts";
import { AppEvents } from "../events/app-events.ts";
import { canonicalPathEffect } from "../files/paths.ts";
import { nodePlatformLayer } from "../runtime/node-platform.ts";
import {
  CardAgent,
  CardVerdict,
  CardVerifier,
  GoalVerifier,
  type CardAgentOutcome,
  type CardAgentRun,
  type CardVerification,
  type GoalVerification,
} from "../kanban/card-agent.ts";
import { GoalOrder } from "../kanban/goal-order.ts";
import { GoalSchedules } from "../kanban/goal-schedules.ts";
import { BoardHealth } from "../kanban/board-health.ts";
import { GoalMerges } from "../kanban/merge-queue.ts";
import { ProjectScheduler } from "../kanban/scheduler.ts";
import { CardAttempts } from "../kanban/card-attempts.ts";
import { HumanDecisions } from "../kanban/human-decision.ts";
import {
  cardAttemptExecutionLayer,
  CardAttemptExecution,
  cardQueueFactoryLayer,
  CardQueueGate,
  cardQueueWorkerLayer,
  CardRuns,
} from "../kanban/card-queue.ts";
import { gitCardWorktreesLayer } from "../kanban/git-worktrees.ts";
import { persistedQueueStoreLayer } from "../kanban/persisted-queue-store.ts";
import { CardWorktrees } from "../kanban/worktree.ts";
import { Projects } from "../projects/projects.ts";
import { Sessions } from "../sessions/sessions.ts";
import { ownerWorkflowEngineLayer } from "../workflow/owner-workflow-engine.ts";
import { workflowRunBindings } from "../workflow/run-bindings.ts";
import { BoardAuthor } from "../workflow/card.ts";
import { Workflows, type PlanStep, type UpdatePlan } from "../workflow/workflow.ts";
import { KanbanBoardActions } from "../kanban/board-actions.ts";
import { KanbanOrchestrator } from "../kanban/orchestrator.ts";
import { boardOps } from "../kanban/board-ops.ts";

/**
 * Kanban test owners: the card queue, its workflow engine and store over one SQLite file, with
 * scripted card agents. Two owners over the same file stand for an owner before and after a crash.
 */

export const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  ChildProcessSpawner.ChildProcessSpawner.use((spawner) =>
    spawner.string(ChildProcess.make("git", args, { cwd })),
  ).pipe(Effect.map((text) => text.trim()));

/** A temporary home with a git project holding one commit, and where the owner keeps its data. */
export const kanbanFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* canonicalPathEffect(yield* fs.makeTempDirectoryScoped());
  const project = path.join(home, "project");
  const storage = path.join(home, "storage");
  yield* fs.makeDirectory(project);
  yield* fs.makeDirectory(storage);
  yield* git(project, "init", "--quiet", "--initial-branch=main");
  yield* git(project, "config", "user.name", "Card Test");
  yield* git(project, "config", "user.email", "card@test.invalid");
  yield* git(project, "config", "commit.gpgsign", "false");
  yield* fs.writeFileString(path.join(project, "a.txt"), "one\n");
  yield* git(project, "add", "a.txt");
  yield* git(project, "commit", "--quiet", "-m", "start");
  return {
    home,
    project,
    storage,
    database: path.join(storage, "agent.db"),
    worktrees: path.join(home, "worktrees"),
  };
});
export type KanbanFixture = Effect.Success<typeof kanbanFixture>;

export const scriptedAgent = (run: (run: CardAgentRun) => Effect.Effect<CardAgentOutcome>) =>
  Layer.succeed(CardAgent, CardAgent.of({ run }));

/** A verifier that passes every card unless told otherwise. */
export const passingVerifier = Layer.succeed(
  CardVerifier,
  CardVerifier.of({
    verify: (input) =>
      Effect.succeed(CardVerdict.Passed({ evidence: [`verified ${input.card.id}`] })),
  }),
);

/** The owner services the card queue needs, below its workers. */
const kanbanOwnerBase = (fixture: KanbanFixture, cores: number) =>
  cardQueueFactoryLayer.pipe(
    Layer.provideMerge(CardQueueGate.layer),
    Layer.provideMerge(KanbanSettings.layer(cores)),
    Layer.provideMerge(GlobalConfig.layer),
    Layer.provideMerge(ownerWorkflowEngineLayer),
    Layer.provideMerge(persistedQueueStoreLayer({ pollInterval: "50 millis" })),
    Layer.provideMerge(
      Layer.mergeAll(
        Workflows.layer,
        HumanDecisions.layer,
        CardAttempts.layer,
        CardRuns.layer,
        GoalOrder.layer,
        GoalSchedules.layer,
        gitCardWorktreesLayer(fixture.worktrees),
        Sessions.layer.pipe(Layer.provideMerge(Projects.layer)),
        AppEvents.layer,
      ),
    ),
    Layer.provideMerge(
      Layer.mergeAll(Database.layer(fixture.database), StorageRoot.layer(fixture.storage)),
    ),
    Layer.provideMerge(nodePlatformLayer),
  );

/** A Goal-level check that passes every Goal branch. */
export const passingGoalVerifier = Layer.succeed(
  GoalVerifier,
  GoalVerifier.of({
    verify: () => Effect.succeed(CardVerdict.Passed({ evidence: ["goal verified"] })),
  }),
);

/**
 * An owner with the orchestrator loop, the project scheduler, the merge queue and the board
 * actions; looks happen every 50ms.
 */
export const kanbanBoardOwner = (owner: {
  readonly fixture: KanbanFixture;
  readonly agent: Layer.Layer<CardAgent>;
  readonly verifier: Layer.Layer<CardVerifier>;
  readonly goalVerifier?: Layer.Layer<GoalVerifier>;
  readonly cores?: number;
}) =>
  KanbanBoardActions.layer.pipe(
    Layer.provideMerge(
      KanbanOrchestrator.layer({ pollInterval: "50 millis", backoff: "50 millis" }),
    ),
    Layer.provideMerge(GoalMerges.layer),
    Layer.provideMerge(BoardHealth.layer),
    Layer.provideMerge(ProjectScheduler.layer),
    Layer.provideMerge(owner.verifier),
    Layer.provideMerge(owner.goalVerifier ?? passingGoalVerifier),
    Layer.provideMerge(kanbanOwner(owner)),
  );

export type KanbanBoardOwner = Layer.Success<ReturnType<typeof kanbanBoardOwner>>;

/**
 * Opens a board owner in `scope` with a scripted agent and verifiers; returns how to run effects
 * in it. Verifiers pass unless told otherwise.
 */
export const openKanbanOwner = Effect.fnUntraced(function* (
  fixture: KanbanFixture,
  scope: Scope.Scope,
  options: {
    readonly agent: (run: CardAgentRun) => Effect.Effect<CardAgentOutcome>;
    readonly verify?: (input: CardVerification) => Effect.Effect<CardVerdict>;
    readonly verifyGoal?: (input: GoalVerification) => Effect.Effect<CardVerdict>;
    readonly cores?: number;
  },
) {
  return yield* Effect.map(
    Layer.buildWithScope(
      kanbanBoardOwner({
        fixture,
        agent: scriptedAgent(options.agent),
        verifier: Layer.succeed(
          CardVerifier,
          CardVerifier.of({
            verify:
              options.verify ??
              ((input) =>
                Effect.succeed(CardVerdict.Passed({ evidence: [`verified ${input.card.id}`] }))),
          }),
        ),
        goalVerifier: Layer.succeed(
          GoalVerifier,
          GoalVerifier.of({
            verify:
              options.verifyGoal ??
              (() => Effect.succeed(CardVerdict.Passed({ evidence: ["goal verified"] }))),
          }),
        ),
        cores: options.cores ?? 2,
      }),
      scope,
    ),
    (context) =>
      <A, E>(effect: Effect.Effect<A, E, KanbanBoardOwner>) =>
        Effect.provideContext(effect, context),
  );
});

/** Waits until the board's cards satisfy `ready`, checking as the test's own fiber. */
export const waitForCards = Effect.fn("waitForCards")(function* (
  sessionId: string,
  ready: (cards: ReadonlyArray<PlanStep>) => boolean,
) {
  const workflows = yield* Workflows;
  return yield* workflows.get(sessionId).pipe(
    Effect.map((state) => state.plan?.steps ?? []),
    Effect.repeat({ until: ready, schedule: Schedule.spaced("20 millis") }),
    Effect.timeout("15 seconds"),
  );
});

/** One owner process: base services, the card queue workers and the attempt workflow. */
export const kanbanOwner = (owner: {
  readonly fixture: KanbanFixture;
  readonly agent: Layer.Layer<CardAgent>;
  /** Two cores make the default concurrency one card at a time. */
  readonly cores?: number;
}) =>
  Layer.mergeAll(cardQueueWorkerLayer, cardAttemptExecutionLayer).pipe(
    Layer.provideMerge(owner.agent),
    Layer.provideMerge(kanbanOwnerBase(owner.fixture, owner.cores ?? 2)),
  );

export const card = (id: string): UpdatePlan["steps"][number] => ({
  id,
  title: `Card ${id}`,
  description: `Do ${id}`,
  dependsOn: [],
  acceptanceCriteria: [`${id} works`],
  ruleRefs: [],
});

export const goalInput = {
  statement: "Run cards",
  outcomes: ["Cards are done"],
  constraints: [],
  nonGoals: [],
  assumptions: [],
  openQuestions: [],
  status: "active" as const,
};

/** A session of the fixture's project executing a Plan of the given cards. */
export const executingPlan = Effect.fn("executingPlan")(function* (
  fixture: KanbanFixture,
  steps: UpdatePlan["steps"],
  boundaries: Readonly<Record<string, readonly string[]>> = {},
) {
  const project = yield* (yield* Projects).add(fixture.project);
  return yield* executingSession(project.id, steps, boundaries);
});

/**
 * Another session of an existing project executing a Plan of the given cards. `boundaries` gives
 * cards their expected files by card id.
 */
export const executingSession = Effect.fn("executingSession")(function* (
  projectId: string,
  steps: UpdatePlan["steps"],
  boundaries: Readonly<Record<string, readonly string[]>> = {},
) {
  const project = { id: projectId };
  const session = yield* (yield* Sessions).create(project.id);
  const workflows = yield* Workflows;
  yield* workflows.updateGoal(session.id, goalInput);
  yield* workflows.updatePlan(session.id, {
    summary: "Cards",
    steps,
    risks: [],
    openQuestions: [],
    status: "ready",
  });
  const ops = boardOps(workflows);
  yield* Effect.forEach(
    Object.entries(boundaries),
    ([cardId, files]) =>
      ops.editCard(session.id, cardId, { boundaries: files }, BoardAuthor.cases.User.make({})),
    { discard: true },
  );
  yield* workflows.setPhase(session.id, "execute");
  const goalInstanceId = Option.getOrThrow(
    Option.fromNullishOr(yield* workflows.goalInstanceId(session.id)),
  );
  return { sessionId: session.id, projectId: project.id, goalInstanceId };
});

/**
 * A session executing a Plan of the given cards, registered as a kanban board in worktrees
 * without an orchestrator loop. Returns the session and its Goal instance.
 */
export const executingBoard = Effect.fn("executingBoard")(function* (
  fixture: KanbanFixture,
  steps: UpdatePlan["steps"],
) {
  const { sessionId, projectId, goalInstanceId } = yield* executingPlan(fixture, steps);
  const session = { id: sessionId };
  const project = { id: projectId };
  yield* (yield* CardWorktrees).prepareGoal({ projectRoot: fixture.project, goalInstanceId });
  yield* (yield* CardAttempts).registerGoal({
    goalInstanceId,
    sessionId: session.id,
    projectId: project.id,
    projectRoot: fixture.project,
    mode: "worktree",
    goalVersion: 1,
  });
  return { sessionId: session.id, projectId: project.id, goalInstanceId };
});

/** Moves a card to in_progress and offers its next attempt, as the orchestrator does. */
export const assignCard = Effect.fn("assignCard")(function* (
  board: { readonly sessionId: string; readonly goalInstanceId: string },
  cardId: string,
  notes: readonly string[] = [],
) {
  const workflows = yield* Workflows;
  const attempts = yield* CardAttempts;
  const state = yield* workflows.transitionCard(
    board.sessionId,
    { cardId, from: "ready", to: "in_progress" },
    BoardAuthor.cases.Orchestrator.make({ runId: "test" }),
  );
  const attemptNo = yield* attempts.nextAttemptNo(board.goalInstanceId, cardId);
  const payload = {
    sessionId: board.sessionId,
    goalInstanceId: board.goalInstanceId,
    cardId,
    attemptNo,
    goalVersion: state.goal?.version ?? 1,
    planVersion: state.plan?.version ?? 1,
    notes,
  };
  yield* attempts.open(payload);
  yield* CardAttemptExecution.execute(payload, { discard: true });
  return payload;
});

/** Points the session at a new Goal instance the way an applied new Goal does. */
export const switchGoalInstance = Effect.fn("switchGoalInstance")(function* (sessionId: string) {
  const sql = yield* SqlClient.SqlClient;
  const now = DateTime.formatIso(yield* DateTime.now);
  const id = `goal-${sessionId}-next`;
  yield* sql`INSERT INTO workflow_goal_instances VALUES (${id}, ${sessionId}, ${now})`;
  yield* sql`UPDATE workflow_goal_identities SET goal_instance_id = ${id}, created_at = ${now}
    WHERE session_id = ${sessionId}`;
  return id;
});

/** Records an agent run row the way a chat run of the card would leave it. */
export const chatRun = Effect.fn("chatRun")(function* (
  runId: string,
  status: "running" | "failed" | "completed",
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO chat_runs (run_id, thread_id, status, started_at)
    VALUES (${runId}, 'card', ${status}, 0)
    ON CONFLICT(run_id) DO UPDATE SET status = excluded.status`;
});

/** An earlier run of the card that stopped with a write whose result nobody knows. */
export const uncertainCardRun = Effect.fn("uncertainCardRun")(function* (
  board: { readonly sessionId: string; readonly goalInstanceId: string },
  cardId: string,
  runId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [revision] = yield* sql<{ readonly id: number | null }>`SELECT MAX(id) AS id
    FROM workflow_state_revisions WHERE session_id = ${board.sessionId}`;
  yield* (yield* workflowRunBindings).bind(board.sessionId, runId, Number(revision?.id));
  yield* chatRun(runId, "failed");
  yield* sql`INSERT INTO owner_rpc_operations
      (run_id, run_key, operation_id, fingerprint, side_effect, reply_json, status)
    VALUES (${runId}, 'k', 1, '{"operation":"tool"}', 1, '{}', 'uncertain')`;
  yield* (yield* CardAttempts).registerRun(
    { goalInstanceId: board.goalInstanceId, cardId, attemptNo: 1 },
    { runId, traceAttemptId: null },
  );
});
