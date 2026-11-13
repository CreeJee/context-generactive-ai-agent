import { Array as Arr, Deferred, Effect, FileSystem, Option, Path, Ref, Schedule } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { expect } from "vite-plus/test";
import { layer } from "@effect/vitest";
import {
  card,
  executingPlan,
  executingSession,
  git,
  kanbanFixture,
  kanbanTestLayer,
  openKanbanOwner,
  waitForCards,
  type KanbanFixture,
} from "../testing/kanban.ts";
import {
  CardAgentOutcome,
  CardVerdict,
  type CardAgentRun,
  type GoalConflictResolution,
} from "./card-agent.ts";
import { GoalMergeState, GoalSchedules } from "./goal-schedules.ts";
import {
  DecisionAnswer,
  DecisionKind,
  goalDecisionCardId,
  HumanDecisions,
} from "./human-decision.ts";
import { KanbanOrchestrator } from "./orchestrator.ts";

const finished: CardAgentOutcome = CardAgentOutcome.Finished({ report: "done" });
const passed: CardVerdict = CardVerdict.Passed({ evidence: ["checked"] });

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
    Effect.gen(function* () {
      const target = path.join(agent.worktree.toolRoot, file);
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.writeFileString(target, text);
    }).pipe(Effect.orDie);
});

/** Commits a file on the user's checked-out main branch, as the user would. */
const userCommit = (fixture: KanbanFixture, file: string, text: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.writeFileString(path.join(fixture.project, file), text);
    yield* git(fixture.project, "add", file);
    yield* git(fixture.project, "commit", "--quiet", "-m", `user ${file}`);
    return yield* git(fixture.project, "rev-parse", "HEAD");
  });

/** Reads a checkout's HEAD from inside a verifier, with the test's node services. */
const headReader = Effect.map(
  Effect.context<ChildProcessSpawner.ChildProcessSpawner>(),
  (context) => (folder: string) =>
    git(folder, "rev-parse", "HEAD").pipe(Effect.provideContext(context), Effect.orDie),
);

const mergeOf = (goalInstanceId: string) =>
  Effect.map(
    GoalSchedules.use((schedules) => schedules.get(goalInstanceId)),
    (found): GoalMergeState | null => Option.getOrNull(Option.map(found, (s) => s.merge)),
  );

const mergeIs =
  (tag: keyof typeof GoalMergeState.cases) =>
  (state: GoalMergeState | null): boolean =>
    GoalMergeState.guards[tag](state);

layer(kanbanTestLayer, { excludeTestServices: true })((it) => {
  it.effect(
    "takes in a user branch that moved during the Goal check and checks again",
    () =>
      Effect.gen(function* () {
        const fixture = yield* kanbanFixture;
        const write = yield* writer;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const heads = yield* Ref.make<ReadonlyArray<string>>([]);
        const headOf = yield* headReader;
        const run = yield* openKanbanOwner(fixture, yield* Effect.scope, {
          agent: (agent) => Effect.as(write(agent, "a1.txt", "a1\n"), finished),
          verifyGoal: (input) =>
            Effect.gen(function* () {
              const head = yield* headOf(input.checkout.toolRoot);
              const seen = yield* Ref.getAndUpdate(heads, (list) => [...list, head]);
              if (seen.length === 0) {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
              }
              return passed;
            }),
        });
        const goal = yield* run(
          Effect.gen(function* () {
            const board = yield* executingPlan(fixture, [card("a1")]);
            yield* (yield* GoalSchedules).setProtectedBranches(board.projectId, []);
            yield* (yield* KanbanOrchestrator).start(board.sessionId);
            yield* Deferred.await(entered);
            const user = yield* userCommit(fixture, "user.txt", "user\n");
            yield* Deferred.succeed(release, undefined);
            yield* eventually(mergeOf(board.goalInstanceId), mergeIs("Merged"));
            return { goalInstanceId: board.goalInstanceId, user };
          }),
        );
        const checked = yield* Ref.get(heads);
        expect(checked).toHaveLength(2);
        // The second check saw the user's commit, and that is what main now points at.
        yield* git(fixture.project, "merge-base", "--is-ancestor", goal.user, checked[1] ?? "");
        expect(yield* git(fixture.project, "rev-parse", "main")).toBe(checked[1]);
        expect(yield* git(fixture.project, "show", "main:a1.txt")).toBe("a1");
      }),
    gitTimeout,
  );

  it.effect(
    "has an agent resolve a conflict with the user's branch, then checks and merges the result",
    () =>
      Effect.gen(function* () {
        const fixture = yield* kanbanFixture;
        const write = yield* writer;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const gate = yield* Deferred.make<void>();
        const started = yield* Deferred.make<void>();
        const asked = yield* Ref.make(Arr.empty<GoalConflictResolution>());
        const checked = yield* Ref.make(Arr.empty<string>());
        const readHead = yield* headReader;
        const run = yield* openKanbanOwner(fixture, yield* Effect.scope, {
          agent: (agent) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(gate);
              yield* write(agent, "a.txt", "card\n");
              return finished;
            }),
          resolveConflict: (input) =>
            Effect.gen(function* () {
              yield* Ref.update(asked, Arr.append(input));
              yield* fs
                .writeFileString(path.join(input.checkout.toolRoot, "a.txt"), "card\nuser\n")
                .pipe(Effect.orDie);
              return finished;
            }),
          verifyGoal: (input) =>
            Effect.gen(function* () {
              yield* Ref.update(checked, Arr.append(yield* readHead(input.checkout.toolRoot)));
              return passed;
            }),
        });
        yield* run(
          Effect.gen(function* () {
            const board = yield* executingPlan(fixture, [card("a1")]);
            yield* (yield* GoalSchedules).setProtectedBranches(board.projectId, []);
            yield* (yield* KanbanOrchestrator).start(board.sessionId);
            yield* Deferred.await(started);
            const user = yield* userCommit(fixture, "a.txt", "user\n");
            yield* Deferred.succeed(gate, undefined);
            yield* eventually(mergeOf(board.goalInstanceId), mergeIs("Merged"));
            expect(yield* (yield* HumanDecisions).pending(board.sessionId)).toEqual([]);
            // The resolved merge holds the user's commit, was checked, and is what main is now.
            const main = yield* git(fixture.project, "rev-parse", "main");
            yield* git(fixture.project, "merge-base", "--is-ancestor", user, main);
            expect(yield* Ref.get(checked)).toContain(main);
            expect(yield* git(fixture.project, "show", "main:a.txt")).toBe("card\nuser");
          }),
        );
        const [resolution, ...more] = yield* Ref.get(asked);
        expect(more).toEqual([]);
        expect(resolution).toMatchObject({ targetBranch: "main", files: ["a.txt"], notes: [] });
      }),
    gitTimeout,
  );

  it.effect(
    "gives the agent three tries and then asks a person when conflict markers remain",
    () =>
      Effect.gen(function* () {
        const fixture = yield* kanbanFixture;
        const write = yield* writer;
        const gate = yield* Deferred.make<void>();
        const started = yield* Deferred.make<void>();
        const notes = yield* Ref.make(Arr.empty<ReadonlyArray<string>>());
        const run = yield* openKanbanOwner(fixture, yield* Effect.scope, {
          agent: (agent) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(gate);
              yield* write(agent, "a.txt", "card\n");
              return finished;
            }),
          // Reports done without touching the markers.
          resolveConflict: (input) =>
            Effect.as(Ref.update(notes, Arr.append(input.notes)), finished),
        });
        yield* run(
          Effect.gen(function* () {
            const board = yield* executingPlan(fixture, [card("a1")]);
            yield* (yield* GoalSchedules).setProtectedBranches(board.projectId, []);
            yield* (yield* KanbanOrchestrator).start(board.sessionId);
            yield* Deferred.await(started);
            const user = yield* userCommit(fixture, "a.txt", "user\n");
            yield* Deferred.succeed(gate, undefined);
            const [request] = yield* eventually(
              (yield* HumanDecisions).pending(board.sessionId),
              (pending) => pending.length > 0,
            );
            expect(request?.kind).toMatchObject({ _tag: "MergeConflict", files: ["a.txt"] });
            yield* eventually(
              mergeOf(board.goalInstanceId),
              GoalMergeState.guards.AwaitingDecision,
            );
            // The unresolved merge was never committed: the Goal branch does not hold main.
            expect(yield* git(fixture.project, "rev-parse", "main")).toBe(user);
            expect(
              yield* git(fixture.project, "merge-base", user, `ctx/goal/${board.goalInstanceId}`),
            ).not.toBe(user);
          }),
        );
        const tries = yield* Ref.get(notes);
        expect(tries).toHaveLength(3);
        expect(tries[0]).toEqual([]);
        expect(tries[1]?.[0]).toContain("a.txt");
      }),
    gitTimeout,
  );

  it.effect(
    "asks a person when the agent cannot resolve a conflict with the user's branch",
    () =>
      Effect.gen(function* () {
        const fixture = yield* kanbanFixture;
        const write = yield* writer;
        const gate = yield* Deferred.make<void>();
        const started = yield* Deferred.make<void>();
        const run = yield* openKanbanOwner(fixture, yield* Effect.scope, {
          agent: (agent) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(gate);
              yield* write(agent, "a.txt", "card\n");
              return finished;
            }),
        });
        yield* run(
          Effect.gen(function* () {
            const board = yield* executingPlan(fixture, [card("a1")]);
            yield* (yield* GoalSchedules).setProtectedBranches(board.projectId, []);
            yield* (yield* KanbanOrchestrator).start(board.sessionId);
            yield* Deferred.await(started);
            const user = yield* userCommit(fixture, "a.txt", "user\n");
            yield* Deferred.succeed(gate, undefined);
            const [request] = yield* eventually(
              (yield* HumanDecisions).pending(board.sessionId),
              (pending) => pending.length > 0,
            );
            expect(request).toMatchObject({
              cardId: goalDecisionCardId,
              kind: DecisionKind.cases.MergeConflict.make({
                targetBranch: "main",
                files: ["a.txt"],
              }),
            });
            // The merge records its wait once the request returns, after the request shows.
            yield* eventually(
              mergeOf(board.goalInstanceId),
              GoalMergeState.guards.AwaitingDecision,
            );
            expect(yield* git(fixture.project, "rev-parse", "main")).toBe(user);
          }),
        );
      }),
    gitTimeout,
  );

  it.effect(
    "asks a person before merging into a protected branch",
    () =>
      Effect.gen(function* () {
        const fixture = yield* kanbanFixture;
        const write = yield* writer;
        const run = yield* openKanbanOwner(fixture, yield* Effect.scope, {
          agent: (agent) => Effect.as(write(agent, "a1.txt", "a1\n"), finished),
        });
        const before = yield* git(fixture.project, "rev-parse", "main");
        yield* run(
          Effect.gen(function* () {
            const decisions = yield* HumanDecisions;
            // main is protected unless the project says otherwise.
            const board = yield* executingPlan(fixture, [card("a1")]);
            yield* (yield* KanbanOrchestrator).start(board.sessionId);
            const [request] = yield* eventually(
              decisions.pending(board.sessionId),
              (pending) => pending.length > 0,
            );
            expect(DecisionKind.guards.ProtectedBranchMerge(request?.kind)).toBe(true);
            expect(request?.kind).toMatchObject({ targetBranch: "main" });
            if (request === undefined) return;
            yield* decisions.answer({
              ...request,
              answer: DecisionAnswer.cases.ProtectedBranchMerge.make({ choice: "manual_merge" }),
            });
            yield* (yield* KanbanOrchestrator).poke(board.goalInstanceId);
            yield* eventually(mergeOf(board.goalInstanceId), mergeIs("ManualMerge"));
          }),
        );
        expect(yield* git(fixture.project, "rev-parse", "main")).toBe(before);
      }),
    gitTimeout,
  );

  it.effect(
    "waits while the user's checkout has uncommitted changes and merges once it is clean",
    () =>
      Effect.gen(function* () {
        const fixture = yield* kanbanFixture;
        const fs = yield* FileSystem.FileSystem;
        const write = yield* writer;
        const gate = yield* Deferred.make<void>();
        const started = yield* Deferred.make<void>();
        const run = yield* openKanbanOwner(fixture, yield* Effect.scope, {
          agent: (agent) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(gate);
              yield* write(agent, "a1.txt", "a1\n");
              return finished;
            }),
        });
        const before = yield* git(fixture.project, "rev-parse", "main");
        yield* run(
          Effect.gen(function* () {
            const board = yield* executingPlan(fixture, [card("a1")]);
            yield* (yield* GoalSchedules).setProtectedBranches(board.projectId, []);
            yield* (yield* KanbanOrchestrator).start(board.sessionId);
            yield* Deferred.await(started);
            yield* fs.writeFileString(`${fixture.project}/a.txt`, "unsaved work\n");
            yield* Deferred.succeed(gate, undefined);
            yield* eventually(mergeOf(board.goalInstanceId), mergeIs("WaitingWorktree"));
            expect(yield* git(fixture.project, "rev-parse", "main")).toBe(before);
            expect(yield* fs.readFileString(`${fixture.project}/a.txt`)).toBe("unsaved work\n");
            // The user puts the change away; the next look merges.
            yield* git(fixture.project, "checkout", "--", "a.txt");
            yield* eventually(mergeOf(board.goalInstanceId), mergeIs("Merged"));
          }),
        );
        expect(yield* git(fixture.project, "show", "main:a1.txt")).toBe("a1");
      }),
    gitTimeout,
  );

  it.effect(
    "merges Goals into the same branch one at a time",
    () =>
      Effect.gen(function* () {
        const fixture = yield* kanbanFixture;
        const write = yield* writer;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const checks = yield* Ref.make<
          ReadonlyArray<{ readonly goal: string; readonly head: string }>
        >([]);
        const headOf = yield* headReader;
        const run = yield* openKanbanOwner(fixture, yield* Effect.scope, {
          cores: 4,
          agent: (agent) =>
            Effect.as(write(agent, `${agent.card.id}.txt`, `${agent.card.id}\n`), finished),
          verifyGoal: (input) =>
            Effect.gen(function* () {
              const head = yield* headOf(input.checkout.toolRoot);
              const seen = yield* Ref.getAndUpdate(checks, (list) => [
                ...list,
                { goal: input.goalInstanceId, head },
              ]);
              if (seen.length === 0) {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
              }
              return passed;
            }),
        });
        yield* run(
          Effect.gen(function* () {
            const orchestrator = yield* KanbanOrchestrator;
            const goalA = yield* executingPlan(fixture, [card("a1")]);
            yield* (yield* GoalSchedules).setProtectedBranches(goalA.projectId, []);
            const goalB = yield* executingSession(goalA.projectId, [card("b1")]);
            yield* orchestrator.start(goalA.sessionId);
            yield* orchestrator.start(goalB.sessionId);
            yield* Deferred.await(entered);
            // While the first merge is checked, the other Goal finishes but does not start its own.
            const [first] = yield* Ref.get(checks);
            const [other, otherSession] =
              first?.goal === goalA.goalInstanceId
                ? [goalB.goalInstanceId, goalB.sessionId]
                : [goalA.goalInstanceId, goalA.sessionId];
            yield* waitForCards(otherSession, (cards) =>
              cards.every((step) => step.status === "done"),
            );
            expect(yield* Ref.get(checks)).toHaveLength(1);
            yield* Deferred.succeed(release, undefined);
            yield* eventually(mergeOf(other), mergeIs("Merged"));
            expect(GoalMergeState.guards.Merged(yield* mergeOf(first?.goal ?? ""))).toBe(true);
          }),
        );
        const [first, second] = yield* Ref.get(checks);
        // The second Goal was checked with the first one's merge already taken in.
        yield* git(
          fixture.project,
          "merge-base",
          "--is-ancestor",
          first?.head ?? "",
          second?.head ?? "",
        );
        expect(yield* git(fixture.project, "show", "main:a1.txt")).toBe("a1");
        expect(yield* git(fixture.project, "show", "main:b1.txt")).toBe("b1");
      }),
    gitTimeout,
  );

  it.effect(
    "after another Goal merges, verifies again only the finished cards its change touched",
    () =>
      Effect.gen(function* () {
        const fixture = yield* kanbanFixture;
        const write = yield* writer;
        const gateA = yield* Deferred.make<void>();
        const reverified = yield* Ref.make<ReadonlyArray<string>>([]);
        const run = yield* openKanbanOwner(fixture, yield* Effect.scope, {
          cores: 8,
          agent: (agent) =>
            Effect.gen(function* () {
              switch (agent.card.id) {
                case "a1":
                  yield* Deferred.await(gateA);
                  yield* write(agent, "shared/x.txt", "a\n");
                  return finished;
                // Keeps Goal B from merging while it takes the change in.
                case "b3":
                  return yield* Effect.never;
                default:
                  yield* write(agent, `${agent.card.id}.txt`, `${agent.card.id}\n`);
                  return finished;
              }
            }),
          verify: (input) =>
            Effect.as(
              input.report.includes("took in")
                ? Ref.update(reverified, (list) => [...list, input.card.id])
                : Effect.void,
              passed,
            ),
        });
        yield* run(
          Effect.gen(function* () {
            const orchestrator = yield* KanbanOrchestrator;
            const goalA = yield* executingPlan(fixture, [card("a1")]);
            yield* (yield* GoalSchedules).setProtectedBranches(goalA.projectId, []);
            const goalB = yield* executingSession(
              goalA.projectId,
              [card("b1"), card("b2"), card("b3")],
              { b1: ["shared/"], b2: ["other/"] },
            );
            yield* orchestrator.start(goalA.sessionId);
            yield* orchestrator.start(goalB.sessionId);
            yield* waitForCards(
              goalB.sessionId,
              (cards) => Arr.countBy(cards, (step) => step.status === "done") === 2,
            );
            yield* Deferred.succeed(gateA, undefined);
            yield* eventually(mergeOf(goalA.goalInstanceId), mergeIs("Merged"));
            yield* eventually(Ref.get(reverified), (list) => list.length > 0);
            yield* eventually(
              Effect.map(
                GoalSchedules.use((schedules) => schedules.get(goalB.goalInstanceId)),
                (found) => Option.exists(found, (s) => !s.upstreamPending),
              ),
              (done) => done,
            );
          }),
        );
        expect(yield* Ref.get(reverified)).toEqual(["b1"]);
      }),
    gitTimeout,
  );
});
