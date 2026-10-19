import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Queue,
  Ref,
  Schedule,
  Scope,
} from "effect";
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import {
  card,
  chatRun,
  executingBoard,
  executingPlan,
  executingSession,
  git,
  goalInput,
  kanbanFixture,
  openKanbanOwner,
  uncertainCardRun,
  waitForCards,
  type KanbanFixture,
} from "../testing/kanban.ts";
import { Workflows, type PlanStep } from "../workflow/workflow.ts";
import { KanbanBoardActions } from "./board-actions.ts";
import type { CardAgentOutcome, CardAgentRun, CardVerdict } from "./card-agent.ts";
import { CardAttempts } from "./card-attempts.ts";
import { GoalSchedules, type GoalMergeState } from "./goal-schedules.ts";
import { goalDecisionCardId, HumanDecisions } from "./human-decision.ts";
import { KanbanOrchestrator } from "./orchestrator.ts";
import { ProjectScheduler } from "./scheduler.ts";

/**
 * Contracts that cross the kanban slices (docs/kanban-orchestration.md): a real git project, owner
 * database, DurableQueue and workflow engine, with only the card agents and verifiers scripted.
 * Closing an owner's scope and opening another over the same files stands for a restart.
 */

const finished: CardAgentOutcome = { _tag: "Finished", report: "done" };
const passed: CardVerdict = { _tag: "Passed", evidence: ["checked"] };
const orchestrator = { _tag: "Orchestrator", runId: "test-model" } as const;

// These tests run real git repositories and worktrees; beside other test files they pass 5s.
const gitTimeout = { timeout: 30_000 };

const withNode = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.flatMap(Layer.build(NodeServices.layer), (context) =>
    Effect.provideContext(program, context),
  ).pipe(Effect.scoped);

const eventually = <A, E, R>(check: Effect.Effect<A, E, R>, done: (value: A) => boolean) =>
  check.pipe(
    Effect.repeat({ until: done, schedule: Schedule.spaced("20 millis") }),
    Effect.timeout("15 seconds"),
  );

/** Writes a file in the card's worktree, as the card's agent would. */
const writer = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return (agent: CardAgentRun, file: string, text: string) =>
    fs.writeFileString(path.join(agent.worktree?.toolRoot ?? "", file), text).pipe(Effect.orDie);
});

const status = (cards: ReadonlyArray<PlanStep>, id: string) =>
  cards.find((step) => step.id === id)?.status;
const allDone = (cards: ReadonlyArray<PlanStep>) =>
  cards.length > 0 && cards.every((step) => step.status === "done");

const mergeOf = (goalInstanceId: string) =>
  Effect.map(
    GoalSchedules.use((schedules) => schedules.get(goalInstanceId)),
    (found): GoalMergeState | null => Option.getOrNull(Option.map(found, (s) => s.merge)),
  );
const mergeIs =
  (tag: GoalMergeState["_tag"]) =>
  (state: GoalMergeState | null): boolean =>
    state?._tag === tag;

const goalFile = (fixture: KanbanFixture, goalInstanceId: string, file: string) =>
  git(fixture.project, "show", `ctx/goal/${goalInstanceId}:${file}`);

it.live(
  "runs a Goal's cards in parallel by dependency, squashes one commit per card and merges the checked Goal",
  () =>
    Effect.gen(function* () {
      const fixture = yield* kanbanFixture;
      const write = yield* writer;
      const started = yield* Queue.unbounded<string>();
      const release = yield* Deferred.make<void>();
      const verified = yield* Ref.make<ReadonlyArray<string>>([]);
      const goalChecks = yield* Ref.make(0);
      const base = yield* git(fixture.project, "rev-parse", "main");
      const run = yield* openKanbanOwner(fixture, yield* Effect.scope, {
        // Eight cores: up to four cards at once.
        cores: 8,
        agent: (agent) =>
          Effect.gen(function* () {
            yield* Queue.offer(started, agent.card.id);
            yield* Deferred.await(release);
            yield* write(agent, `${agent.card.id}.txt`, `${agent.card.id}\n`);
            return finished;
          }),
        verify: (input) =>
          Effect.as(
            Ref.update(verified, (ids) => [...ids, input.card.id]),
            passed,
          ),
        verifyGoal: () =>
          Effect.as(
            Ref.update(goalChecks, (count) => count + 1),
            passed,
          ),
      });
      const goal = yield* run(
        Effect.gen(function* () {
          const board = yield* executingPlan(fixture, [
            card("a"),
            card("b"),
            { ...card("c"), dependsOn: ["a", "b"] },
          ]);
          yield* (yield* GoalSchedules).setProtectedBranches(board.projectId, []);
          yield* (yield* KanbanOrchestrator).start(board.sessionId);
          // a and b run together; c waits for both.
          expect([yield* Queue.take(started), yield* Queue.take(started)].toSorted()).toEqual([
            "a",
            "b",
          ]);
          expect(status(yield* waitForCards(board.sessionId, () => true), "c")).toBe("backlog");
          yield* Deferred.succeed(release, undefined);
          expect(yield* Queue.take(started)).toBe("c");
          yield* eventually(mergeOf(board.goalInstanceId), mergeIs("Merged"));
          expect(yield* waitForCards(board.sessionId, allDone)).toHaveLength(3);
          return board.goalInstanceId;
        }),
      );
      // A card that finished beside another syncs with the moved Goal branch and is verified again.
      expect([...new Set(yield* Ref.get(verified))].toSorted()).toEqual(["a", "b", "c"]);
      expect(yield* Ref.get(goalChecks)).toBe(1);
      // One squash commit per card, no merge commits, and main is the checked Goal branch.
      expect(yield* git(fixture.project, "rev-parse", "main")).toBe(
        yield* git(fixture.project, "rev-parse", `ctx/goal/${goal}`),
      );
      expect(yield* git(fixture.project, "rev-list", "--count", `${base}..main`)).toBe("3");
      expect(yield* git(fixture.project, "rev-list", "--merges", `${base}..main`)).toBe("");
      const trailers = yield* git(
        fixture.project,
        "log",
        "--format=%(trailers:key=Ctx-Card,valueonly)",
        `${base}..main`,
      );
      expect(
        trailers
          .split("\n")
          .filter((line) => line.length > 0)
          .toSorted(),
      ).toEqual([`${goal}/a`, `${goal}/b`, `${goal}/c`]);
      expect(yield* git(fixture.project, "log", "-1", "--format=%s", "main")).toBe("Card c");
      expect(yield* git(fixture.project, "status", "--porcelain")).toBe("");
      const fs = yield* FileSystem.FileSystem;
      for (const id of ["a", "b", "c"])
        expect(yield* fs.readFileString(`${fixture.project}/${id}.txt`)).toBe(`${id}\n`);
    }).pipe(withNode),
  gitTimeout,
);

it.live(
  "after a crash before the result was recorded, continues cards in their worktrees and asks about an uncertain run",
  () =>
    Effect.gen(function* () {
      const fixture = yield* kanbanFixture;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const writes = yield* Ref.make<ReadonlyArray<string>>([]);
      /** Writes the card's file only when it is not there yet, like an agent reading its worktree. */
      const writeOnce = (agent: CardAgentRun) =>
        Effect.gen(function* () {
          const file = path.join(agent.worktree?.toolRoot ?? "", `${agent.card.id}.out`);
          if (yield* fs.exists(file)) return;
          yield* fs.writeFileString(file, `${agent.card.id}\n`);
          yield* Ref.update(writes, (list) => [...list, agent.card.id]);
        }).pipe(Effect.orDie);

      // The first owner's agents register their runs and write, then the owner dies.
      const wrote = yield* Queue.unbounded<string>();
      const crashed = yield* Scope.make();
      const first = yield* openKanbanOwner(fixture, crashed, {
        cores: 4,
        agent: (agent) =>
          Effect.gen(function* () {
            yield* agent
              .register({ runId: `run-${agent.card.id}`, traceAttemptId: null })
              .pipe(Effect.orDie);
            yield* writeOnce(agent);
            yield* Queue.offer(wrote, agent.card.id);
            return yield* Effect.never;
          }),
      });
      const board = yield* first(
        Effect.gen(function* () {
          const board = yield* executingPlan(fixture, [card("a"), card("b")]);
          yield* (yield* KanbanOrchestrator).start(board.sessionId);
          yield* Queue.take(wrote);
          yield* Queue.take(wrote);
          // Starting up marks the cut-off chat runs failed. a ran no tool with an unknown result;
          // b's last write never reported back.
          yield* chatRun("run-a", "failed");
          yield* uncertainCardRun(board, "b", "run-b");
          return board;
        }),
      );
      const worktreeOf = (cardId: string) =>
        path.join(fixture.worktrees, board.goalInstanceId, cardId);
      yield* Scope.close(crashed, Exit.void);

      const continued = yield* Ref.make<ReadonlyArray<CardAgentRun>>([]);
      const second = yield* openKanbanOwner(fixture, yield* Effect.scope, {
        cores: 4,
        agent: (agent) =>
          Effect.gen(function* () {
            yield* Ref.update(continued, (list) => [...list, agent]);
            yield* writeOnce(agent);
            return finished;
          }),
      });
      yield* second(
        Effect.gen(function* () {
          const cards = yield* waitForCards(
            board.sessionId,
            (cards) => status(cards, "a") === "done" && status(cards, "b") === "human_decision",
          );
          expect(cards.map((step) => step.status)).toEqual(["done", "human_decision"]);
          const [request] = yield* eventually(
            (yield* HumanDecisions).pending(board.sessionId),
            (pending) => pending.length > 0,
          );
          expect(request).toMatchObject({
            cardId: "b",
            kind: { _tag: "UncertainSideEffect", runId: "run-b" },
          });
        }),
      );
      // a continued the earlier conversation in the same worktree and did not write again; b never ran.
      const runs = yield* Ref.get(continued);
      expect(
        runs.map((agent) => [agent.card.id, agent.continuation, agent.worktree?.path]),
      ).toEqual([["a", true, worktreeOf("a")]]);
      expect((yield* Ref.get(writes)).toSorted()).toEqual(["a", "b"]);
      expect(yield* goalFile(fixture, board.goalInstanceId, "a.out")).toBe("a");
      // b's worktree waits for the person with its work in place.
      expect(yield* fs.readFileString(path.join(worktreeOf("b"), "b.out"))).toBe("b\n");
    }).pipe(withNode),
  gitTimeout,
);

it.live(
  "keeps waits for a person, a protected merge and another Goal across a restart, and continues each on its answer",
  () =>
    Effect.gen(function* () {
      const fixture = yield* kanbanFixture;
      const ran = yield* Ref.make<ReadonlyArray<string>>([]);
      const agent = (run: CardAgentRun) =>
        Effect.as(
          Ref.update(ran, (ids) => [...ids, run.card.id]),
          finished,
        );
      const firstScope = yield* Scope.make();
      const first = yield* openKanbanOwner(fixture, firstScope, { cores: 4, agent });
      const goals = yield* first(
        Effect.gen(function* () {
          const orchestrator = yield* KanbanOrchestrator;
          const decisions = yield* HumanDecisions;
          const scheduler = yield* ProjectScheduler;
          // Goal U's card has an earlier run whose effect nobody knows.
          const goalU = yield* executingPlan(fixture, [card("u")]);
          yield* uncertainCardRun(goalU, "u", "run-0");
          yield* orchestrator.start(goalU.sessionId);
          // Goal M finishes, but main is protected: a person picks how it merges.
          const goalM = yield* executingSession(goalU.projectId, [card("m")]);
          yield* orchestrator.start(goalM.sessionId);
          // Goal W waits for Goal M to merge.
          const goalW = yield* executingSession(goalU.projectId, [card("w")]);
          yield* (yield* GoalSchedules).register({
            goalInstanceId: goalW.goalInstanceId,
            projectId: goalW.projectId,
            targetBranch: "main",
          });
          yield* scheduler.setDependencies(goalW.goalInstanceId, [goalM.goalInstanceId]);
          yield* orchestrator.start(goalW.sessionId);

          yield* eventually(decisions.pending(goalU.sessionId), (pending) => pending.length > 0);
          yield* eventually(mergeOf(goalM.goalInstanceId), mergeIs("AwaitingDecision"));
          return { goalU, goalM, goalW };
        }),
      );
      yield* Scope.close(firstScope, Exit.void);
      expect(yield* Ref.get(ran)).toEqual(["m"]);

      const second = yield* openKanbanOwner(fixture, yield* Effect.scope, { cores: 4, agent });
      yield* second(
        Effect.gen(function* () {
          const { goalU, goalM, goalW } = goals;
          const orchestrator = yield* KanbanOrchestrator;
          const decisions = yield* HumanDecisions;
          const inbox = yield* decisions.inbox(goalU.projectId);
          expect(
            inbox.map((request) => [request.goalInstanceId, request.cardId, request.kind._tag]),
          ).toEqual([
            [goalU.goalInstanceId, "u", "UncertainSideEffect"],
            [goalM.goalInstanceId, goalDecisionCardId, "ProtectedBranchMerge"],
          ]);
          expect(yield* (yield* ProjectScheduler).waitingOn(goalW.goalInstanceId)).toEqual([
            goalM.goalInstanceId,
          ]);

          const [uncertain, protectedMerge] = inbox;
          yield* decisions.answer({
            ...uncertain!,
            answer: { _tag: "UncertainSideEffect", choice: "continue" },
          });
          yield* orchestrator.poke(goalU.goalInstanceId);
          yield* waitForCards(goalU.sessionId, allDone);
          // W still waits: M has not merged.
          expect(yield* Ref.get(ran)).toEqual(["m", "u"]);

          yield* decisions.answer({
            ...protectedMerge!,
            answer: { _tag: "ProtectedBranchMerge", choice: "manual_merge" },
          });
          yield* orchestrator.poke(goalM.goalInstanceId);
          yield* eventually(mergeOf(goalM.goalInstanceId), mergeIs("ManualMerge"));
          yield* waitForCards(goalW.sessionId, allDone);
        }),
      );
      expect(yield* Ref.get(ran)).toEqual(["m", "u", "w"]);
    }).pipe(withNode),
  gitTimeout,
);

it.live(
  "sends an amendment to a running card, which continues with the changed card",
  () =>
    Effect.gen(function* () {
      const fixture = yield* kanbanFixture;
      const write = yield* writer;
      const runs = yield* Queue.unbounded<CardAgentRun>();
      const release = yield* Deferred.make<void>();
      const run = yield* openKanbanOwner(fixture, yield* Effect.scope, {
        agent: (agent) =>
          Effect.gen(function* () {
            yield* Queue.offer(runs, agent);
            yield* Deferred.await(release);
            yield* write(agent, "a.txt", `${agent.card.title}\n`);
            return finished;
          }),
      });
      const goalInstanceId = yield* run(
        Effect.gen(function* () {
          const board = yield* executingPlan(fixture, [card("a")]);
          const workflows = yield* Workflows;
          yield* (yield* KanbanOrchestrator).start(board.sessionId);
          expect(yield* Queue.take(runs)).toMatchObject({ attemptNo: 1, notes: [] });

          yield* workflows.updateGoal(board.sessionId, { ...goalInput, statement: "Run v2" });
          yield* (yield* KanbanOrchestrator).poke(board.goalInstanceId);
          const view = Effect.map(
            (yield* KanbanBoardActions).view(board.sessionId),
            Option.getOrUndefined,
          );
          yield* eventually(view, (found) => found?.goalChange !== null);
          yield* (yield* KanbanBoardActions).applyGoalChange(
            board.sessionId,
            [
              {
                _tag: "Amend",
                cardId: "a",
                patch: { title: "Card a v2" },
                note: "The Goal now wants v2.",
              },
            ],
            orchestrator,
          );
          expect(yield* Queue.take(runs)).toMatchObject({
            attemptNo: 2,
            card: { title: "Card a v2" },
            notes: ["The Goal now wants v2."],
          });
          yield* Deferred.succeed(release, undefined);
          yield* waitForCards(board.sessionId, allDone);
          return board.goalInstanceId;
        }),
      );
      expect(yield* goalFile(fixture, goalInstanceId, "a.txt")).toBe("Card a v2");
    }).pipe(withNode),
  gitTimeout,
);

it.live(
  "does not integrate work verified before the card was amended during its verification",
  () =>
    Effect.gen(function* () {
      const fixture = yield* kanbanFixture;
      const write = yield* writer;
      const verifying = yield* Deferred.make<void>();
      const releaseVerify = yield* Deferred.make<void>();
      const run = yield* openKanbanOwner(fixture, yield* Effect.scope, {
        agent: (agent) => Effect.as(write(agent, "a.txt", `${agent.card.title}\n`), finished),
        verify: (input) =>
          Effect.gen(function* () {
            // The first verification is still running when the card changes.
            if (input.card.title === "Card a") {
              yield* Deferred.succeed(verifying, undefined);
              yield* Deferred.await(releaseVerify);
            }
            return passed;
          }),
      });
      const goalInstanceId = yield* run(
        Effect.gen(function* () {
          const board = yield* executingPlan(fixture, [card("a")]);
          const workflows = yield* Workflows;
          const actions = yield* KanbanBoardActions;
          yield* (yield* KanbanOrchestrator).start(board.sessionId);
          yield* Deferred.await(verifying);

          yield* workflows.updateGoal(board.sessionId, { ...goalInput, statement: "Run v2" });
          yield* (yield* KanbanOrchestrator).poke(board.goalInstanceId);
          const view = Effect.map(actions.view(board.sessionId), Option.getOrUndefined);
          yield* eventually(view, (found) => found?.goalChange !== null);
          yield* actions.applyGoalChange(
            board.sessionId,
            [
              {
                _tag: "Amend",
                cardId: "a",
                patch: { title: "Card a v2" },
                note: "The Goal now wants v2.",
              },
            ],
            orchestrator,
          );
          yield* Deferred.succeed(releaseVerify, undefined);
          const cards = yield* waitForCards(board.sessionId, allDone);
          expect(cards[0]?.title).toBe("Card a v2");
          return board.goalInstanceId;
        }),
      );
      expect(yield* goalFile(fixture, goalInstanceId, "a.txt")).toBe("Card a v2");
    }).pipe(withNode),
  gitTimeout,
);

it.live(
  "keeps a card's notes when the owner died after opening its attempt and before starting it",
  () =>
    Effect.gen(function* () {
      const fixture = yield* kanbanFixture;
      const runs = yield* Queue.unbounded<CardAgentRun>();
      const agent = (run: CardAgentRun) => Effect.as(Queue.offer(runs, run), finished);
      const firstScope = yield* Scope.make();
      const first = yield* openKanbanOwner(fixture, firstScope, { agent });
      const board = yield* first(
        Effect.gen(function* () {
          const board = yield* executingBoard(fixture, [card("a")]);
          const attempts = yield* CardAttempts;
          // The loop assigned the card with a person's note and opened its attempt, then died
          // before the attempt's workflow started.
          yield* (yield* Workflows).transitionCard(
            board.sessionId,
            { cardId: "a", from: "ready", to: "in_progress" },
            orchestrator,
          );
          yield* attempts.updateLadder(board.goalInstanceId, "a", (current) => ({
            ...current,
            notes: ["A person found the earlier work missing."],
          }));
          yield* attempts.open({
            sessionId: board.sessionId,
            goalInstanceId: board.goalInstanceId,
            cardId: "a",
            attemptNo: 1,
            goalVersion: 1,
            planVersion: 1,
          });
          return board;
        }),
      );
      yield* Scope.close(firstScope, Exit.void);

      const second = yield* openKanbanOwner(fixture, yield* Effect.scope, { agent });
      yield* second(waitForCards(board.sessionId, (cards) => status(cards, "a") !== "in_progress"));
      expect(yield* Queue.take(runs)).toMatchObject({
        attemptNo: 1,
        notes: ["A person found the earlier work missing."],
      });
    }).pipe(withNode),
  gitTimeout,
);
