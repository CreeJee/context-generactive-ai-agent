import {
  Array as Arr,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Option,
  Path,
  Queue,
  Ref,
  Schedule,
  Scope,
  Stream,
} from "effect";
import { expect } from "vite-plus/test";
import { layer } from "@effect/vitest";
import {
  card,
  chatRun,
  executingBoard,
  executingPlan,
  executingSession,
  git,
  goalInput,
  kanbanFixture,
  kanbanTestLayer,
  openKanbanOwner,
  uncertainCardRun,
  waitForCards,
  type KanbanFixture,
} from "../testing/kanban.ts";
import { Projects } from "../projects/projects.ts";
import { BoardAuthor } from "../workflow/card.ts";
import { BoardIntent } from "../workflow/contracts.ts";
import { OutcomeLedger } from "../workflow/outcome-ledger.ts";
import { Workflows, type PlanStep } from "../workflow/workflow.ts";
import { GoalChangeVerdict, KanbanBoardActions } from "./board-actions.ts";
import {
  CardAgentOutcome,
  CardVerdict,
  type CardAgentRun,
  type OutcomeVerification,
} from "./card-agent.ts";
import { CardAttempts } from "./card-attempts.ts";
import { VerdictFailure } from "./failures.ts";
import { GoalMergeState, GoalSchedules } from "./goal-schedules.ts";
import {
  DecisionAnswer,
  DecisionKind,
  decisionKindName,
  goalDecisionCardId,
  HumanDecisions,
} from "./human-decision.ts";
import { KanbanOrchestrator } from "./orchestrator.ts";
import { ProjectScheduler } from "./scheduler.ts";

/**
 * Contracts that cross the kanban slices (docs/kanban-orchestration.md): a real git project, owner
 * database, DurableQueue and workflow engine, with only the card agents and verifiers scripted.
 * Closing an owner's scope and opening another over the same files stands for a restart.
 */

const finished: CardAgentOutcome = CardAgentOutcome.Finished({ report: "done" });
const passed: CardVerdict = CardVerdict.Passed({ evidence: ["checked"] });
const orchestrator = BoardAuthor.cases.Orchestrator.make({ runId: "test-model" });

// These tests run real git repositories and worktrees; beside other test files they pass 5s.
const gitTimeout = { timeout: 30_000 };

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
    fs.writeFileString(path.join(agent.worktree.toolRoot, file), text).pipe(Effect.orDie);
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
  (tag: keyof typeof GoalMergeState.cases) =>
  (state: GoalMergeState | null): boolean =>
    GoalMergeState.guards[tag](state);

const goalFile = (fixture: KanbanFixture, goalInstanceId: string, file: string) =>
  git(fixture.project, "show", `ctx/goal/${goalInstanceId}:${file}`);

const user = BoardAuthor.cases.User.make({});

/** The planner's run adds card `id` to the session's running board, as edit_plan does. */
const plannerAdds = Effect.fnUntraced(function* (sessionId: string, id: string) {
  const workflows = yield* Workflows;
  const planVersion = (yield* workflows.get(sessionId)).plan?.version ?? 0;
  yield* workflows.editPlan(
    sessionId,
    { planVersion, edits: [{ action: "add", step: card(id) }] },
    "planner-run",
  );
});

const cardOf = (cards: ReadonlyArray<PlanStep>, id: string) => cards.find((step) => step.id === id);

layer(kanbanTestLayer, { excludeTestServices: true })((it) => {
  it.effect(
    "judges an outcome on the Goal branch once every card serving it is done, and records the verdict",
    () =>
      Effect.gen(function* () {
        const fixture = yield* kanbanFixture;
        const write = yield* writer;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const releaseB = yield* Deferred.make<void>();
        const checks = yield* Ref.make<ReadonlyArray<OutcomeVerification>>([]);
        const seen = yield* Ref.make<ReadonlyArray<string>>([]);
        const run = yield* openKanbanOwner(fixture, yield* Effect.scope, {
          agent: (agent) =>
            Effect.gen(function* () {
              yield* Effect.when(Deferred.await(releaseB), Effect.succeed(agent.card.id === "b"));
              yield* write(agent, `${agent.card.id}.txt`, `${agent.card.id}\n`);
              return finished;
            }),
          verifyOutcome: (input) =>
            Effect.gen(function* () {
              yield* Ref.update(checks, (all) => [...all, input]);
              const present = yield* Effect.filter(["a", "b"], (id) =>
                fs.exists(path.join(input.checkout.toolRoot, `${id}.txt`)),
              );
              yield* Ref.set(seen, present);
              return passed;
            }).pipe(Effect.orDie),
        });
        yield* run(
          Effect.gen(function* () {
            const board = yield* executingPlan(fixture, [card("a"), card("b")]);
            yield* (yield* GoalSchedules).setProtectedBranches(board.projectId, []);
            yield* (yield* KanbanOrchestrator).start(board.sessionId);
            // One serving card done is not the outcome done.
            yield* waitForCards(board.sessionId, (cards) => status(cards, "a") === "done");
            expect(yield* Ref.get(checks)).toEqual([]);
            yield* Deferred.succeed(releaseB, undefined);
            const ledger = yield* OutcomeLedger;
            const [verdict] = yield* eventually(
              ledger.latest(board.goalInstanceId),
              (latest) => latest.length > 0,
            );
            expect(verdict).toMatchObject({
              outcomeId: "O1",
              outcomeText: "Cards are done",
              met: true,
              evidence: ["checked"],
              cards: [{ id: "a" }, { id: "b" }],
            });
            expect(verdict?.goalHead).toMatch(/^[0-9a-f]{40}$/);
            expect((yield* Ref.get(checks)).map((check) => check.cards.map((c) => c.id))).toEqual([
              ["a", "b"],
            ]);
            // It checked the Goal branch with both cards' work in it.
            expect(yield* Ref.get(seen)).toEqual(["a", "b"]);
          }),
        );
      }),
    gitTimeout,
  );

  it.effect(
    "does not run an outcome check again at once when it ended without a verdict",
    () =>
      Effect.gen(function* () {
        const fixture = yield* kanbanFixture;
        const checks = yield* Ref.make(0);
        const run = yield* openKanbanOwner(fixture, yield* Effect.scope, {
          agent: () => Effect.succeed(finished),
          verifyOutcome: () =>
            Effect.as(
              Ref.update(checks, (count) => count + 1),
              CardVerdict.Failed({ failure: VerdictFailure.cases.Unavailable.make({}) }),
            ),
        });
        yield* run(
          Effect.gen(function* () {
            const board = yield* executingPlan(fixture, [card("a")]);
            yield* (yield* GoalSchedules).setProtectedBranches(board.projectId, []);
            yield* (yield* KanbanOrchestrator).start(board.sessionId);
            yield* eventually(Ref.get(checks), (count) => count > 0);
            // Looks keep coming every 50ms; the same check on the same Goal head is not one of them.
            yield* Effect.sleep("500 millis");
            expect(yield* Ref.get(checks)).toBe(1);
            expect(yield* (yield* OutcomeLedger).latest(board.goalInstanceId)).toEqual([]);
          }),
        );
      }),
    gitTimeout,
  );

  it.effect(
    "merges no Goal with an outcome judged not met, asks the model for cards and lets it not complete the Goal",
    () =>
      Effect.gen(function* () {
        const fixture = yield* kanbanFixture;
        const goalChecks = yield* Ref.make(0);
        const run = yield* openKanbanOwner(fixture, yield* Effect.scope, {
          agent: () => Effect.succeed(finished),
          verifyOutcome: () =>
            Effect.succeed(
              CardVerdict.Failed({
                failure: VerdictFailure.cases.Rejected.make({ note: "search is missing" }),
              }),
            ),
          verifyGoal: () =>
            Effect.as(
              Ref.update(goalChecks, (count) => count + 1),
              passed,
            ),
        });
        yield* run(
          Effect.scoped(
            Effect.gen(function* () {
              const board = yield* executingPlan(fixture, [card("a")]);
              yield* (yield* GoalSchedules).setProtectedBranches(board.projectId, []);
              const orchestrator = yield* KanbanOrchestrator;
              const heard = yield* orchestrator.attention.pipe(
                Stream.filter((attention) => attention.reasons.includes("outcomes_open")),
                Stream.runHead,
                Effect.forkScoped,
              );
              yield* orchestrator.start(board.sessionId);
              expect(
                Option.map(yield* Fiber.join(heard), (attention) => attention.sessionId),
              ).toEqual(Option.some(board.sessionId));
              expect(yield* (yield* OutcomeLedger).latest(board.goalInstanceId)).toMatchObject([
                { outcomeId: "O1", met: false, summary: "search is missing" },
              ]);
              // Looks keep coming; none merges or completes the Goal.
              yield* Effect.sleep("300 millis");
              expect(yield* mergeOf(board.goalInstanceId)).toBeNull();
              expect(yield* Ref.get(goalChecks)).toBe(0);
              const workflows = yield* Workflows;
              expect((yield* workflows.get(board.sessionId)).goal?.status).toBe("active");
              // Only the verdicts complete a board's Goal; the model's record is refused.
              const refused = yield* workflows
                .updateProgress(board.sessionId, {
                  goalStatus: "completed",
                  planStatus: "completed",
                  steps: [],
                  goalEvidence: [],
                  planEvidence: [],
                  verification: { status: "passed", summary: "done", evidence: ["looks done"] },
                  detail: "Goal done",
                })
                .pipe(Effect.flip);
              expect(refused).toMatchObject({ reason: "outcomes_complete_goal" });
            }),
          ),
        );
      }),
    gitTimeout,
  );

  it.effect(
    "holds only the cards serving an outcome whose text changed, and no card for a new outcome",
    () =>
      Effect.gen(function* () {
        const fixture = yield* kanbanFixture;
        const started = yield* Queue.unbounded<string>();
        const release = yield* Deferred.make<void>();
        const run = yield* openKanbanOwner(fixture, yield* Effect.scope, {
          cores: 8,
          agent: (agent) =>
            Effect.gen(function* () {
              yield* Queue.offer(started, agent.card.id);
              yield* Deferred.await(release);
              return finished;
            }),
        });
        yield* run(
          Effect.gen(function* () {
            const board = yield* executingPlan(fixture, [
              card("a"),
              { ...card("b"), outcomes: [] },
            ]);
            const workflows = yield* Workflows;
            const attempts = yield* CardAttempts;
            const loop = yield* KanbanOrchestrator;
            yield* loop.start(board.sessionId);
            expect([yield* Queue.take(started), yield* Queue.take(started)].toSorted()).toEqual([
              "a",
              "b",
            ]);
            const stored = attempts.goal(board.goalInstanceId);

            // A new outcome concerns no card: the board only records the Goal version.
            const saved = { id: "O1", text: "Cards are done" };
            const listed = { id: "O2", text: "Cards are listed" };
            yield* workflows.updateGoal(board.sessionId, {
              ...goalInput,
              outcomes: [saved, listed],
            });
            yield* loop.poke(board.goalInstanceId);
            yield* eventually(
              stored,
              Option.exists((goal) => goal.goalVersion === 2),
            );
            expect(Option.map(yield* stored, (goal) => goal.hold)).toEqual(Option.some(null));

            // O1 reworded holds a, which serves it; b serves no changed outcome and goes on.
            yield* workflows.updateGoal(board.sessionId, {
              ...goalInput,
              outcomes: [{ ...saved, text: "Cards are done twice" }, listed],
            });
            yield* loop.poke(board.goalInstanceId);
            const held = yield* eventually(
              stored,
              Option.exists((goal) => goal.hold !== null),
            );
            expect(Option.map(held, (goal) => goal.hold)).toEqual(
              Option.some({ _tag: "GoalChanged", fromVersion: 2, toVersion: 3, cards: ["a"] }),
            );
            yield* Deferred.succeed(release, undefined);
            const cards = yield* waitForCards(
              board.sessionId,
              (cards) => status(cards, "b") === "done",
            );
            // a finished against the earlier Goal; it waits for its verdict.
            expect(status(cards, "a")).toBe("in_progress");

            yield* (yield* KanbanBoardActions).applyGoalChange(
              board.sessionId,
              [GoalChangeVerdict.cases.Continue.make({ cardId: "a" })],
              orchestrator,
            );
            yield* waitForCards(board.sessionId, allDone);
          }),
        );
      }),
    gitTimeout,
  );

  it.effect(
    "runs a Goal's cards in parallel by dependency, squashes one commit per card, merges the checked Goal and completes it",
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
            // Merged with its one outcome met, the Goal and its Plan complete from the verdict.
            const workflows = yield* Workflows;
            const completed = yield* eventually(
              workflows.get(board.sessionId),
              (state) => state.phase === "completed",
            );
            expect(completed.goal).toMatchObject({
              status: "completed",
              verification: { status: "passed", evidence: ["O1: outcome O1 met"] },
            });
            expect(completed.plan?.status).toBe("completed");
            return board.goalInstanceId;
          }),
        );
        // A card that finished beside another syncs with the moved Goal branch and is verified again.
        expect(Arr.dedupe(yield* Ref.get(verified)).toSorted()).toEqual(["a", "b", "c"]);
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
        yield* Effect.forEach(
          ["a", "b", "c"],
          Effect.fnUntraced(function* (id) {
            expect(yield* fs.readFileString(`${fixture.project}/${id}.txt`)).toBe(`${id}\n`);
          }),
          { discard: true },
        );
      }),
    gitTimeout,
  );

  it.effect(
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
            const file = path.join(agent.worktree.toolRoot, `${agent.card.id}.out`);
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
              kind: DecisionKind.cases.UncertainSideEffect.make({ runId: "run-b", toolNames: [] }),
            });
          }),
        );
        // a continued the earlier conversation in the same worktree and did not write again; b never ran.
        const runs = yield* Ref.get(continued);
        expect(
          runs.map((agent) => [agent.card.id, agent.continuation, agent.worktree.toolRoot]),
        ).toEqual([["a", true, worktreeOf("a")]]);
        expect((yield* Ref.get(writes)).toSorted()).toEqual(["a", "b"]);
        expect(yield* goalFile(fixture, board.goalInstanceId, "a.out")).toBe("a");
        // b's worktree waits for the person with its work in place.
        expect(yield* fs.readFileString(path.join(worktreeOf("b"), "b.out"))).toBe("b\n");
      }),
    gitTimeout,
  );

  it.effect(
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
              inbox.map((request) => [
                request.goalInstanceId,
                request.cardId,
                decisionKindName(request.kind),
              ]),
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
              answer: DecisionAnswer.cases.UncertainSideEffect.make({ choice: "continue" }),
            });
            yield* orchestrator.poke(goalU.goalInstanceId);
            yield* waitForCards(goalU.sessionId, allDone);
            // W still waits: M has not merged.
            expect(yield* Ref.get(ran)).toEqual(["m", "u"]);

            yield* decisions.answer({
              ...protectedMerge!,
              answer: DecisionAnswer.cases.ProtectedBranchMerge.make({ choice: "manual_merge" }),
            });
            yield* orchestrator.poke(goalM.goalInstanceId);
            yield* eventually(mergeOf(goalM.goalInstanceId), mergeIs("ManualMerge"));
            yield* waitForCards(goalW.sessionId, allDone);
          }),
        );
        expect(yield* Ref.get(ran)).toEqual(["m", "u", "w"]);
      }),
    gitTimeout,
  );

  it.effect(
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
                GoalChangeVerdict.cases.Amend.make({
                  cardId: "a",
                  patch: { title: "Card a v2" },
                  note: "The Goal now wants v2.",
                }),
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
      }),
    gitTimeout,
  );

  it.effect(
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
                GoalChangeVerdict.cases.Amend.make({
                  cardId: "a",
                  patch: { title: "Card a v2" },
                  note: "The Goal now wants v2.",
                }),
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
      }),
    gitTimeout,
  );

  it.effect(
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
        yield* second(
          waitForCards(board.sessionId, (cards) => status(cards, "a") !== "in_progress"),
        );
        expect(yield* Queue.take(runs)).toMatchObject({
          attemptNo: 1,
          notes: ["A person found the earlier work missing."],
        });
      }),
    gitTimeout,
  );

  it.effect(
    "runs a card the planner added to a board the user approved only once the user approves it",
    () =>
      Effect.gen(function* () {
        const fixture = yield* kanbanFixture;
        const runs = yield* Queue.unbounded<string>();
        const releaseA = yield* Deferred.make<void>();
        const run = yield* openKanbanOwner(fixture, yield* Effect.scope, {
          agent: (agent) =>
            Effect.gen(function* () {
              yield* Queue.offer(runs, agent.card.id);
              if (agent.card.id === "a") yield* Deferred.await(releaseA);
              return finished;
            }),
        });
        yield* run(
          Effect.gen(function* () {
            const board = yield* executingPlan(fixture, [card("a")]);
            const orchestrator = yield* KanbanOrchestrator;
            yield* orchestrator.start(board.sessionId);
            expect(yield* Queue.take(runs)).toBe("a");

            yield* plannerAdds(board.sessionId, "b");
            const added = cardOf((yield* (yield* Workflows).get(board.sessionId)).plan!.steps, "b");
            expect([added?.status, added?.approval?.requestedBy]).toEqual([
              "backlog",
              BoardAuthor.cases.Orchestrator.make({ runId: "planner-run" }),
            ]);
            // The approved card keeps running and finishes; the waiting one is never assigned.
            yield* Deferred.succeed(releaseA, undefined);
            const waiting = yield* waitForCards(
              board.sessionId,
              (cards) => status(cards, "a") === "done",
            );
            expect(cardOf(waiting, "b")?.status).toBe("backlog");
            expect(yield* Queue.size(runs)).toBe(0);

            yield* (yield* KanbanBoardActions).applyIntent(
              board.sessionId,
              BoardIntent.cases.Approve.make({ cardId: "b" }),
              user,
            );
            expect(yield* Queue.take(runs)).toBe("b");
            const cards = yield* waitForCards(board.sessionId, allDone);
            expect(cardOf(cards, "b")?.approval).toBeUndefined();
          }),
        );
      }),
    gitTimeout,
  );

  it.effect(
    "approves the cards a Goal mode planner adds as the project's permission mode says",
    () =>
      Effect.gen(function* () {
        const fixture = yield* kanbanFixture;
        const reviewed = yield* Queue.unbounded<ReadonlyArray<string>>();
        // Card a runs until the end, so the Goal does not complete while cards are added.
        const releaseA = yield* Deferred.make<void>();
        const run = yield* openKanbanOwner(fixture, yield* Effect.scope, {
          cores: 4,
          agent: (agent) =>
            agent.card.id === "a"
              ? Effect.as(Deferred.await(releaseA), finished)
              : Effect.succeed(finished),
          reviewCards: (request) =>
            Effect.as(
              Queue.offer(
                reviewed,
                request.cards.map((step) => step.id),
              ),
              Option.some({ decision: "ask" as const, reason: "The Goal never asked for c." }),
            ),
        });
        yield* run(
          Effect.gen(function* () {
            const board = yield* executingPlan(fixture, [card("a")]);
            const projects = yield* Projects;
            const orchestrator = yield* KanbanOrchestrator;
            yield* projects.setPermissionMode(board.projectId, "full");
            yield* orchestrator.start(board.sessionId, "permission");
            // full: a card the planner adds runs without anyone approving it.
            yield* plannerAdds(board.sessionId, "b");
            const approved = yield* waitForCards(
              board.sessionId,
              (cards) => status(cards, "b") === "done",
            );
            expect(cardOf(approved, "b")?.approval).toBeUndefined();

            // auto: the reviewer judges it and leaves it to the user with the reason.
            yield* projects.setPermissionMode(board.projectId, "auto");
            yield* plannerAdds(board.sessionId, "c");
            expect(yield* Queue.take(reviewed)).toEqual(["c"]);
            const left = yield* waitForCards(
              board.sessionId,
              (cards) => cardOf(cards, "c")?.approval?.review !== undefined,
            );
            expect(cardOf(left, "c")).toMatchObject({
              status: "backlog",
              approval: { review: { decision: "ask", reason: "The Goal never asked for c." } },
            });
            yield* (yield* KanbanBoardActions).applyIntent(
              board.sessionId,
              BoardIntent.cases.Approve.make({ cardId: "c" }),
              user,
            );
            yield* waitForCards(board.sessionId, (cards) => status(cards, "c") === "done");
            yield* Deferred.succeed(releaseA, undefined);
            yield* waitForCards(board.sessionId, allDone);
            // A reviewed card is not reviewed again.
            expect(yield* Queue.size(reviewed)).toBe(0);
          }),
        );
      }),
    gitTimeout,
  );

  it.effect(
    "stops waking the planner after three rounds without a newly met outcome until the user speaks",
    () =>
      Effect.gen(function* () {
        const fixture = yield* kanbanFixture;
        const run = yield* openKanbanOwner(fixture, yield* Effect.scope, {
          agent: () => Effect.succeed(finished),
          verifyOutcome: () =>
            Effect.succeed(
              CardVerdict.Failed({
                failure: VerdictFailure.cases.Rejected.make({ note: "search is missing" }),
              }),
            ),
        });
        yield* run(
          Effect.scoped(
            Effect.gen(function* () {
              const board = yield* executingPlan(fixture, [card("a")]);
              yield* (yield* Projects).setPermissionMode(board.projectId, "full");
              const orchestrator = yield* KanbanOrchestrator;
              const heard = yield* Queue.unbounded<string>();
              yield* orchestrator.attention.pipe(
                Stream.filter((attention) => attention.reasons.includes("outcomes_open")),
                Stream.runForEach((attention) => Queue.offer(heard, attention.sessionId)),
                Effect.forkScoped,
              );
              yield* orchestrator.start(board.sessionId, "permission");
              // Each round the planner adds a card for the outcome, which is judged not met again.
              yield* Effect.forEach(
                ["fix1", "fix2", "fix3"],
                (id) => Effect.andThen(Queue.take(heard), plannerAdds(board.sessionId, id)),
                { discard: true },
              );
              const stalled = Effect.map(
                (yield* KanbanBoardActions).view(board.sessionId),
                Option.exists((view) => view.plannerStalled),
              );
              yield* eventually(stalled, (found) => found);
              expect(yield* Queue.size(heard)).toBe(0);

              // The user's turn is the direction it waited for: the planner is woken again.
              yield* orchestrator.resumePlanner(board.sessionId);
              expect(yield* Queue.take(heard)).toBe(board.sessionId);
              expect(yield* stalled).toBe(false);
            }),
          ),
        );
      }),
    gitTimeout,
  );
});
