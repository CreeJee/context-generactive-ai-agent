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
import { sqlGet, sqlRun } from "../../tests/support/sql.ts";
import { Database } from "../db/database.ts";
import {
  card,
  executingPlan,
  git,
  goalInput,
  kanbanBoardOwner,
  kanbanFixture,
  scriptedAgent,
  switchGoalInstance,
  uncertainCardRun,
  waitForCards,
  type KanbanFixture,
} from "../testing/kanban.ts";
import type { BoardIntent } from "../workflow/board-edit.ts";
import type { PlanStep } from "../workflow/workflow.ts";
import { Workflows } from "../workflow/workflow.ts";
import { KanbanBoardActions } from "./board-actions.ts";
import {
  CardVerifier,
  type CardAgentOutcome,
  type CardAgentRun,
  type CardVerification,
} from "./card-agent.ts";
import { CardAttempts } from "./card-attempts.ts";
import {
  HumanDecisions,
  type DecisionAnswer,
  type HumanDecisionRequest,
} from "./human-decision.ts";
import { KanbanOrchestrator } from "./orchestrator.ts";

type Owner = Layer.Success<ReturnType<typeof kanbanBoardOwner>>;

const orchestrator = { _tag: "Orchestrator", runId: "test-model" } as const;
const user = { _tag: "User" } as const;
const finished: CardAgentOutcome = { _tag: "Finished", report: "done" };

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
              Effect.as(options.verify?.(input) ?? Effect.void, {
                _tag: "Passed",
                evidence: [`verified ${input.card.id}`],
              }),
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

/** Node services for a test, built in its scope. */
// These tests run real git repositories and worktrees; beside other test files they pass 5s.
const gitTimeout = { timeout: 30_000 };

const withNode = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.flatMap(Layer.build(NodeServices.layer), (context) =>
    Effect.provideContext(program, context),
  ).pipe(Effect.scoped);

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

it.live(
  "assigns cards in dependency order, verifies them and squashes each into the Goal",
  () =>
    Effect.gen(function* () {
      const fixture = yield* kanbanFixture;
      const write = yield* writer;
      const ran = yield* Ref.make<ReadonlyArray<string>>([]);
      const run = yield* openOwner(
        fixture,
        (agent) =>
          Effect.gen(function* () {
            yield* Ref.update(ran, (ids) => [...ids, agent.card.id]);
            yield* write(agent, `${agent.card.id}.txt`, `${agent.card.id}\n`);
            return finished;
          }),
        yield* Effect.scope,
        { cores: 8 },
      );
      const { goalInstanceId } = yield* run(
        Effect.gen(function* () {
          const board = yield* startBoard(fixture, [card("a"), { ...card("b"), dependsOn: ["a"] }]);
          yield* waitForCards(board.sessionId, allDone);
          return board;
        }),
      );
      expect(yield* Ref.get(ran)).toEqual(["a", "b"]);
      expect(yield* goalFile(fixture, goalInstanceId, "a.txt")).toBe("a");
      expect(yield* goalFile(fixture, goalInstanceId, "b.txt")).toBe("b");
    }).pipe(withNode),
  gitTimeout,
);

it.live(
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
    }).pipe(withNode),
  gitTimeout,
);

it.live(
  "replaces a conflicting card with a resolution card, which goes to a person when it conflicts again and joins once resolved",
  () =>
    Effect.gen(function* () {
      const fixture = yield* kanbanFixture;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const write = yield* writer;
      const bWrote = yield* Deferred.make<void>();
      const releaseB = yield* Deferred.make<void>();
      const resolving = yield* Deferred.make<string>();
      const releaseResolution = yield* Deferred.make<void>();
      const run = yield* openOwner(
        fixture,
        (agent) =>
          Effect.gen(function* () {
            switch (agent.card.id) {
              case "a":
                yield* write(agent, "a.txt", "from a\n");
                return finished;
              case "b":
                yield* write(agent, "a.txt", "from b\n");
                yield* Deferred.succeed(bWrote, undefined);
                yield* Deferred.await(releaseB);
                return finished;
              default:
                yield* write(agent, "a.txt", "from a and b\n");
                yield* Deferred.succeed(resolving, agent.card.id);
                yield* Deferred.await(releaseResolution);
                return finished;
            }
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
          const resolution = yield* Deferred.await(resolving);

          // Someone else changes the same file on the Goal branch while the resolution card works.
          const advance = path.join(fixture.home, "advance");
          yield* git(
            fixture.project,
            "worktree",
            "add",
            "--quiet",
            advance,
            `ctx/goal/${board.goalInstanceId}`,
          );
          yield* fs.writeFileString(path.join(advance, "a.txt"), "from elsewhere\n");
          yield* git(advance, "commit", "--quiet", "-am", "elsewhere");
          yield* git(fixture.project, "worktree", "remove", advance);
          yield* Deferred.succeed(releaseResolution, undefined);

          const cards = yield* waitForCards(
            board.sessionId,
            (cards) => status(cards, resolution) === "human_decision",
          );
          const ladder = yield* (yield* CardAttempts).ladder(board.goalInstanceId, resolution);
          expect(ladder).toMatchObject({ resolutionOf: "b" });
          expect(ladder.reason).toEqual({ _tag: "MergeConflict", files: ["a.txt"] });
          const [request] = yield* (yield* HumanDecisions).pending(board.sessionId);
          expect(request).toMatchObject({
            cardId: resolution,
            kind: { _tag: "IntegrationConflict", files: ["a.txt"] },
          });
          expect(cards.map((step) => [step.title, step.status])).toEqual([
            ["Card a", "done"],
            ["Resolve conflicts: Card b", "human_decision"],
          ]);

          // The person merges the Goal branch into the kept worktree, resolves it and answers; the
          // card is verified again and joins the Goal.
          const worktree = path.join(fixture.worktrees, board.goalInstanceId, resolution);
          yield* git(worktree, "merge", "--no-edit", `ctx/goal/${board.goalInstanceId}`).pipe(
            Effect.ignore,
          );
          yield* fs.writeFileString(path.join(worktree, "a.txt"), "resolved\n");
          yield* git(worktree, "commit", "--quiet", "--no-edit", "-a");
          yield* answer(request!, { _tag: "IntegrationConflict", choice: "resolved" });
          yield* waitForCards(board.sessionId, allDone);
          return { goalInstanceId: board.goalInstanceId };
        }),
      );
      expect(yield* goalFile(fixture, goalInstanceId, "a.txt")).toBe("resolved");
    }).pipe(withNode),
  gitTimeout,
);

it.live(
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
              kind: { _tag: "UncertainSideEffect", runId: "run-0" },
              state: { _tag: "Pending" },
            },
          ]);
          yield* answer(inbox[0]!, { _tag: "UncertainSideEffect", choice: "continue" });
          yield* waitForCards(board.sessionId, allDone);
          // The answer cleared the fence; the card continued its earlier conversation, told why.
          const continued = (yield* Ref.get(ran)).find((agent) => agent.card.id === "a");
          expect(continued?.continuation).toBe(true);
          expect(continued?.notes).toEqual([
            "A person checked the earlier run whose effects were unknown and found its work in place. Continue from the worktree as it is.",
          ]);
          expect(yield* decisions.forCard(board.sessionId, board.goalInstanceId, "a")).toHaveLength(
            1,
          );
        }),
      );
    }).pipe(withNode),
  gitTimeout,
);

const boom = { _tag: "Agent", code: "failed" } as const;

it.live(
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
              ? ({ _tag: "Failed", failure: boom } as const)
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
          expect((yield* attempts.ladder(board.goalInstanceId, "a")).reason).toEqual({
            _tag: "ReplanRequested",
            failure: boom,
          });

          yield* (yield* KanbanBoardActions).moveCard(
            board.sessionId,
            { cardId: "a", from: "blocked", to: "ready" },
            orchestrator,
          );
          yield* waitForCards(board.sessionId, (cards) => status(cards, "a") === "human_decision");
          expect(yield* Ref.get(calls)).toBe(6);
          expect(yield* attempts.ladder(board.goalInstanceId, "a")).toMatchObject({
            replans: 1,
            reason: { _tag: "RepeatedFailure", failure: boom },
          });
          const decisions = yield* HumanDecisions;
          // The request moves the card before its wait is stored.
          const [request] = yield* eventually(
            decisions.pending(board.sessionId),
            (pending) => pending.length > 0,
          );
          expect(request?.kind).toEqual({ _tag: "RetryExhausted", attempts: 6 });

          // The loop takes the same failure up again, as after a crash before it was marked
          // handled: it is the same occasion, so nobody is asked twice.
          const last = { goalInstanceId: board.goalInstanceId, cardId: "a", attemptNo: 6 };
          yield* sqlRun("UPDATE kanban_card_attempts SET handled = 0 WHERE attempt_no = 6");
          yield* (yield* KanbanOrchestrator).poke(board.goalInstanceId);
          yield* eventually(
            attempts.attempt(last),
            Option.exists((found) => found.handled),
          );
          expect(yield* decisions.forCard(board.sessionId, board.goalInstanceId, "a")).toHaveLength(
            1,
          );

          // "다시 큐에 넣기": the card is ready again with a fresh streak, and the loop runs it.
          yield* Ref.set(failing, false);
          yield* answer(request!, { _tag: "RetryExhausted", choice: "requeue" });
          yield* waitForCards(board.sessionId, allDone);
          expect(yield* Ref.get(calls)).toBe(7);
          expect(yield* attempts.ladder(board.goalInstanceId, "a")).toMatchObject({
            failureStreak: 0,
            reason: null,
          });
        }),
      );
    }).pipe(withNode),
  gitTimeout,
);

it.live(
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
          expect((yield* (yield* CardAttempts).ladder(board.goalInstanceId, "a")).reason).toEqual({
            _tag: "DeadLettered",
          });
          // Dragging the blocked card to ready puts the same item back on the queue.
          yield* (yield* KanbanBoardActions).applyIntent(
            board.sessionId,
            { _tag: "Requeue", cardId: "a" },
            user,
          );
          yield* waitForCards(board.sessionId, allDone);
        }),
      );
      expect(Deferred.isDoneUnsafe(continued)).toBe(true);
    }).pipe(withNode),
  gitTimeout,
);

it.live(
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

          expect(yield* refused({ _tag: "Requeue", cardId: "a" })).toBe("card_not_blocked");
          expect(
            yield* refused({ _tag: "ChangeRequest", cardId: "c", patch: { title: "C" } }),
          ).toBe("card_not_running");
          expect(yield* refused({ _tag: "Hold", cardId: "a" })).toBe("card_not_waiting");
          expect(yield* refused({ _tag: "Release", cardId: "c" })).toBe("card_not_held");
          expect(yield* refused({ _tag: "Reorder", cardId: "c", at: "a" })).toBe(
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
    }).pipe(withNode),
  gitTimeout,
);

it.live(
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
          yield* actions.applyIntent(board.sessionId, { _tag: "Hold", cardId: "b" }, user);
          yield* actions.applyIntent(
            board.sessionId,
            { _tag: "Reorder", cardId: "d", at: "c" },
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
            { _tag: "Release", cardId: "b" },
            user,
          );
          yield* waitForCards(board.sessionId, allDone);
        }),
      );
      expect(yield* Ref.get(ran)).toEqual(["a", "d", "c", "b"]);
    }).pipe(withNode),
  gitTimeout,
);

it.live(
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
              { _tag: "EditCard", planVersion: plan?.version ?? 0, cardId: "a", patch: { title } },
              user,
            );
            expect(result._tag).toBe("Requested");
            return result._tag === "Requested" ? result.request.id : -1;
          });
          const requestStatus = (id: number) =>
            sqlGet("SELECT status, reason FROM board_change_requests WHERE id = ?", id);

          expect(yield* Queue.take(runs)).toMatchObject({ attemptNo: 1, generation: 1 });

          const rejected = yield* request("Rejected title");
          expect(
            yield* actions.settleChangeRequest(
              board.sessionId,
              rejected,
              { _tag: "Reject", reason: "out of scope" },
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
            { _tag: "Apply" },
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
            { _tag: "Reassign" },
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
    }).pipe(withNode),
  gitTimeout,
);

it.live(
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
            .pipe(
              Effect.repeat({ until: (goal) => goal._tag === "Some" && goal.value.hold !== null }),
            );
          // a finishes against the earlier Goal; it waits for the verdicts, and nothing else starts.
          yield* Deferred.succeed(releaseA, undefined);
          yield* attempts.awaitOutcome({
            goalInstanceId: board.goalInstanceId,
            cardId: "a",
            attemptNo: 1,
          });
          yield* (yield* KanbanOrchestrator).poke(board.goalInstanceId);
          expect(status(yield* waitForCards(board.sessionId, () => true), "a")).toBe("in_progress");

          yield* (yield* KanbanBoardActions).applyGoalChange(
            board.sessionId,
            [
              { _tag: "Continue", cardId: "a" },
              { _tag: "Stop", cardId: "b", reason: "no longer wanted" },
              {
                _tag: "Replace",
                cardId: "c",
                card: {
                  title: "Card d",
                  description: "Do d instead",
                  dependsOn: [],
                  acceptanceCriteria: ["d works"],
                },
              },
            ],
            orchestrator,
          );
          const cards = yield* waitForCards(
            board.sessionId,
            (cards) => cards.filter((step) => step.status === "done").length === 2,
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
    }).pipe(withNode),
  gitTimeout,
);

it.live(
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
            ["a", "b", "c"].map((cardId) => ({
              _tag: "NeedsDecision" as const,
              cardId,
              question: "Does the new Goal still need this?",
            })),
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
              kind: { _tag: "ImpactUnclear", fromGoalVersion: 1, toGoalVersion: 2 },
            })),
          );

          // "그대로 진행": the stopped attempt's card runs again and finishes.
          yield* Deferred.succeed(release, undefined);
          yield* answer(yield* requestOf("a"), { _tag: "ImpactUnclear", choice: "continue" });
          yield* waitForCards(board.sessionId, (cards) => status(cards, "a") === "done");

          // The model stops b after another Goal change: its wait closes without an answer.
          yield* changeGoal("Run fewer cards");
          yield* actions.applyGoalChange(
            board.sessionId,
            [{ _tag: "Stop", cardId: "b", reason: "no longer wanted" }],
            orchestrator,
          );
          const b = yield* requestOf("b");
          expect(b.state).toEqual({ _tag: "Closed", reason: "card_stopped" });
          expect(status(yield* waitForCards(board.sessionId, () => true), "b")).toBe("blocked");
          const late = yield* Effect.flip(answer(b, { _tag: "ImpactUnclear", choice: "continue" }));
          expect(late).toMatchObject({ _tag: "HumanDecisionRefused", reason: "request_closed" });

          // A new Goal takes over the session: the loop stops and closes c's wait.
          yield* switchGoalInstance(board.sessionId);
          yield* (yield* KanbanOrchestrator).poke(board.goalInstanceId);
          const c = yield* eventually(
            requestOf("c"),
            (request) => request.state._tag !== "Pending",
          );
          expect(c.state).toEqual({ _tag: "Closed", reason: "goal_replaced" });
          expect(yield* decisions.inbox(board.projectId)).toEqual([]);
        }),
      );
    }).pipe(withNode),
  gitTimeout,
);
