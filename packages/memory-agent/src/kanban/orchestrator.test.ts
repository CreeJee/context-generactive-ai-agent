import {
  Array as Arr,
  Context,
  Deferred,
  Effect,
  Exit,
  FiberMap,
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
import { layer } from "@effect/vitest";
import { sqlGet, sqlRun } from "../../tests/support/sql.ts";
import { Database } from "../db/database.ts";
import type { JsonValue } from "../json.ts";
import { AppEvents } from "../events/app-events.ts";
import {
  attemptOutcome,
  card,
  executingBoard,
  executingPlan,
  git,
  goalInput,
  kanbanBoardOwner,
  kanbanFixture,
  kanbanTestLayer,
  replaceGoal,
  scriptedAgent,
  uncertainCardRun,
  waitForCards,
  type KanbanFixture,
} from "../testing/kanban.ts";
import { BoardEdit, BoardEditResult, BoardIntent } from "../workflow/board-edit.ts";
import { BoardAuthor } from "../workflow/card.ts";
import type { PlanStep } from "../workflow/workflow.ts";
import { Workflows } from "../workflow/workflow.ts";
import { ChangeDecision, GoalChangeVerdict, KanbanBoardActions } from "./board-actions.ts";
import {
  CardAgentOutcome,
  CardVerdict,
  CardVerifier,
  type CardAgentRun,
  type CardVerification,
} from "./card-agent.ts";
import { CardAttempts } from "./card-attempts.ts";
import { CardRuns } from "./card-queue.ts";
import { CardFailure, CardHoldReason } from "./failures.ts";
import { GoalSchedules } from "./goal-schedules.ts";
import { KanbanTools } from "./tools.ts";
import { GoalOrder } from "./goal-order.ts";
import { Boards } from "../workflow/board.ts";
import { OutcomeLedger } from "../workflow/outcome-ledger.ts";
import {
  DecisionAnswer,
  DecisionKind,
  DecisionState,
  HumanDecisionRefused,
  HumanDecisions,
  type HumanDecisionRequest,
} from "./human-decision.ts";
import { KanbanOrchestrator } from "./orchestrator.ts";
import { CardWorktrees } from "./worktree.ts";

type Owner = Layer.Success<ReturnType<typeof kanbanBoardOwner>>;

const orchestrator = BoardAuthor.cases.Orchestrator.make({ runId: "test-model" });
const user = BoardAuthor.cases.User.make({});
const finished: CardAgentOutcome = CardAgentOutcome.Finished({ report: "done" });

/** Opens an owner with the orchestrator loop over the fixture; closing the scope stops it. */
const openOwner = (
  fixture: KanbanFixture,
  agent: (run: CardAgentRun) => Effect.Effect<CardAgentOutcome>,
  scope: Scope.Scope,
  options: {
    readonly verify?: (input: CardVerification) => Effect.Effect<void>;
    readonly cores?: number;
  } = {},
) =>
  Effect.map(
    Layer.buildWithScope(
      kanbanBoardOwner({
        fixture,
        agent: scriptedAgent(agent),
        verifier: Layer.succeed(
          CardVerifier,
          CardVerifier.of({
            verify: (input) =>
              Effect.as(
                options.verify?.(input) ?? Effect.void,
                CardVerdict.Passed({ evidence: [`verified ${input.card.id}`] }),
              ),
          }),
        ),
        cores: options.cores ?? 2,
      }),
      scope,
    ),
    (context) =>
      <A, E>(effect: Effect.Effect<A, E, Owner>) =>
        Effect.provideContext(effect, context),
  );

// These tests run real git repositories and worktrees; beside other test files they pass 5s.
const gitTimeout = { timeout: 30_000 };

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

/** Starts the session's Plan as a kanban board. */
const startBoard = Effect.fn("startBoard")(function* (
  fixture: KanbanFixture,
  steps: Parameters<typeof executingPlan>[1],
) {
  const board = yield* executingPlan(fixture, steps);
  yield* (yield* KanbanOrchestrator).start(board.sessionId);
  return board;
});

/** Repeats `check` until `done`, checking as the test's own fiber. */
const eventually = <A, E, R>(check: Effect.Effect<A, E, R>, done: (value: A) => boolean) =>
  check.pipe(
    Effect.repeat({ until: done, schedule: Schedule.spaced("20 millis") }),
    Effect.timeout("15 seconds"),
  );

/** Answers a card's request as a person on the board does, then wakes the board's loop. */
const answer = Effect.fn("answer")(function* (
  request: HumanDecisionRequest,
  decided: DecisionAnswer,
) {
  const answered = yield* (yield* HumanDecisions).answer({ ...request, answer: decided });
  yield* (yield* KanbanOrchestrator).poke(request.goalInstanceId);
  return answered;
});

const goalFile = (fixture: KanbanFixture, goalInstanceId: string, file: string) =>
  git(fixture.project, "show", `ctx/goal/${goalInstanceId}:${file}`);

/** Commits `text` as a.txt on the Goal branch from a checkout of its own, as other work would. */
const advanceGoal = Effect.fn("advanceGoal")(function* (
  fixture: KanbanFixture,
  goalInstanceId: string,
  text: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const advance = path.join(fixture.home, "advance");
  yield* git(fixture.project, "worktree", "add", "--quiet", advance, `ctx/goal/${goalInstanceId}`);
  yield* fs.writeFileString(path.join(advance, "a.txt"), text);
  yield* git(advance, "commit", "--quiet", "-am", "elsewhere");
  yield* git(fixture.project, "worktree", "remove", advance);
});

layer(kanbanTestLayer, { excludeTestServices: true })((it) => {
  it.effect(
    "syncs a card with an advanced Goal and verifies it again before squashing",
    () =>
      Effect.gen(function* () {
        const fixture = yield* kanbanFixture;
        const write = yield* writer;
        const verified = yield* Ref.make<ReadonlyArray<string>>([]);
        const bWrote = yield* Deferred.make<void>();
        const releaseB = yield* Deferred.make<void>();
        const run = yield* openOwner(
          fixture,
          (agent) =>
            Effect.gen(function* () {
              yield* write(agent, `${agent.card.id}.txt`, `${agent.card.id}\n`);
              if (agent.card.id === "b") {
                yield* Deferred.succeed(bWrote, undefined);
                yield* Deferred.await(releaseB);
              }
              return finished;
            }),
          yield* Effect.scope,
          {
            cores: 4,
            verify: (input) => Ref.update(verified, (ids) => [...ids, input.card.id]),
          },
        );
        const { goalInstanceId } = yield* run(
          Effect.gen(function* () {
            const board = yield* startBoard(fixture, [card("a"), card("b")]);
            // b's worktree exists before a joins the Goal, so b must sync before it can join.
            yield* Deferred.await(bWrote);
            yield* waitForCards(board.sessionId, (cards) => status(cards, "a") === "done");
            yield* Deferred.succeed(releaseB, undefined);
            yield* waitForCards(board.sessionId, allDone);
            return board;
          }),
        );
        expect(yield* Ref.get(verified)).toEqual(["a", "b", "b"]);
        expect(yield* goalFile(fixture, goalInstanceId, "a.txt")).toBe("a");
        expect(yield* goalFile(fixture, goalInstanceId, "b.txt")).toBe("b");
      }),
    gitTimeout,
  );

  it.effect(
    "has a conflicting card resolve the Goal branch merge in its own worktree and join",
    () =>
      Effect.gen(function* () {
        const fixture = yield* kanbanFixture;
        const write = yield* writer;
        const bWrote = yield* Deferred.make<void>();
        const releaseB = yield* Deferred.make<void>();
        const bRuns = yield* Ref.make<ReadonlyArray<CardAgentRun>>([]);
        const run = yield* openOwner(
          fixture,
          (agent) =>
            Effect.gen(function* () {
              if (agent.card.id === "a") {
                yield* write(agent, "a.txt", "from a\n");
                return finished;
              }
              const earlier = yield* Ref.getAndUpdate(bRuns, (runs) => [...runs, agent]);
              if (earlier.length > 0) {
                // The run after the conflict resolves the merge left in the worktree.
                yield* write(agent, "a.txt", "from a and b\n");
                return finished;
              }
              yield* write(agent, "a.txt", "from b\n");
              yield* Deferred.succeed(bWrote, undefined);
              yield* Deferred.await(releaseB);
              return finished;
            }),
          yield* Effect.scope,
          { cores: 4 },
        );
        const { goalInstanceId, cards } = yield* run(
          Effect.gen(function* () {
            const board = yield* startBoard(fixture, [card("a"), card("b")]);
            yield* Deferred.await(bWrote);
            yield* waitForCards(board.sessionId, (cards) => status(cards, "a") === "done");
            yield* Deferred.succeed(releaseB, undefined);
            const cards = yield* waitForCards(board.sessionId, allDone);
            return { goalInstanceId: board.goalInstanceId, cards };
          }),
        );
        // The same card, not a new one, joined the Goal; its second run was told what conflicted.
        expect(cards.map((step) => step.id)).toEqual(["a", "b"]);
        const runs = yield* Ref.get(bRuns);
        expect(runs.map((agent) => agent.notes)).toEqual([
          [],
          [expect.stringContaining("conflicts in a.txt")],
        ]);
        expect(yield* goalFile(fixture, goalInstanceId, "a.txt")).toBe("from a and b");
      }),
    gitTimeout,
  );

  it.effect(
    "asks a person about a card that keeps conflicting, with the merge left in its worktree, and joins the person's resolution",
    () =>
      Effect.gen(function* () {
        const fixture = yield* kanbanFixture;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const write = yield* writer;
        const bWrote = yield* Deferred.make<void>();
        const releaseB = yield* Deferred.make<void>();
        const resolving = yield* Queue.unbounded<void>();
        const released = yield* Queue.unbounded<void>();
        const run = yield* openOwner(
          fixture,
          (agent) =>
            Effect.gen(function* () {
              if (agent.card.id === "a") {
                yield* write(agent, "a.txt", "from a\n");
                return finished;
              }
              if (agent.notes.length > 0) {
                yield* write(agent, "a.txt", "from a and b\n");
                yield* Queue.offer(resolving, undefined);
                yield* Queue.take(released);
                return finished;
              }
              yield* write(agent, "a.txt", "from b\n");
              yield* Deferred.succeed(bWrote, undefined);
              yield* Deferred.await(releaseB);
              return finished;
            }),
          yield* Effect.scope,
          { cores: 4 },
        );
        const { goalInstanceId } = yield* run(
          Effect.gen(function* () {
            const board = yield* startBoard(fixture, [card("a"), card("b")]);
            yield* Deferred.await(bWrote);
            yield* waitForCards(board.sessionId, (cards) => status(cards, "a") === "done");
            yield* Deferred.succeed(releaseB, undefined);

            // Someone else changes the same file on the Goal branch each time b resolves a merge.
            yield* Effect.forEach(
              ["first", "second", "third"],
              (round) =>
                Effect.gen(function* () {
                  yield* Queue.take(resolving);
                  yield* advanceGoal(fixture, board.goalInstanceId, `from elsewhere, ${round}\n`);
                  yield* Queue.offer(released, undefined);
                }),
              { discard: true },
            );

            const cards = yield* waitForCards(
              board.sessionId,
              (cards) => status(cards, "b") === "human_decision",
            );
            expect(cards.map((step) => step.id)).toEqual(["a", "b"]);
            const ladder = yield* (yield* CardAttempts).ladder(board.goalInstanceId, "b");
            expect(ladder.conflictRounds).toBe(3);
            expect(ladder.reason).toEqual(
              CardHoldReason.cases.MergeConflict.make({ files: ["a.txt"] }),
            );
            const [request] = yield* (yield* HumanDecisions).pending(board.sessionId);
            expect(request).toMatchObject({
              cardId: "b",
              kind: DecisionKind.cases.IntegrationConflict.make({ files: ["a.txt"] }),
            });

            // The merge waits in the kept worktree; the person resolves it there and answers. The
            // loop commits the merge, verifies the card again and lets it join the Goal.
            const worktree = path.join(fixture.worktrees, board.goalInstanceId, "b");
            expect(yield* git(worktree, "status", "--porcelain")).toBe("UU a.txt");
            yield* fs.writeFileString(path.join(worktree, "a.txt"), "resolved\n");
            yield* answer(
              request!,
              DecisionAnswer.cases.IntegrationConflict.make({ choice: "resolved" }),
            );
            yield* waitForCards(board.sessionId, allDone);
            expect(
              (yield* (yield* CardAttempts).ladder(board.goalInstanceId, "b")).conflictRounds,
            ).toBe(0);
            return { goalInstanceId: board.goalInstanceId };
          }),
        );
        expect(yield* goalFile(fixture, goalInstanceId, "a.txt")).toBe("resolved");
      }),
    gitTimeout,
  );

  it.effect(
    "asks a person about a card's uncertain earlier run, frees its slot, and continues it on the answer",
    () =>
      Effect.gen(function* () {
        const fixture = yield* kanbanFixture;
        const ran = yield* Ref.make<ReadonlyArray<CardAgentRun>>([]);
        const run = yield* openOwner(
          fixture,
          (agent) =>
            Effect.as(
              Ref.update(ran, (runs) => [...runs, agent]),
              finished,
            ),
          yield* Effect.scope,
        );
        yield* run(
          Effect.gen(function* () {
            const board = yield* executingPlan(fixture, [card("a"), card("b")]);
            yield* uncertainCardRun(board, "a", "run-0");
            // One card at a time: b runs only once a stops holding the slot.
            yield* (yield* KanbanOrchestrator).start(board.sessionId);
            const cards = yield* waitForCards(
              board.sessionId,
              (cards) => status(cards, "a") === "human_decision" && status(cards, "b") === "done",
            );
            expect(cards.map((step) => step.status)).toEqual(["human_decision", "done"]);
            expect((yield* Ref.get(ran)).map((agent) => agent.card.id)).toEqual(["b"]);

            const decisions = yield* HumanDecisions;
            const inbox = yield* decisions.inbox(board.projectId);
            expect(inbox).toMatchObject([
              {
                cardId: "a",
                cardTitle: "Card a",
                kind: DecisionKind.cases.UncertainSideEffect.make({
                  runId: "run-0",
                  toolNames: [],
                }),
                state: DecisionState.Pending(),
              },
            ]);
            yield* answer(
              inbox[0]!,
              DecisionAnswer.cases.UncertainSideEffect.make({ choice: "continue" }),
            );
            yield* waitForCards(board.sessionId, allDone);
            // The answer cleared the fence; the card continued its earlier conversation, told why.
            const continued = (yield* Ref.get(ran)).find((agent) => agent.card.id === "a");
            expect(continued?.continuation).toBe(true);
            expect(continued?.notes).toEqual([
              "A person checked the earlier run whose effects were unknown and found its work in place. Continue from the worktree as it is.",
            ]);
            expect(
              yield* decisions.forCard(board.sessionId, board.goalInstanceId, "a"),
            ).toHaveLength(1);
          }),
        );
      }),
    gitTimeout,
  );

  const boom = CardFailure.cases.Agent.make({ code: "failed" });

  it.effect(
    "retries a failing card, backs off, asks for a replan, and sends it to a person after replanning",
    () =>
      Effect.gen(function* () {
        const fixture = yield* kanbanFixture;
        const calls = yield* Ref.make(0);
        const failing = yield* Ref.make(true);
        const run = yield* openOwner(
          fixture,
          () =>
            Effect.gen(function* () {
              yield* Ref.update(calls, (count) => count + 1);
              return (yield* Ref.get(failing))
                ? CardAgentOutcome.Failed({ failure: boom })
                : finished;
            }),
          yield* Effect.scope,
        );
        yield* run(
          Effect.gen(function* () {
            const board = yield* startBoard(fixture, [card("a")]);
            const attempts = yield* CardAttempts;
            yield* waitForCards(board.sessionId, (cards) => status(cards, "a") === "blocked");
            expect(yield* Ref.get(calls)).toBe(3);
            expect((yield* attempts.ladder(board.goalInstanceId, "a")).reason).toEqual(
              CardHoldReason.cases.ReplanRequested.make({ failure: boom }),
            );

            yield* (yield* KanbanBoardActions).moveCard(
              board.sessionId,
              { cardId: "a", from: "blocked", to: "ready" },
              orchestrator,
            );
            yield* waitForCards(
              board.sessionId,
              (cards) => status(cards, "a") === "human_decision",
            );
            expect(yield* Ref.get(calls)).toBe(6);
            expect(yield* attempts.ladder(board.goalInstanceId, "a")).toMatchObject({
              replans: 1,
              reason: CardHoldReason.cases.RepeatedFailure.make({ failure: boom }),
            });
            const decisions = yield* HumanDecisions;
            // The request moves the card before its wait is stored.
            const [request] = yield* eventually(
              decisions.pending(board.sessionId),
              (pending) => pending.length > 0,
            );
            expect(request?.kind).toEqual(DecisionKind.cases.RetryExhausted.make({ attempts: 6 }));

            // The loop takes the same failure up again, as after a crash before it was marked
            // handled: it is the same occasion, so nobody is asked twice.
            const last = { goalInstanceId: board.goalInstanceId, cardId: "a", attemptNo: 6 };
            yield* sqlRun("UPDATE kanban_card_attempts SET handled = 0 WHERE attempt_no = 6");
            yield* (yield* KanbanOrchestrator).poke(board.goalInstanceId);
            yield* eventually(
              attempts.attempt(last),
              Option.exists((found) => found.handled),
            );
            expect(
              yield* decisions.forCard(board.sessionId, board.goalInstanceId, "a"),
            ).toHaveLength(1);

            // "다시 큐에 넣기": the card is ready again with a fresh streak, and the loop runs it.
            yield* Ref.set(failing, false);
            yield* answer(
              request!,
              DecisionAnswer.cases.RetryExhausted.make({ choice: "requeue" }),
            );
            yield* waitForCards(board.sessionId, allDone);
            expect(yield* Ref.get(calls)).toBe(7);
            expect(yield* attempts.ladder(board.goalInstanceId, "a")).toMatchObject({
              failureStreak: 0,
              reason: null,
            });
          }),
        );
      }),
    gitTimeout,
  );

  it.effect(
    "an idle board whose Plan executes again looks when its conversation changes",
    () =>
      Effect.gen(function* () {
        const fixture = yield* kanbanFixture;
        const releaseA = yield* Deferred.make<void>();
        const run = yield* openOwner(
          fixture,
          (agent) =>
            Effect.as(agent.card.id === "a" ? Deferred.await(releaseA) : Effect.void, finished),
          yield* Effect.scope,
        );
        yield* run(
          Effect.gen(function* () {
            const workflows = yield* Workflows;
            const board = yield* startBoard(fixture, [
              card("a"),
              { ...card("b"), dependsOn: ["a"] },
            ]);
            yield* waitForCards(board.sessionId, (cards) => status(cards, "a") === "in_progress");
            // The Plan stops executing while a runs; once a is done no attempt runs, and b waits.
            yield* workflows.move(board.sessionId, "plan");
            yield* Deferred.succeed(releaseA, undefined);
            yield* waitForCards(board.sessionId, (cards) => status(cards, "a") === "done");
            // The looks that a's end set off finish first.
            yield* Effect.sleep("1 second");
            // The idle board polls once a minute, though a running one here every 50 ms.
            yield* workflows.move(board.sessionId, "run");
            yield* Effect.sleep("300 millis");
            expect(status((yield* workflows.get(board.sessionId)).plan?.steps ?? [], "b")).toBe(
              "ready",
            );
            // The change to its conversation wakes it.
            yield* (yield* AppEvents).publishSession(board.sessionId, "run-state");
            yield* waitForCards(board.sessionId, allDone);
          }),
        );
      }),
    gitTimeout,
  );

  it.effect(
    "blocks a card whose deliveries ran out, and a requeue continues it to done",
    () =>
      Effect.gen(function* () {
        const fixture = yield* kanbanFixture;
        const started = yield* Deferred.make<void>();
        const crashed = yield* Scope.make();
        const first = yield* openOwner(
          fixture,
          () => Effect.andThen(Deferred.succeed(started, undefined), Effect.never),
          crashed,
        );
        const board = yield* first(
          Effect.gen(function* () {
            const board = yield* startBoard(fixture, [card("a")]);
            yield* Deferred.await(started);
            return board;
          }),
        );
        yield* Scope.close(crashed, Exit.void);
        // The owner died during the card's final delivery.
        yield* sqlRun("UPDATE persisted_queue_items SET attempts = 3, acquired_by = NULL").pipe(
          Effect.provideContext(yield* Layer.build(Database.layer(fixture.database))),
        );

        const continued = yield* Deferred.make<boolean>();
        const second = yield* openOwner(
          fixture,
          (agent) => Effect.as(Deferred.succeed(continued, agent.continuation), finished),
          yield* Effect.scope,
        );
        yield* second(
          Effect.gen(function* () {
            yield* waitForCards(board.sessionId, (cards) => status(cards, "a") === "blocked");
            expect((yield* (yield* CardAttempts).ladder(board.goalInstanceId, "a")).reason).toEqual(
              CardHoldReason.cases.DeadLettered.make({}),
            );
            // Dragging the blocked card to ready puts the same item back on the queue.
            yield* (yield* KanbanBoardActions).applyIntent(
              board.sessionId,
              BoardIntent.cases.Requeue.make({ cardId: "a" }),
              user,
            );
            yield* waitForCards(board.sessionId, allDone);
          }),
        );
        expect(Deferred.isDoneUnsafe(continued)).toBe(true);
      }),
    gitTimeout,
  );

  it.effect(
    "refuses a board intent the card's state does not fit",
    () =>
      Effect.gen(function* () {
        const fixture = yield* kanbanFixture;
        const runs = yield* Queue.unbounded<CardAgentRun>();
        const release = yield* Deferred.make<void>();
        const run = yield* openOwner(
          fixture,
          (agent) =>
            Effect.andThen(Queue.offer(runs, agent), Effect.as(Deferred.await(release), finished)),
          yield* Effect.scope,
        );
        yield* run(
          Effect.gen(function* () {
            // One slot: a runs, c waits in ready, b waits for a.
            const board = yield* startBoard(fixture, [
              card("a"),
              { ...card("b"), dependsOn: ["a"] },
              card("c"),
            ]);
            const actions = yield* KanbanBoardActions;
            yield* Queue.take(runs);
            const refused = (intent: BoardIntent) =>
              actions.applyIntent(board.sessionId, intent, user).pipe(
                Effect.as(null),
                Effect.catchTags({
                  KanbanActionRefused: (error) => Effect.succeed(error.reason),
                  BoardEditRefused: (error) => Effect.succeed(error.reason),
                }),
              );

            expect(yield* refused(BoardIntent.cases.Requeue.make({ cardId: "a" }))).toBe(
              "card_not_blocked",
            );
            expect(
              yield* refused(
                BoardIntent.cases.ChangeRequest.make({ cardId: "c", patch: { title: "C" } }),
              ),
            ).toBe("card_not_running");
            expect(yield* refused(BoardIntent.cases.Hold.make({ cardId: "a" }))).toBe(
              "card_not_waiting",
            );
            expect(yield* refused(BoardIntent.cases.Release.make({ cardId: "c" }))).toBe(
              "card_not_held",
            );
            expect(yield* refused(BoardIntent.cases.Reorder.make({ cardId: "c", at: "a" }))).toBe(
              "reorder_across_columns",
            );
            // Nothing moved, and the running card kept its attempt.
            expect(
              ((yield* (yield* Workflows).get(board.sessionId)).plan?.steps ?? []).map(
                (step) => step.status,
              ),
            ).toEqual(["in_progress", "backlog", "ready"]);

            yield* Deferred.succeed(release, undefined);
            yield* waitForCards(board.sessionId, allDone);
          }),
        );
      }),
    gitTimeout,
  );

  it.effect(
    "targets the branch the user checked out while no card branch exists",
    () =>
      Effect.gen(function* () {
        const fixture = yield* kanbanFixture;
        const run = yield* openOwner(fixture, () => Effect.never, yield* Effect.scope);
        yield* run(
          Effect.gen(function* () {
            // Registered without a loop, so no card starts on its own.
            const board = yield* executingBoard(fixture, [card("a")]);
            const schedules = yield* GoalSchedules;
            yield* schedules.register({
              goalInstanceId: board.goalInstanceId,
              targetBranch: "main",
            });
            const actions = yield* KanbanBoardActions;
            const refused = actions.retarget(board.sessionId).pipe(
              Effect.as(null),
              Effect.catchTag("KanbanActionRefused", (error) => Effect.succeed(error.reason)),
            );
            const target = Effect.map(
              schedules.get(board.goalInstanceId),
              Option.map((schedule) => schedule.targetBranch),
            );

            yield* git(fixture.project, "switch", "--quiet", "--detach");
            expect(yield* refused).toBe("detached_head");
            yield* git(fixture.project, "switch", "--quiet", "-c", "feature");
            yield* git(fixture.project, "commit", "--quiet", "--allow-empty", "-m", "feature work");
            const featureHead = yield* git(fixture.project, "rev-parse", "HEAD");
            expect(yield* actions.retarget(board.sessionId)).toEqual({
              targetBranch: "feature",
              goalHead: featureHead,
            });
            expect(yield* target).toEqual(Option.some("feature"));

            yield* Effect.scoped(
              (yield* CardWorktrees).lease({
                projectRoot: fixture.project,
                goalInstanceId: board.goalInstanceId,
                cardId: "a",
              }),
            );
            yield* git(fixture.project, "switch", "--quiet", "main");
            expect(yield* refused).toBe("cards_started");
            expect(yield* target).toEqual(Option.some("feature"));
          }),
        );
      }),
    gitTimeout,
  );

  it.effect(
    "shows the model each Goal outcome's status and the outcomes each card serves",
    () =>
      Effect.gen(function* () {
        const fixture = yield* kanbanFixture;
        const run = yield* openOwner(fixture, () => Effect.never, yield* Effect.scope);
        yield* run(
          Effect.scoped(
            Effect.gen(function* () {
              const board = yield* executingBoard(fixture, [
                card("a"),
                { ...card("b"), outcomes: [] },
              ]);
              const tools = Context.get(
                yield* Layer.build(
                  KanbanTools.layer.pipe(
                    Layer.provide(Boards.layer),
                    Layer.provide([GoalOrder.layer, OutcomeLedger.layer]),
                  ),
                ),
                KanbanTools,
              ).toolsFor(board.sessionId, "test-model");
              const read = yield* Effect.flatMap(Effect.fromNullishOr(tools[0]), (tool) =>
                tool.prepare({}),
              ).pipe(Effect.flatMap((call) => call({ toolCallId: "call-1" })));
              expect(read).toMatchObject({
                cards: [
                  { cardId: "a", outcomes: ["O1"] },
                  { cardId: "b", outcomes: [] },
                ],
                outcomes: [
                  {
                    id: "O1",
                    text: "Cards are done",
                    status: "in_progress",
                    pendingCards: ["a"],
                  },
                ],
              });
            }),
          ),
        );
      }),
    gitTimeout,
  );

  it.effect(
    "answers the model's refused move with the card's status and where it may go",
    () =>
      Effect.gen(function* () {
        const fixture = yield* kanbanFixture;
        const run = yield* openOwner(fixture, () => Effect.never, yield* Effect.scope);
        yield* run(
          Effect.scoped(
            Effect.gen(function* () {
              const board = yield* executingBoard(fixture, [card("a")]);
              const tools = Context.get(
                yield* Layer.build(
                  KanbanTools.layer.pipe(
                    Layer.provide(Boards.layer),
                    Layer.provide([GoalOrder.layer, OutcomeLedger.layer]),
                  ),
                ),
                KanbanTools,
              ).toolsFor(board.sessionId, "test-model");
              const edit = (change: JsonValue) =>
                Effect.flatMap(Effect.fromNullishOr(tools[1]), (tool) =>
                  tool.prepare({ edit: change }),
                ).pipe(Effect.flatMap((call) => call({ toolCallId: "call-1" })));

              const events = yield* AppEvents;
              const published = yield* events.revision;
              expect(
                yield* edit({ action: "move", cardId: "a", from: "backlog", to: "done" }),
              ).toEqual({
                error: "board_edit_refused",
                reason: "card_status_changed",
                status: "ready",
                allowed: ["backlog", "in_progress", "human_decision", "blocked"],
              });
              // Nothing changed, so pages are not told the board moved.
              expect(yield* events.revision).toBe(published);
              // A rejection without the reason the user is shown does not decode.
              expect(
                Exit.isFailure(
                  yield* Effect.exit(
                    edit({ action: "settle_change_request", requestId: 1, decision: "reject" }),
                  ),
                ),
              ).toBe(true);
            }),
          ),
        );
      }),
    gitTimeout,
  );

  it.effect(
    "keeps a held card off the queue after its dependencies finish and across a restart, and runs reordered cards in their new order",
    () =>
      Effect.gen(function* () {
        const fixture = yield* kanbanFixture;
        const ran = yield* Ref.make<readonly string[]>([]);
        const gate = yield* Deferred.make<void>();
        const record = (agent: CardAgentRun) => Ref.update(ran, (ids) => [...ids, agent.card.id]);
        const first = yield* Scope.make();
        const before = yield* openOwner(
          fixture,
          (agent) =>
            Effect.andThen(
              record(agent),
              agent.card.id === "a"
                ? Effect.as(Deferred.await(gate), finished)
                : Effect.succeed(finished),
            ),
          first,
        );
        const board = yield* before(
          Effect.gen(function* () {
            // One slot: a runs while c and d wait in ready, and b waits for a.
            const board = yield* startBoard(fixture, [
              card("a"),
              { ...card("b"), dependsOn: ["a"] },
              card("c"),
              card("d"),
            ]);
            const actions = yield* KanbanBoardActions;
            yield* waitForCards(board.sessionId, (cards) => status(cards, "a") === "in_progress");
            yield* actions.applyIntent(
              board.sessionId,
              BoardIntent.cases.Hold.make({ cardId: "b" }),
              user,
            );
            yield* actions.applyIntent(
              board.sessionId,
              BoardIntent.cases.Reorder.make({ cardId: "d", at: "c" }),
              user,
            );
            yield* Deferred.succeed(gate, undefined);
            yield* waitForCards(board.sessionId, (cards) =>
              ["a", "c", "d"].every((id) => status(cards, id) === "done"),
            );
            return board;
          }),
        );
        expect(yield* Ref.get(ran)).toEqual(["a", "d", "c"]);
        yield* Scope.close(first, Exit.void);

        const after = yield* openOwner(
          fixture,
          (agent) => Effect.as(record(agent), finished),
          yield* Effect.scope,
        );
        yield* after(
          Effect.gen(function* () {
            const held = (yield* (yield* Workflows).get(board.sessionId)).plan?.steps.find(
              (step) => step.id === "b",
            );
            expect(held).toMatchObject({ status: "backlog", hold: { by: user } });
            yield* (yield* KanbanBoardActions).applyIntent(
              board.sessionId,
              BoardIntent.cases.Release.make({ cardId: "b" }),
              user,
            );
            yield* waitForCards(board.sessionId, allDone);
          }),
        );
        expect(yield* Ref.get(ran)).toEqual(["a", "d", "c", "b"]);
      }),
    gitTimeout,
  );

  it.effect(
    "settles users' change requests to a running card: rejected, applied, reassigned",
    () =>
      Effect.gen(function* () {
        const fixture = yield* kanbanFixture;
        const runs = yield* Queue.unbounded<CardAgentRun>();
        const release = yield* Deferred.make<void>();
        const run = yield* openOwner(
          fixture,
          (agent) =>
            Effect.andThen(Queue.offer(runs, agent), Effect.as(Deferred.await(release), finished)),
          yield* Effect.scope,
        );
        yield* run(
          Effect.gen(function* () {
            const board = yield* startBoard(fixture, [card("a")]);
            const workflows = yield* Workflows;
            const actions = yield* KanbanBoardActions;
            const request = Effect.fnUntraced(function* (title: string) {
              const plan = (yield* workflows.get(board.sessionId)).plan;
              const result = yield* workflows.editBoard(
                board.sessionId,
                BoardEdit.cases.EditCard.make({
                  planVersion: plan?.version ?? 0,
                  cardId: "a",
                  patch: { title },
                }),
                user,
              );
              expect(BoardEditResult.$is("Requested")(result)).toBe(true);
              return BoardEditResult.$match(result, {
                Applied: () => -1,
                Requested: ({ request }) => request.id,
              });
            });
            const requestStatus = (id: number) =>
              sqlGet("SELECT status, reason FROM board_change_requests WHERE id = ?", id);

            expect(yield* Queue.take(runs)).toMatchObject({ attemptNo: 1, generation: 1 });

            const rejected = yield* request("Rejected title");
            expect(
              yield* actions.settleChangeRequest(
                board.sessionId,
                rejected,
                ChangeDecision.cases.Reject.make({ reason: "out of scope" }),
                orchestrator,
              ),
            ).toEqual({ status: "rejected" });
            expect(yield* requestStatus(rejected)).toEqual({
              status: "rejected",
              reason: "out of scope",
            });

            const applied = yield* request("Applied title");
            yield* actions.settleChangeRequest(
              board.sessionId,
              applied,
              ChangeDecision.cases.Apply.make({}),
              orchestrator,
            );
            const second = yield* Queue.take(runs);
            expect(second).toMatchObject({
              attemptNo: 2,
              generation: 1,
              continuation: false,
              card: { title: "Applied title" },
            });
            expect(second.notes).toEqual(['The user changed this card (title: "Applied title").']);
            expect(yield* requestStatus(applied)).toMatchObject({ status: "applied" });

            const reassigned = yield* request("Reassigned title");
            yield* actions.settleChangeRequest(
              board.sessionId,
              reassigned,
              ChangeDecision.cases.Reassign.make({}),
              orchestrator,
            );
            expect(yield* Queue.take(runs)).toMatchObject({
              attemptNo: 3,
              generation: 2,
              card: { title: "Reassigned title" },
            });
            expect(yield* requestStatus(reassigned)).toMatchObject({ status: "reassigned" });

            yield* Deferred.succeed(release, undefined);
            const cards = yield* waitForCards(board.sessionId, allDone);
            expect(cards[0]?.title).toBe("Reassigned title");
          }),
        );
      }),
    gitTimeout,
  );

  it.effect(
    "holds new assignments when the Goal changes and applies the model's verdicts",
    () =>
      Effect.gen(function* () {
        const fixture = yield* kanbanFixture;
        const ran = yield* Ref.make<ReadonlyArray<string>>([]);
        const aStarted = yield* Deferred.make<void>();
        const releaseA = yield* Deferred.make<void>();
        const run = yield* openOwner(
          fixture,
          (agent) =>
            Effect.gen(function* () {
              yield* Ref.update(ran, (ids) => [...ids, agent.card.title]);
              if (agent.card.id === "a") {
                yield* Deferred.succeed(aStarted, undefined);
                yield* Deferred.await(releaseA);
              }
              return finished;
            }),
          yield* Effect.scope,
        );
        yield* run(
          Effect.gen(function* () {
            const board = yield* startBoard(fixture, [card("a"), card("b"), card("c")]);
            const workflows = yield* Workflows;
            const attempts = yield* CardAttempts;
            yield* Deferred.await(aStarted);
            yield* workflows.updateGoal(board.sessionId, {
              ...goalInput,
              statement: "Run fewer cards",
            });
            yield* attempts
              .goal(board.goalInstanceId)
              .pipe(Effect.repeat({ until: Option.exists((goal) => goal.hold !== null) }));
            // a finishes against the earlier Goal; it waits for the verdicts, and nothing else starts.
            yield* Deferred.succeed(releaseA, undefined);
            yield* attemptOutcome({
              goalInstanceId: board.goalInstanceId,
              cardId: "a",
              attemptNo: 1,
            });
            yield* (yield* KanbanOrchestrator).poke(board.goalInstanceId);
            expect(status(yield* waitForCards(board.sessionId, () => true), "a")).toBe(
              "in_progress",
            );

            yield* (yield* KanbanBoardActions).applyGoalChange(
              board.sessionId,
              [
                GoalChangeVerdict.cases.Continue.make({ cardId: "a" }),
                GoalChangeVerdict.cases.Stop.make({ cardId: "b", reason: "no longer wanted" }),
                GoalChangeVerdict.cases.Replace.make({
                  cardId: "c",
                  card: {
                    title: "Card d",
                    description: "Do d instead",
                    dependsOn: [],
                    acceptanceCriteria: ["d works"],
                  },
                }),
              ],
              orchestrator,
            );
            const cards = yield* waitForCards(
              board.sessionId,
              (cards) => Arr.countBy(cards, (step) => step.status === "done") === 2,
            );
            expect(cards.map((step) => [step.title, step.status])).toEqual([
              ["Card a", "done"],
              ["Card b", "blocked"],
              ["Card d", "done"],
            ]);
            expect(yield* attempts.goal(board.goalInstanceId)).toMatchObject({
              value: { hold: null, goalVersion: 2 },
            });
          }),
        );
        expect(yield* Ref.get(ran)).toEqual(["Card a", "Card d"]);
      }),
    gitTimeout,
  );

  it.effect(
    "asks a person when a Goal change's effect is unclear, and closes waits of stopped cards and replaced Goals",
    () =>
      Effect.gen(function* () {
        const fixture = yield* kanbanFixture;
        const started = yield* Queue.unbounded<string>();
        const release = yield* Deferred.make<void>();
        const run = yield* openOwner(
          fixture,
          (agent) =>
            Effect.andThen(
              Queue.offer(started, agent.card.id),
              Effect.as(Deferred.await(release), finished),
            ),
          yield* Effect.scope,
          { cores: 4 },
        );
        yield* run(
          Effect.gen(function* () {
            const board = yield* startBoard(fixture, [card("a"), card("b"), card("c")]);
            const workflows = yield* Workflows;
            const attempts = yield* CardAttempts;
            const decisions = yield* HumanDecisions;
            const actions = yield* KanbanBoardActions;
            const changeGoal = Effect.fnUntraced(function* (statement: string) {
              yield* workflows.updateGoal(board.sessionId, { ...goalInput, statement });
              yield* eventually(
                attempts.goal(board.goalInstanceId),
                Option.exists((goal) => goal.hold !== null),
              );
            });
            const requestOf = (cardId: string) =>
              Effect.map(
                decisions.forCard(board.sessionId, board.goalInstanceId, cardId),
                (requests) => requests[0]!,
              );
            // Two cores run two cards; c waits.
            expect([yield* Queue.take(started), yield* Queue.take(started)].toSorted()).toEqual([
              "a",
              "b",
            ]);

            yield* changeGoal("Run other cards");
            yield* actions.applyGoalChange(
              board.sessionId,
              ["a", "b", "c"].map((cardId) =>
                GoalChangeVerdict.cases.NeedsDecision.make({
                  cardId,
                  question: "Does the new Goal still need this?",
                }),
              ),
              orchestrator,
            );
            const cards = yield* waitForCards(board.sessionId, () => true);
            expect(cards.map((step) => step.status)).toEqual([
              "human_decision",
              "human_decision",
              "human_decision",
            ]);
            expect(yield* decisions.pending(board.sessionId)).toMatchObject(
              ["a", "b", "c"].map((cardId) => ({
                cardId,
                kind: DecisionKind.cases.ImpactUnclear.make({
                  fromGoalVersion: 1,
                  toGoalVersion: 2,
                }),
              })),
            );

            // "그대로 진행": the stopped attempt's card runs again and finishes.
            yield* Deferred.succeed(release, undefined);
            yield* answer(
              yield* requestOf("a"),
              DecisionAnswer.cases.ImpactUnclear.make({ choice: "continue" }),
            );
            yield* waitForCards(board.sessionId, (cards) => status(cards, "a") === "done");

            // The model stops b after another Goal change: its wait closes without an answer.
            yield* changeGoal("Run fewer cards");
            yield* actions.applyGoalChange(
              board.sessionId,
              [GoalChangeVerdict.cases.Stop.make({ cardId: "b", reason: "no longer wanted" })],
              orchestrator,
            );
            const b = yield* requestOf("b");
            expect(b.state).toEqual(DecisionState.Closed({ reason: "card_stopped" }));
            expect(status(yield* waitForCards(board.sessionId, () => true), "b")).toBe("blocked");
            const late = yield* Effect.flip(
              answer(b, DecisionAnswer.cases.ImpactUnclear.make({ choice: "continue" })),
            );
            expect(late).toBeInstanceOf(HumanDecisionRefused);
            expect(late).toMatchObject({ reason: "request_closed" });

            // Back in Plan, a new Goal takes over the session: the loop stops and closes c's wait.
            const worktrees = yield* CardWorktrees;
            expect((yield* worktrees.goalFolder(board.goalInstanceId)).cardIds).toContain("b");
            yield* replaceGoal(board.sessionId);
            yield* (yield* KanbanOrchestrator).poke(board.goalInstanceId);
            const c = yield* eventually(
              requestOf("c"),
              (request) => !DecisionState.$is("Pending")(request.state),
            );
            expect(c.state).toEqual(DecisionState.Closed({ reason: "goal_replaced" }));
            expect(yield* decisions.inbox(board.projectId)).toEqual([]);
            // The replaced Goal's worktrees go; b's work stays on its branch.
            yield* eventually(
              worktrees.goalFolder(board.goalInstanceId),
              (folder) => folder.cardIds.length === 0,
            );
            expect(
              yield* git(fixture.project, "branch", "--list", `ctx/card/${board.goalInstanceId}/b`),
            ).not.toBe("");
          }),
        );
      }),
    gitTimeout,
  );

  it.effect(
    "stops a closed Plan's running card and its board",
    () =>
      Effect.gen(function* () {
        const fixture = yield* kanbanFixture;
        const started = yield* Deferred.make<void>();
        const stopped = yield* Deferred.make<void>();
        const run = yield* openOwner(
          fixture,
          () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(stopped, undefined)),
            ),
          yield* Effect.scope,
        );
        yield* run(
          Effect.gen(function* () {
            const board = yield* startBoard(fixture, [
              card("a"),
              { ...card("b"), dependsOn: ["a"] },
            ]);
            const workflows = yield* Workflows;
            yield* Deferred.await(started);
            // The agent signals before its delivery registers it; close once it can be stopped.
            const { running } = yield* CardRuns;
            yield* eventually(FiberMap.has(running, `${board.goalInstanceId}:a`), Boolean);
            const planVersion = (yield* workflows.get(board.sessionId)).plan?.version ?? 0;
            yield* workflows.editBoard(
              board.sessionId,
              BoardEdit.cases.ClosePlan.make({ planVersion }),
              user,
            );
            yield* (yield* KanbanOrchestrator).poke(board.goalInstanceId);

            yield* Deferred.await(stopped);
            yield* eventually(
              (yield* CardAttempts).goal(board.goalInstanceId),
              Option.exists((goal) => !goal.active),
            );
            const state = yield* workflows.get(board.sessionId);
            expect(state.plan?.steps.map((step) => step.status)).toEqual(["blocked", "blocked"]);
            // The running card's worktree goes once its delivery ends, and the Goal's folder with it;
            // its work stays on its branch.
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            yield* eventually(
              fs.exists(path.join(fixture.worktrees, board.goalInstanceId)),
              (exists) => !exists,
            );
            expect(
              yield* git(fixture.project, "branch", "--list", `ctx/card/${board.goalInstanceId}/a`),
            ).not.toBe("");
          }),
        );
      }),
    gitTimeout,
  );

  it.effect(
    "starts no card while its Goal is paused and stops the board once the Goal is stopped",
    () =>
      Effect.gen(function* () {
        const fixture = yield* kanbanFixture;
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const ran = yield* Ref.make<readonly string[]>([]);
        const run = yield* openOwner(
          fixture,
          (agent) =>
            Ref.update(ran, Arr.append(agent.card.id)).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Deferred.await(release)),
              Effect.as(finished),
            ),
          yield* Effect.scope,
        );
        yield* run(
          Effect.gen(function* () {
            const board = yield* startBoard(fixture, [
              card("a"),
              { ...card("b"), dependsOn: ["a"] },
            ]);
            const workflows = yield* Workflows;
            const orchestrator = yield* KanbanOrchestrator;
            yield* Deferred.await(started);
            yield* workflows.controlGoal(board.sessionId, "pause");
            // The running card finishes; the card it unblocks waits for the Goal to resume.
            yield* Deferred.succeed(release, undefined);
            yield* eventually(
              Effect.map(workflows.get(board.sessionId), (state) =>
                status(state.plan?.steps ?? [], "a"),
              ),
              (found) => found === "done",
            );
            yield* orchestrator.poke(board.goalInstanceId);
            yield* Effect.sleep("300 millis");
            expect(yield* Ref.get(ran)).toEqual(["a"]);
            expect(status((yield* workflows.get(board.sessionId)).plan?.steps ?? [], "b")).toBe(
              "ready",
            );

            yield* workflows.controlGoal(board.sessionId, "stop");
            yield* orchestrator.poke(board.goalInstanceId);
            yield* eventually(
              (yield* CardAttempts).goal(board.goalInstanceId),
              Option.exists((goal) => !goal.active),
            );
            expect(yield* Ref.get(ran)).toEqual(["a"]);
          }),
        );
      }),
    gitTimeout,
  );

  it.effect(
    "stops a conversation's running card and board before it returns",
    () =>
      Effect.gen(function* () {
        const fixture = yield* kanbanFixture;
        const started = yield* Deferred.make<void>();
        const stopped = yield* Deferred.make<void>();
        const run = yield* openOwner(
          fixture,
          () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(stopped, undefined)),
            ),
          yield* Effect.scope,
        );
        yield* run(
          Effect.gen(function* () {
            const board = yield* startBoard(fixture, [card("a")]);
            yield* Deferred.await(started);
            const { running } = yield* CardRuns;
            yield* eventually(FiberMap.has(running, `${board.goalInstanceId}:a`), Boolean);

            // A deleted conversation's records go right after this; nothing may still run then.
            yield* (yield* KanbanOrchestrator).stopSession(board.sessionId);
            expect(yield* Deferred.isDone(stopped)).toBe(true);
            const attempts = yield* CardAttempts;
            expect(
              Option.exists(yield* attempts.goal(board.goalInstanceId), (goal) => goal.active),
            ).toBe(false);
            // It keeps what is on disk, also once the stopped card's delivery ended.
            yield* eventually(
              attempts.attempt({ goalInstanceId: board.goalInstanceId, cardId: "a", attemptNo: 1 }),
              Option.exists((attempt) => attempt.outcome !== null),
            );
            expect(
              (yield* (yield* CardWorktrees).goalFolder(board.goalInstanceId)).cardIds,
            ).toEqual(["a"]);
          }),
        );
      }),
    gitTimeout,
  );
});
