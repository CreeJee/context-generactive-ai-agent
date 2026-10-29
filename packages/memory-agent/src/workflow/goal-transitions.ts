import { Data, Match, Result } from "effect";
import type {
  GoalArtifact,
  PlanArtifact,
  VerificationStatus,
  WorkflowPhase,
  WorkflowState,
} from "./workflow.ts";

/** The parts of a Goal its transitions read. */
export interface GoalStanding {
  readonly status: GoalArtifact["status"];
  /** Its recorded verification passed. */
  readonly passed: boolean;
  /** Its recorded verification passed with evidence. */
  readonly proven: boolean;
}

/** The parts of a Plan its transitions read. */
export interface PlanStanding {
  readonly status: PlanArtifact["status"];
  /** It was made for the Goal's current version. */
  readonly current: boolean;
  /** Every step is done. */
  readonly done: boolean;
  /** Every step is done with evidence. */
  readonly proven: boolean;
  readonly verification: VerificationStatus;
  /** Its verification has evidence. */
  readonly evidence: boolean;
  readonly recoveryPhase: "goal" | "plan" | null;
}

/** What decides a session's Goal transitions: its phase, its Goal and its Plan. */
export interface Standing {
  readonly phase: WorkflowPhase;
  readonly goal: GoalStanding | null;
  readonly plan: PlanStanding | null;
}

/** Whether every step is done, and done with evidence. */
export const stepsOf = (steps: PlanArtifact["steps"]) => ({
  done: steps.every((step) => step.status === "done"),
  proven: steps.every((step) => step.status === "done" && step.evidence.length > 0),
});

export const standingOf = (state: WorkflowState): Standing => ({
  phase: state.phase,
  goal:
    state.goal === null
      ? null
      : {
          status: state.goal.status,
          passed: state.goal.verification.status === "passed",
          proven:
            state.goal.verification.status === "passed" &&
            state.goal.verification.evidence.length > 0,
        },
  plan:
    state.plan === null
      ? null
      : {
          status: state.plan.status,
          current: state.goal?.version === state.plan.goalVersion,
          ...stepsOf(state.plan.steps),
          verification: state.plan.verification.status,
          evidence: state.plan.verification.evidence.length > 0,
          recoveryPhase: state.plan.verification.recoveryPhase,
        },
});

/**
 * Where a session's Goal stands, read from its Goal and Plan. The phase rides along: a screen the
 * user opened, or the progress position `reconciledPhase` corrects before a turn.
 */
export type GoalState = Data.TaggedEnum<{
  /** No Goal. A Plan written before any Goal waits for one. */
  NoGoal: { readonly standing: Standing };
  /** A draft or active Goal with no Plan to run: none, a draft, one to approve, or an earlier version's finished one. */
  Shaping: { readonly standing: Standing };
  /** An active Goal whose executing Plan was made for it. */
  Running: { readonly standing: Standing };
  /** An executing Plan made for an earlier version of the Goal. A kanban board reclassifies its cards. */
  GoalChanged: { readonly standing: Standing };
  Paused: { readonly standing: Standing };
  /** Verification found an external block, or the user stopped the Plan before reopening the Goal. */
  Blocked: { readonly standing: Standing };
  /** The Goal failed or the user stopped it. */
  Stopped: { readonly standing: Standing };
  /** The Plan ended without completing the Goal. */
  Closed: { readonly standing: Standing };
  Completed: { readonly standing: Standing };
}>;
export const GoalState = Data.taggedEnum<GoalState>();

/** A stored Goal and Plan no transition makes. `repair` turns each into a state. */
export type GoalStateConflict = Data.TaggedEnum<{
  /** R1: the Goal and its Plan finished, yet the phase stays in Execute. */
  GoalCompletedPhaseOpen: { readonly standing: Standing };
  /** R2: the Plan finished for the current Goal version, yet the Goal stays open. */
  PlanCompletedGoalOpen: { readonly standing: Standing };
  /** A draft Goal whose Plan executes for that very version. */
  Unknown: { readonly standing: Standing };
}>;
export const GoalStateConflict = Data.taggedEnum<GoalStateConflict>();

/** The state `standing` is in, or the conflict it shows. */
export const decodeGoalState = (
  standing: Standing,
): Result.Result<GoalState, GoalStateConflict> => {
  const { goal, plan } = standing;
  const state = (make: (fields: { readonly standing: Standing }) => GoalState) =>
    Result.succeed(make({ standing }));
  const conflict = (make: (fields: { readonly standing: Standing }) => GoalStateConflict) =>
    Result.fail(make({ standing }));
  if (goal === null) return state(GoalState.NoGoal);
  const current = plan?.current === true;
  return Match.value(goal.status).pipe(
    Match.withReturnType<Result.Result<GoalState, GoalStateConflict>>(),
    Match.when("failed", () => state(GoalState.Stopped)),
    Match.when("completed", () =>
      standing.phase === "execute" &&
      (plan === null || plan.status === "completed" || plan.status === "closed")
        ? conflict(GoalStateConflict.GoalCompletedPhaseOpen)
        : state(GoalState.Completed),
    ),
    Match.when("paused", () =>
      plan?.status === "closed"
        ? state(GoalState.Closed)
        : plan?.status === "completed" && current
          ? conflict(GoalStateConflict.PlanCompletedGoalOpen)
          : state(GoalState.Paused),
    ),
    Match.whenOr("draft", "active", (status) =>
      plan === null
        ? state(GoalState.Shaping)
        : Match.value(plan.status).pipe(
            Match.withReturnType<Result.Result<GoalState, GoalStateConflict>>(),
            Match.whenOr("draft", "ready", () => state(GoalState.Shaping)),
            Match.when("executing", () =>
              !current
                ? state(GoalState.GoalChanged)
                : status === "active"
                  ? state(GoalState.Running)
                  : conflict(GoalStateConflict.Unknown),
            ),
            Match.when("blocked", () => state(GoalState.Blocked)),
            Match.when("closed", () => state(GoalState.Closed)),
            Match.when("completed", () =>
              current && status === "active"
                ? conflict(GoalStateConflict.PlanCompletedGoalOpen)
                : state(GoalState.Shaping),
            ),
            Match.exhaustive,
          ),
    ),
    Match.exhaustive,
  );
};

/** The state a conflict is repaired to; the session's automatic runs stop with it. */
export const repair = (conflict: GoalStateConflict): GoalState =>
  Match.valueTags(conflict, {
    GoalCompletedPhaseOpen: ({ standing }) =>
      GoalState.Completed({ standing: { ...standing, phase: "completed" } }),
    // Recording the Goal's completion evidence again lets the next Verify run finish it.
    PlanCompletedGoalOpen: ({ standing }) => {
      const repaired: Standing = {
        ...standing,
        phase: "verify",
        plan: standing.plan === null ? null : { ...standing.plan, status: "executing" },
      };
      return standing.goal?.status === "paused"
        ? GoalState.Paused({ standing: repaired })
        : GoalState.Running({ standing: repaired });
    },
    // The user approves the Plan again once the Goal is active.
    Unknown: ({ standing }) =>
      GoalState.Shaping({
        standing: {
          ...standing,
          phase: "goal",
          plan: standing.plan === null ? null : { ...standing.plan, status: "ready" },
        },
      }),
  });

/** The state of `standing`, with a conflict repaired. */
export const goalStateOf = (standing: Standing): GoalState =>
  Result.match(decodeGoalState(standing), { onSuccess: (state) => state, onFailure: repair });

const progressing = (phase: WorkflowPhase) => phase === "execute" || phase === "verify";

/** The only progress position the stored artifacts can make progress from. */
export const reconciledPhase = ({ phase, goal, plan }: Standing): WorkflowPhase => {
  if (!progressing(phase)) return phase;
  if (plan === null || goal === null) return goal === null ? "goal" : "plan";
  if (!plan.current) return "plan";
  if (plan.status !== "executing")
    return plan.status === "completed" || plan.status === "blocked" ? phase : "plan";
  if (plan.verification === "failed" && plan.evidence) return "execute";
  if (phase === "execute") return plan.proven ? "verify" : "execute";
  if (!plan.proven) return "execute";
  if (!plan.evidence) return "verify";
  return Match.value(plan.verification).pipe(
    Match.withReturnType<WorkflowPhase>(),
    Match.when("failed", () => "execute"),
    Match.when("invalid_hypothesis", () => plan.recoveryPhase ?? "plan"),
    Match.whenOr("invalid_criterion", "inconclusive", () => "plan"),
    Match.whenOr("not_run", "passed", "blocked", () => "verify"),
    Match.exhaustive,
  );
};

/** Something a session's user, model or owner does to its Goal. */
export type GoalEvent = Data.TaggedEnum<{
  /** The user opens a screen. Execute is `ExecutionApproved`. */
  Navigated: { readonly phase: Exclude<WorkflowPhase, "execute"> };
  /** The user approves the Plan, or continues an executing one. */
  ExecutionApproved: {};
  GoalPaused: {};
  GoalResumed: {};
  GoalStopped: {};
  /** A new version of the Goal; `kanban` when an active board runs it. */
  GoalEdited: { readonly status: "draft" | "active"; readonly kanban: boolean };
  /** A new version of the Plan, its steps not started. */
  PlanEdited: {
    readonly status: "draft" | "ready";
    readonly done: boolean;
    readonly proven: boolean;
  };
  /**
   * The model records progress. The statuses are the ones it asks for; `staged` holds a completion
   * a running recorder asks for until its run settles. The step fields describe the merged steps.
   */
  ProgressRecorded: {
    readonly goalStatus: "active" | "paused" | "completed" | "failed" | null;
    readonly planStatus: "executing" | "completed" | "blocked" | null;
    readonly staged: boolean;
    readonly unknownStep: boolean;
    readonly stepsUpdated: boolean;
    readonly stepEvidenceMissing: boolean;
    readonly done: boolean;
    readonly proven: boolean;
    readonly planEvidence: boolean;
    readonly verification: {
      readonly status: VerificationStatus;
      readonly evidence: boolean;
      readonly recoveryPhase: "goal" | "plan" | null;
    } | null;
  };
  /** A run that started in `startedPhase` ended. `completionRecorded` when its completion evidence holds. */
  RunFinished: { readonly startedPhase: WorkflowPhase; readonly completionRecorded: boolean };
  PlanClosed: {};
  NewGoalRequested: {};
  NewGoalStarted: { readonly status: "draft" | "active" };
  /** A board change; `closes` when it ends the Plan. The step fields describe the changed steps. */
  BoardEdited: { readonly closes: boolean; readonly done: boolean; readonly proven: boolean };
}>;
export const GoalEvent = Data.taggedEnum<GoalEvent>();

/** Why each event can be refused. */
export interface GoalRefusals {
  readonly Navigated: "goal_terminal";
  readonly ExecutionApproved: "plan_outdated" | "plan_not_ready" | "goal_terminal";
  readonly GoalPaused: "goal_missing" | "goal_terminal" | "goal_not_active";
  readonly GoalResumed: "goal_missing" | "goal_terminal" | "goal_not_paused";
  readonly GoalStopped: "goal_missing" | "goal_terminal";
  readonly GoalEdited: never;
  readonly PlanEdited: never;
  readonly ProgressRecorded:
    | "goal_missing"
    | "goal_terminal"
    | "plan_missing"
    | "unknown_step"
    | "phase_not_executable"
    | "step_evidence_required"
    | "verification_required"
    | "steps_incomplete"
    | "goal_completion_required"
    | "goal_not_active";
  readonly RunFinished: never;
  readonly PlanClosed: "plan_missing" | "plan_closed";
  readonly NewGoalRequested: "goal_missing" | "phase_not_authorized";
  readonly NewGoalStarted: "goal_missing" | "phase_not_authorized";
  readonly BoardEdited: "plan_missing";
}
export type GoalRefusal = GoalRefusals[keyof GoalRefusals];

/** An event's outcome: the standing it moves to, or why it was refused. */
export type Transition<Reason> = Moved | ([Reason] extends [never] ? never : Refused<Reason>);
interface Moved {
  readonly _tag: "Moved";
  readonly standing: Standing;
}
interface Refused<Reason> {
  readonly _tag: "Refused";
  readonly reason: Reason;
}

const moved = (standing: Standing): Moved => ({ _tag: "Moved", standing });
const refused = <const Reason extends string>(reason: Reason): Refused<Reason> => ({
  _tag: "Refused",
  reason,
});
const terminal = () => refused("goal_terminal");

type Event<Tag extends GoalEvent["_tag"]> = Extract<GoalEvent, { readonly _tag: Tag }>;
type GoalTransitions = {
  readonly [Tag in GoalEvent["_tag"]]: (
    state: GoalState,
    event: Event<Tag>,
  ) => Transition<GoalRefusals[Tag]>;
};

const approve = ({ standing }: { readonly standing: Standing }) => {
  const { goal, plan } = standing;
  if (goal !== null && plan !== null && !plan.current) return refused("plan_outdated");
  if (goal === null || plan === null || (plan.status !== "ready" && plan.status !== "executing"))
    return refused("plan_not_ready");
  return moved({
    phase: "execute",
    goal: goal.status === "draft" ? { ...goal, status: "active" } : goal,
    plan: plan.status === "ready" ? { ...plan, status: "executing" } : plan,
  });
};

const withGoal =
  (next: (standing: Standing, goal: GoalStanding) => Moved) =>
  ({ standing }: { readonly standing: Standing }): Transition<"goal_missing"> =>
    standing.goal === null ? refused("goal_missing") : next(standing, standing.goal);

const pause = withGoal((standing, goal) =>
  moved({ ...standing, goal: { ...goal, status: "paused" } }),
);
const resume = withGoal((standing, goal) =>
  moved({
    ...standing,
    phase: standing.plan?.status === "executing" ? "execute" : "goal",
    goal: { ...goal, status: "active" },
  }),
);
const stop = withGoal((standing, goal) =>
  moved({
    ...standing,
    goal: { ...goal, status: "failed" },
    plan:
      standing.plan?.status === "executing"
        ? { ...standing.plan, status: "blocked" }
        : standing.plan,
  }),
);

/** A new Goal version; a kanban board keeps executing and reclassifies its cards. */
const editGoal =
  ({ status, kanban }: Event<"GoalEdited">) =>
  ({ standing }: { readonly standing: Standing }) =>
    moved({
      phase: progressing(standing.phase)
        ? kanban
          ? standing.phase
          : "plan"
        : standing.phase === "completed"
          ? "goal"
          : standing.phase,
      goal: { status, passed: false, proven: false },
      plan: standing.plan === null ? null : { ...standing.plan, current: false },
    });

const editPlan =
  ({ status, done, proven }: Event<"PlanEdited">) =>
  ({ standing }: { readonly standing: Standing }) =>
    moved({
      phase: progressing(standing.phase) ? "plan" : standing.phase,
      goal: standing.goal,
      plan: {
        status,
        current: standing.goal !== null,
        done,
        proven,
        verification: "not_run",
        evidence: false,
        recoveryPhase: null,
      },
    });

const record =
  (event: Event<"ProgressRecorded">) =>
  ({ standing }: { readonly standing: Standing }): Transition<GoalRefusals["ProgressRecorded"]> => {
    const { phase, goal, plan } = standing;
    const { verification } = event;
    if (event.goalStatus !== null && goal === null) return refused("goal_missing");
    // Only a new Goal version reopens a finished Goal.
    if (
      (goal?.status === "completed" || goal?.status === "failed") &&
      event.goalStatus !== null &&
      event.goalStatus !== goal.status
    )
      return refused("goal_terminal");
    if ((event.planStatus !== null || event.stepsUpdated) && plan === null)
      return refused("plan_missing");
    if (event.unknownStep) return refused("unknown_step");
    if (
      phase === "plan" &&
      (event.planStatus !== null ||
        event.stepsUpdated ||
        event.planEvidence ||
        verification !== null)
    )
      return refused("phase_not_executable");
    if (event.stepEvidenceMissing) return refused("step_evidence_required");
    const verified = verification?.status === "passed" && verification.evidence;
    if (event.goalStatus === "completed" && !(verification === null ? goal?.proven : verified))
      return refused("verification_required");
    if (
      event.planStatus === "completed" &&
      !(verification === null ? plan?.verification === "passed" && plan.evidence : verified)
    )
      return refused("verification_required");
    if (event.planStatus === "completed" && !event.done) return refused("steps_incomplete");
    // A running recorder's completion waits for its run to settle.
    const goalStatus = event.staged && event.goalStatus === "completed" ? null : event.goalStatus;
    const planStatus = event.staged && event.planStatus === "completed" ? null : event.planStatus;
    const recordGoal =
      verification !== null &&
      (event.goalStatus !== null || phase === "goal" || phase === "verify" || plan === null);
    const recordPlan =
      verification !== null &&
      (event.planStatus !== null || phase === "execute" || phase === "verify");
    const nextGoal: GoalStanding | null =
      goal === null
        ? null
        : {
            status: goalStatus ?? goal.status,
            passed: recordGoal ? verification.status === "passed" : goal.passed,
            proven: recordGoal ? verified : goal.proven,
          };
    const nextPlan: PlanStanding | null =
      plan === null
        ? null
        : {
            status: planStatus ?? plan.status,
            current: plan.current,
            done: event.done,
            proven: event.proven,
            verification: recordPlan ? verification.status : plan.verification,
            evidence: recordPlan ? verification.evidence : plan.evidence,
            recoveryPhase: recordPlan ? verification.recoveryPhase : plan.recoveryPhase,
          };
    // A Plan finishes its Goal, never on its own.
    if (
      nextPlan?.status === "completed" &&
      nextPlan.current &&
      nextGoal !== null &&
      nextGoal.status !== "completed" &&
      nextGoal.status !== "failed"
    )
      return refused("goal_completion_required");
    if (nextPlan?.status === "executing" && nextPlan.current && nextGoal?.status === "draft")
      return refused("goal_not_active");
    return moved({
      phase:
        nextGoal?.status === "completed" && nextPlan?.status === "completed" && progressing(phase)
          ? "completed"
          : phase,
      goal: nextGoal,
      plan: nextPlan,
    });
  };

const finish =
  ({ startedPhase, completionRecorded }: Event<"RunFinished">) =>
  ({ standing }: { readonly standing: Standing }) => {
    const { phase, goal, plan } = standing;
    if (startedPhase === "execute" && phase === "execute")
      return moved(
        plan !== null &&
          plan.status === "executing" &&
          plan.verification !== "failed" &&
          plan.proven
          ? { ...standing, phase: "verify" }
          : standing,
      );
    if (startedPhase !== "verify" || phase !== "verify" || plan === null) return moved(standing);
    if (
      plan.status === "completed" ||
      plan.status === "closed" ||
      plan.verification === "not_run" ||
      !plan.evidence
    )
      return moved(standing);
    if (plan.verification !== "passed")
      return moved({
        ...standing,
        phase: Match.value(plan.verification).pipe(
          Match.withReturnType<WorkflowPhase>(),
          Match.when("failed", () => "execute"),
          Match.when("invalid_hypothesis", () => plan.recoveryPhase ?? "plan"),
          Match.when("blocked", () => "verify"),
          Match.whenOr("invalid_criterion", "inconclusive", () => "plan"),
          Match.exhaustive,
        ),
        plan: plan.verification === "blocked" ? { ...plan, status: "blocked" } : plan,
      });
    if (!plan.done || !completionRecorded || goal === null) return moved(standing);
    return moved({
      phase: "completed",
      goal: { status: "completed", passed: true, proven: true },
      plan: { ...plan, status: "completed" },
    });
  };

const close = ({ standing }: { readonly standing: Standing }) => {
  const { plan } = standing;
  if (plan === null) return refused("plan_missing");
  if (plan.status === "completed" || plan.status === "closed") return refused("plan_closed");
  return moved({
    ...standing,
    phase: progressing(standing.phase) ? "plan" : standing.phase,
    plan: { ...plan, status: "closed" },
  });
};

/** A new Goal starts from Goal or Plan, or once the current Goal's verification closed. */
const newGoal =
  (status: "draft" | "active" | null) =>
  ({ standing }: { readonly standing: Standing }): Transition<GoalRefusals["NewGoalStarted"]> => {
    const { phase, goal, plan } = standing;
    const started = (next: WorkflowPhase) =>
      moved(
        status === null
          ? standing
          : { phase: next, goal: { status, passed: false, proven: false }, plan: null },
      );
    if (phase === "goal" || phase === "plan")
      return goal === null ? refused("goal_missing") : started(phase);
    const closed = goal?.status === "completed" && goal.passed;
    if (
      closed &&
      (phase === "verify" ||
        (phase === "completed" && plan?.status === "completed" && plan.verification === "passed"))
    )
      return started("goal");
    return refused("phase_not_authorized");
  };

const editBoard =
  ({ closes, done, proven }: Event<"BoardEdited">) =>
  ({ standing }: { readonly standing: Standing }) =>
    standing.plan === null
      ? refused("plan_missing")
      : moved({
          ...standing,
          phase: closes && progressing(standing.phase) ? "plan" : standing.phase,
          plan: {
            ...standing.plan,
            status: closes ? "closed" : standing.plan.status,
            done,
            proven,
          },
        });

/** Every event in every state. A state that is missing from an event is a type error. */
export const goalTransitions: GoalTransitions = {
  Navigated: (state, { phase }) => {
    const navigate = ({ standing }: { readonly standing: Standing }) =>
      phase === "completed" ? terminal() : moved({ ...standing, phase });
    return Match.valueTags(state, {
      NoGoal: navigate,
      Shaping: navigate,
      Running: navigate,
      GoalChanged: navigate,
      Paused: navigate,
      Blocked: navigate,
      Stopped: navigate,
      Closed: navigate,
      Completed: navigate,
    });
  },
  ExecutionApproved: (state) =>
    Match.valueTags(state, {
      NoGoal: approve,
      Shaping: approve,
      Running: approve,
      GoalChanged: approve,
      Paused: approve,
      Blocked: approve,
      Closed: approve,
      Stopped: terminal,
      Completed: terminal,
    }),
  GoalPaused: (state) =>
    Match.valueTags(state, {
      NoGoal: () => refused("goal_missing"),
      Shaping: pause,
      Running: pause,
      GoalChanged: pause,
      Blocked: pause,
      Closed: pause,
      Paused: () => refused("goal_not_active"),
      Stopped: terminal,
      Completed: terminal,
    }),
  GoalResumed: (state) =>
    Match.valueTags(state, {
      NoGoal: () => refused("goal_missing"),
      Paused: resume,
      Shaping: () => refused("goal_not_paused"),
      Running: () => refused("goal_not_paused"),
      GoalChanged: () => refused("goal_not_paused"),
      Blocked: () => refused("goal_not_paused"),
      Closed: () => refused("goal_not_paused"),
      Stopped: terminal,
      Completed: terminal,
    }),
  GoalStopped: (state) =>
    Match.valueTags(state, {
      NoGoal: () => refused("goal_missing"),
      Shaping: stop,
      Running: stop,
      GoalChanged: stop,
      Paused: stop,
      Blocked: stop,
      Closed: stop,
      Stopped: terminal,
      Completed: terminal,
    }),
  GoalEdited: (state, event) =>
    Match.valueTags(state, {
      NoGoal: editGoal(event),
      Shaping: editGoal(event),
      Running: editGoal(event),
      GoalChanged: editGoal(event),
      Paused: editGoal(event),
      Blocked: editGoal(event),
      Stopped: editGoal(event),
      Closed: editGoal(event),
      Completed: editGoal(event),
    }),
  PlanEdited: (state, event) =>
    Match.valueTags(state, {
      NoGoal: editPlan(event),
      Shaping: editPlan(event),
      Running: editPlan(event),
      GoalChanged: editPlan(event),
      Paused: editPlan(event),
      Blocked: editPlan(event),
      Stopped: editPlan(event),
      Closed: editPlan(event),
      Completed: editPlan(event),
    }),
  ProgressRecorded: (state, event) =>
    Match.valueTags(state, {
      NoGoal: record(event),
      Shaping: record(event),
      Running: record(event),
      GoalChanged: record(event),
      Paused: record(event),
      Blocked: record(event),
      Stopped: record(event),
      Closed: record(event),
      Completed: record(event),
    }),
  RunFinished: (state, event) =>
    Match.valueTags(state, {
      NoGoal: finish(event),
      Shaping: finish(event),
      Running: finish(event),
      GoalChanged: finish(event),
      Paused: finish(event),
      Blocked: finish(event),
      // A run that ends after the user stopped the Goal changes nothing.
      Stopped: ({ standing }) => moved(standing),
      Closed: finish(event),
      Completed: finish(event),
    }),
  PlanClosed: (state) =>
    Match.valueTags(state, {
      NoGoal: close,
      Shaping: close,
      Running: close,
      GoalChanged: close,
      Paused: close,
      Blocked: close,
      Stopped: close,
      Closed: close,
      Completed: close,
    }),
  NewGoalRequested: (state) =>
    Match.valueTags(state, {
      NoGoal: newGoal(null),
      Shaping: newGoal(null),
      Running: newGoal(null),
      GoalChanged: newGoal(null),
      Paused: newGoal(null),
      Blocked: newGoal(null),
      Stopped: newGoal(null),
      Closed: newGoal(null),
      Completed: newGoal(null),
    }),
  NewGoalStarted: (state, { status }) =>
    Match.valueTags(state, {
      NoGoal: newGoal(status),
      Shaping: newGoal(status),
      Running: newGoal(status),
      GoalChanged: newGoal(status),
      Paused: newGoal(status),
      Blocked: newGoal(status),
      Stopped: newGoal(status),
      Closed: newGoal(status),
      Completed: newGoal(status),
    }),
  BoardEdited: (state, event) =>
    Match.valueTags(state, {
      NoGoal: editBoard(event),
      Shaping: editBoard(event),
      Running: editBoard(event),
      GoalChanged: editBoard(event),
      Paused: editBoard(event),
      Blocked: editBoard(event),
      Stopped: editBoard(event),
      Closed: editBoard(event),
      Completed: editBoard(event),
    }),
};

/** `event` in `state`, whichever event it is. */
export const transition = (state: GoalState, event: GoalEvent): Transition<GoalRefusal> =>
  Match.valueTags(event, {
    Navigated: (value) => goalTransitions.Navigated(state, value),
    ExecutionApproved: (value) => goalTransitions.ExecutionApproved(state, value),
    GoalPaused: (value) => goalTransitions.GoalPaused(state, value),
    GoalResumed: (value) => goalTransitions.GoalResumed(state, value),
    GoalStopped: (value) => goalTransitions.GoalStopped(state, value),
    GoalEdited: (value) => goalTransitions.GoalEdited(state, value),
    PlanEdited: (value) => goalTransitions.PlanEdited(state, value),
    ProgressRecorded: (value) => goalTransitions.ProgressRecorded(state, value),
    RunFinished: (value) => goalTransitions.RunFinished(state, value),
    PlanClosed: (value) => goalTransitions.PlanClosed(state, value),
    NewGoalRequested: (value) => goalTransitions.NewGoalRequested(state, value),
    NewGoalStarted: (value) => goalTransitions.NewGoalStarted(state, value),
    BoardEdited: (value) => goalTransitions.BoardEdited(state, value),
  });
