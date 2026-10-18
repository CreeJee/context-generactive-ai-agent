import { Context, Effect, FiberMap, FileSystem, Layer, Option, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { keyedSerialLimit } from "../concurrency/keyed-limit.ts";
import { AppEvents } from "../events/app-events.ts";
import { findExecutable } from "../runtime/host.ts";
import type { BoardAuthor } from "../workflow/card.ts";
import { Workflows } from "../workflow/workflow.ts";
import { CardVerifier, GoalVerifier } from "./card-agent.ts";
import { CardAttempts, type KanbanGoal } from "./card-attempts.ts";
import { GoalSchedules, mergeSettled, type GoalMergeState } from "./goal-schedules.ts";
import { goalDecisionCardId, HumanDecisions, type DecisionKind } from "./human-decision.ts";
import { overlappingBoundaries, ProjectScheduler } from "./scheduler.ts";
import { CardWorktrees, goalBranchName, type GoalRef } from "./worktree.ts";
import { stopLogged } from "./background.ts";

/**
 * The merge queue of the project scheduler (docs/kanban-orchestration.md "브랜치 흐름" 5,
 * "프로젝트 스케줄러"). A Goal whose cards are all done takes the user's branch in, passes the
 * Goal-level check, and then moves the user's branch to the Goal branch. Merges into one branch
 * run one at a time, by the owner and outside any sandbox. Protected branches and conflicts go to a
 * person; a checkout with uncommitted changes is waited for, never overwritten.
 *
 * A merged Goal tells the project's other Goals with the same target, which take the change in and
 * verify again only the finished cards it touches. Every step reads the refs again, so running a
 * step twice is safe; the one effect that cannot be checked afterwards, a pull request, is never
 * run again on its own.
 */

/** The decisions the merge queue asks under its own name. */
const queueAuthor = (goalInstanceId: string): BoardAuthor => ({
  _tag: "Orchestrator",
  runId: `kanban-merge:${goalInstanceId}`,
});

/** How many times the user's branch may move under one merge before the next look tries again. */
const mergeRounds = 3;

const make = Effect.gen(function* () {
  const schedules = yield* GoalSchedules;
  const worktrees = yield* CardWorktrees;
  const decisions = yield* HumanDecisions;
  const goalVerifier = yield* GoalVerifier;
  const cardVerifier = yield* CardVerifier;
  const workflows = yield* Workflows;
  const attempts = yield* CardAttempts;
  const scheduler = yield* ProjectScheduler;
  const events = yield* AppEvents;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const serially = yield* keyedSerialLimit();
  const running = yield* FiberMap.make<string>();

  const goalRef = (goal: KanbanGoal): GoalRef => ({
    projectRoot: goal.projectRoot,
    goalInstanceId: goal.goalInstanceId,
  });
  const setMerge = (goal: KanbanGoal, state: GoalMergeState | null) =>
    Effect.tap(schedules.setMerge(goal.goalInstanceId, state), () =>
      events.publishSession(goal.sessionId, "run-state"),
    );

  /** Asks a person about the Goal's merge; the same occasion returns the same request. */
  const askGoal = Effect.fnUntraced(function* (goal: KanbanGoal, key: string, kind: DecisionKind) {
    const request = yield* decisions.request({
      sessionId: goal.sessionId,
      goalInstanceId: goal.goalInstanceId,
      cardId: goalDecisionCardId,
      key,
      kind,
      author: queueAuthor(goal.goalInstanceId),
    });
    yield* setMerge(goal, { _tag: "AwaitingDecision", requestId: request.requestId });
  });

  /** Runs a command once and returns its exit code and output; nothing here repeats it. */
  const runOnce = (command: string, cwd: string, args: ReadonlyArray<string>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(command, args, {
            cwd,
            env: { GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" },
            extendEnv: true,
            stdin: "ignore",
            stderr: "ignore",
          }),
        );
        const [stdout, exitCode] = yield* Effect.all(
          [child.stdout.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
          { concurrency: 2 },
        );
        return { exitCode: Number(exitCode), stdout };
      }),
    ).pipe(Effect.uninterruptible);

  /**
   * Pushes the Goal branch and opens a pull request into the target, as a person chose. The
   * pending state is written first: an owner that stops in between finds it and never retries.
   */
  const createPullRequest = Effect.fnUntraced(function* (goal: KanbanGoal, target: string) {
    yield* setMerge(goal, { _tag: "PullRequestPending" });
    const pushed = yield* worktrees
      .pushGoalBranch(goalRef(goal))
      .pipe(Effect.catchTag("CardWorktreeFailed", () => Effect.succeed(false)));
    if (!pushed) return yield* setMerge(goal, { _tag: "PullRequestFailed", stage: "push" });
    const gh = yield* findExecutable("gh").pipe(Effect.provideService(FileSystem.FileSystem, fs));
    const statement = (yield* workflows.get(goal.sessionId)).goal?.statement ?? "Kanban Goal";
    const created =
      gh === null
        ? Option.none<string>()
        : yield* runOnce(gh, goal.projectRoot, [
            "pr",
            "create",
            "--base",
            target,
            "--head",
            goalBranchName(goal.goalInstanceId),
            "--title",
            statement.slice(0, 200),
            "--body",
            `Kanban Goal ${goal.goalInstanceId}; every card passed verification and the Goal-level check.`,
          ]).pipe(
            Effect.map((output) =>
              output.exitCode === 0
                ? Option.fromUndefinedOr(output.stdout.trim().split("\n").at(-1))
                : Option.none<string>(),
            ),
            Effect.catchTag("PlatformError", () => Effect.succeedNone),
          );
    yield* setMerge(
      goal,
      Option.match(created, {
        onNone: (): GoalMergeState => ({ _tag: "PullRequestFailed", stage: "create" }),
        onSome: (url): GoalMergeState => ({ _tag: "PullRequestCreated", url }),
      }),
    );
  });

  /**
   * Follows the person's answer to the Goal's open request. Returns whether the merge goes on
   * now; a resolved conflict starts it over from the current refs.
   */
  const followDecision = Effect.fnUntraced(function* (
    goal: KanbanGoal,
    requestId: string,
    target: string,
  ) {
    const request = yield* decisions.get(requestId);
    if (Option.isNone(request)) return yield* Effect.as(setMerge(goal, null), true);
    const state = request.value.state;
    switch (state._tag) {
      case "Pending":
        return false;
      case "Closed":
        yield* setMerge(goal, { _tag: "Stopped", reason: "goal_replaced" });
        return false;
      case "Answered":
        break;
    }
    const answer = state.answer;
    switch (answer._tag) {
      case "MergeConflict":
        switch (answer.choice) {
          case "resolved":
            yield* setMerge(goal, null);
            return true;
          case "stop":
            yield* setMerge(goal, { _tag: "Stopped", reason: "conflict_stopped" });
            return false;
        }
      case "ProtectedBranchMerge":
        switch (answer.choice) {
          case "manual_merge":
            yield* setMerge(goal, { _tag: "ManualMerge" });
            yield* scheduler.pokeProject(goal.projectId);
            return false;
          case "create_pr":
            yield* createPullRequest(goal, target);
            return false;
        }
      default:
        return false;
    }
  });

  /** Tells the project's other Goals with the same target that it moved, and wakes them. */
  const announceMerge = Effect.fnUntraced(function* (goal: KanbanGoal, target: string) {
    const others = (yield* attempts.activeGoals).filter(
      (other) =>
        other.goalInstanceId !== goal.goalInstanceId &&
        other.projectRoot === goal.projectRoot &&
        other.mode === "worktree",
    );
    yield* Effect.forEach(
      others,
      Effect.fnUntraced(function* (other) {
        const schedule = yield* schedules.get(other.goalInstanceId);
        if (
          Option.exists(
            schedule,
            (found) => found.targetBranch === target && !mergeSettled(found.merge),
          )
        )
          yield* schedules.setUpstreamPending(other.goalInstanceId, true);
      }),
      { discard: true },
    );
    yield* scheduler.pokeProject(goal.projectId);
  });

  /** One pass of the Goal's merge from where its stored state stands. */
  const mergeGoal = Effect.fnUntraced(function* (goal: KanbanGoal) {
    const found = yield* schedules.get(goal.goalInstanceId);
    if (Option.isNone(found) || goal.mode !== "worktree") return;
    let schedule = found.value;
    const target = schedule.targetBranch;
    if (target === null) {
      if (schedule.merge === null) yield* setMerge(goal, { _tag: "Stopped", reason: "no_target" });
      return;
    }
    const ref = goalRef(goal);
    const state = schedule.merge;
    switch (state?._tag) {
      case undefined:
      case "Verifying":
      case "WaitingWorktree":
      case "TargetMoving":
        break;
      case "VerifyFailed":
        // Only a new Goal branch commit, from cards added after the failure, is checked again.
        if ((yield* worktrees.goalHead(ref)) === state.head) return;
        break;
      case "AwaitingDecision":
        if (!(yield* followDecision(goal, state.requestId, target))) return;
        break;
      default:
        return;
    }
    for (let round = 0; round < mergeRounds; round++) {
      const sync = yield* worktrees.mergeTargetIntoGoal(ref, target).pipe(
        Effect.asSome,
        Effect.catchTag("GoalMergeConflict", (conflict) =>
          Effect.as(
            askGoal(goal, `merge_conflict:${conflict.goalHead}:${conflict.targetHead}`, {
              _tag: "MergeConflict",
              targetBranch: target,
              files: conflict.files,
            }),
            Option.none(),
          ),
        ),
      );
      if (Option.isNone(sync)) return;
      const head = sync.value.head;
      if (schedule.verifiedHead !== head) {
        yield* setMerge(goal, { _tag: "Verifying", head });
        const workflow = yield* workflows.get(goal.sessionId);
        const artifact = workflow.goal;
        if (artifact === null) return;
        const verdict = yield* Effect.scoped(
          Effect.flatMap(worktrees.goalCheckout(ref, head), (checkout) =>
            goalVerifier.verify({
              sessionId: goal.sessionId,
              projectId: goal.projectId,
              goalInstanceId: goal.goalInstanceId,
              goal: artifact,
              cards: workflow.plan?.steps ?? [],
              checkout,
            }),
          ),
        );
        switch (verdict._tag) {
          case "Failed":
            yield* setMerge(goal, { _tag: "VerifyFailed", head, verdict: verdict.failure });
            yield* scheduler.poke(goal.goalInstanceId);
            return;
          case "Passed":
            yield* schedules.setVerifiedHead(goal.goalInstanceId, head);
            schedule = { ...schedule, verifiedHead: head };
        }
      }
      if ((yield* schedules.protectedBranches(goal.projectId)).includes(target)) {
        const gh = yield* findExecutable("gh").pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
        );
        return yield* askGoal(goal, `protected_branch:${head}`, {
          _tag: "ProtectedBranchMerge",
          targetBranch: target,
          prAvailable: gh !== null,
        });
      }
      const advanced = yield* worktrees.advanceTarget(ref, target, head);
      switch (advanced._tag) {
        case "Advanced":
          yield* setMerge(goal, { _tag: "Merged", commit: advanced.commit });
          return yield* announceMerge(goal, target);
        case "WorktreeBusy":
          return yield* setMerge(goal, {
            _tag: "WaitingWorktree",
            head,
            worktree: advanced.worktree,
          });
        case "TargetMoved":
          continue;
      }
    }
    yield* setMerge(goal, { _tag: "TargetMoving" });
  });

  /**
   * Takes in the target another Goal merged into, then verifies again the finished cards whose
   * expected files the change touched (a card without expected files counts as touched). Running
   * cards meet the change when they join the Goal branch. A conflict waits for this Goal's own
   * merge, which asks a person.
   */
  const takeUpstream = Effect.fnUntraced(function* (goal: KanbanGoal) {
    const found = yield* schedules.get(goal.goalInstanceId);
    if (Option.isNone(found) || !found.value.upstreamPending) return;
    const target = found.value.targetBranch;
    const ref = goalRef(goal);
    const sync =
      target === null
        ? Option.none()
        : yield* worktrees.mergeTargetIntoGoal(ref, target).pipe(
            Effect.asSome,
            Effect.catchTag("GoalMergeConflict", () => Effect.succeedNone),
          );
    if (Option.isSome(sync) && sync.value._tag === "Merged") {
      const { head, files } = sync.value;
      const steps = ((yield* workflows.get(goal.sessionId)).plan?.steps ?? []).filter(
        (step) =>
          step.status === "done" &&
          ((step.boundaries ?? []).length === 0 ||
            overlappingBoundaries(step, { boundaries: files }).length > 0),
      );
      if (steps.length > 0)
        yield* Effect.scoped(
          Effect.gen(function* () {
            const checkout = yield* worktrees.goalCheckout(ref, head);
            yield* Effect.forEach(
              steps,
              Effect.fnUntraced(function* (card) {
                const verdict = yield* cardVerifier.verify({
                  sessionId: goal.sessionId,
                  projectId: goal.projectId,
                  goalInstanceId: goal.goalInstanceId,
                  card,
                  worktree: checkout,
                  report: `The Goal branch took in ${target ?? ""} after another Goal merged into it; these files changed: ${files.join(", ")}. Check that this finished card still holds.`,
                });
                yield* attempts.updateLadder(goal.goalInstanceId, card.id, (current) => ({
                  ...current,
                  reason:
                    verdict._tag === "Failed"
                      ? { _tag: "UpstreamRegressed", verdict: verdict.failure }
                      : current.reason?._tag === "UpstreamRegressed"
                        ? null
                        : current.reason,
                }));
              }),
              { discard: true },
            );
          }),
        );
    }
    yield* schedules.setUpstreamPending(goal.goalInstanceId, false);
    yield* events.publishSession(goal.sessionId, "run-state");
  });

  /** Runs `work` for the Goal beside its loop, once at a time per Goal and per target. */
  const runFor = <E extends { readonly _tag: string }>(
    goal: KanbanGoal,
    name: string,
    work: Effect.Effect<void, E>,
    target: string | null,
  ) =>
    FiberMap.run(
      running,
      `${name}:${goal.goalInstanceId}`,
      serially(
        `target:${goal.projectRoot}:${target ?? ""}`,
        serially(`goal:${goal.goalInstanceId}`, work),
      ).pipe(
        // The stored merge state stays; the next look at the board runs the step again.
        stopLogged("Kanban merge queue step stopped", {
          goalInstanceId: goal.goalInstanceId,
          name,
        }),
        Effect.ensuring(scheduler.poke(goal.goalInstanceId)),
      ),
      { onlyIfMissing: true },
    );

  // A pull request whose result was never recorded is a person's to check; it is never re-run.
  yield* Effect.forEach(
    yield* schedules.all,
    (schedule) =>
      schedule.merge?._tag === "PullRequestPending"
        ? schedules.setMerge(schedule.goalInstanceId, { _tag: "PullRequestUncertain" })
        : Effect.void,
    { discard: true },
  );

  return {
    /** Starts or continues the merge of a Goal whose cards are all done. */
    offer: Effect.fn("GoalMerges.offer")(function* (goal: KanbanGoal) {
      const schedule = yield* schedules.get(goal.goalInstanceId);
      if (Option.isNone(schedule) || mergeSettled(schedule.value.merge)) return;
      yield* runFor(goal, "merge", mergeGoal(goal), schedule.value.targetBranch);
    }),

    /** Takes in a target another Goal merged into, when the Goal was told about one. */
    takeUpstream: Effect.fn("GoalMerges.takeUpstream")(function* (goal: KanbanGoal) {
      const schedule = yield* schedules.get(goal.goalInstanceId);
      if (Option.isNone(schedule) || !schedule.value.upstreamPending) return;
      yield* runFor(goal, "upstream", takeUpstream(goal), schedule.value.targetBranch);
    }),
  };
});

/** The merge queue of this owner's kanban Goals. */
export class GoalMerges extends Context.Service<GoalMerges, Effect.Success<typeof make>>()(
  "memory-agent/kanban/merge-queue/GoalMerges",
) {
  static readonly layer = Layer.effect(GoalMerges, make);
}
