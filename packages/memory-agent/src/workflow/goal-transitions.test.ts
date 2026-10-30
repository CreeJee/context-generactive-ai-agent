import { Result } from "effect";
import { describe, expect, it } from "vite-plus/test";
import {
  decodeGoalState,
  GoalEvent,
  type GoalState,
  type Standing,
  repair,
  standingOf,
  transition,
} from "./goal-transitions.ts";
import type { GoalArtifact, PlanArtifact, WorkflowState } from "./workflow.ts";

const stateTags: ReadonlyArray<GoalState["_tag"]> = [
  "NoGoal",
  "Shaping",
  "Running",
  "GoalChanged",
  "Paused",
  "Blocked",
  "Stopped",
  "Closed",
  "Completed",
];
const verifications = (
  ["passed", "failed", "invalid_hypothesis", "invalid_criterion", "blocked", "not_run"] as const
).map((status) => ({
  status,
  evidence: true,
  recoveryPhase: status === "invalid_hypothesis" ? ("goal" as const) : null,
}));
const steps = [
  { done: true, proven: true },
  { done: false, proven: false },
] as const;

/** Every event a test can send in `standing`; progress describes the steps it leaves. */
const eventsFor = (standing: Standing): ReadonlyArray<GoalEvent> => [
  ...(["chat", "goal", "plan", "verify", "completed"] as const).map((phase) =>
    GoalEvent.Navigated({ phase }),
  ),
  GoalEvent.ExecutionApproved(),
  GoalEvent.GoalPaused(),
  GoalEvent.GoalResumed(),
  GoalEvent.GoalStopped(),
  ...(["draft", "active"] as const).flatMap((status) =>
    [false, true].map((kanban) => GoalEvent.GoalEdited({ status, kanban })),
  ),
  ...(["draft", "ready"] as const).flatMap((status) =>
    steps.map((step) => GoalEvent.PlanEdited({ status, ...step })),
  ),
  ...([null, "active", "paused", "completed", "failed"] as const).flatMap((goalStatus) =>
    ([null, "executing", "completed", "blocked"] as const).flatMap((planStatus) =>
      [null, ...steps].flatMap((step) =>
        [null, ...verifications].map((verification) =>
          GoalEvent.ProgressRecorded({
            goalStatus,
            planStatus,
            staged: false,
            unknownStep: false,
            stepsUpdated: step !== null,
            stepEvidenceMissing: false,
            done: step?.done ?? standing.plan?.done ?? true,
            proven: step?.proven ?? standing.plan?.proven ?? true,
            planEvidence: false,
            verification,
          }),
        ),
      ),
    ),
  ),
  ...(["execute", "verify"] as const).flatMap((startedPhase) =>
    [true, false].map((completionRecorded) =>
      GoalEvent.RunFinished({ startedPhase, completionRecorded }),
    ),
  ),
  GoalEvent.PlanClosed(),
  GoalEvent.NewGoalRequested(),
  ...(["draft", "active"] as const).map((status) => GoalEvent.NewGoalStarted({ status })),
  ...[false, true].flatMap((closes) =>
    steps.map((step) => GoalEvent.BoardEdited({ closes, ...step })),
  ),
];

const keyOf = ({ phase, goal, plan }: Standing) =>
  [
    phase,
    goal?.status,
    goal?.passed,
    goal?.proven,
    plan?.status,
    plan?.current,
    plan?.done,
    plan?.proven,
    plan?.verification,
    plan?.evidence,
    plan?.recoveryPhase,
  ].join();
const tagOf = (standing: Standing) =>
  Result.match(decodeGoalState(standing), {
    onSuccess: (state) => state._tag,
    onFailure: (conflict) => conflict._tag,
  });

/** What sending every event from a new session finds. */
const reached = {
  standings: new Map<string, Standing>(),
  /** Outcome texts by state and event. */
  outcomes: new Map<string, Set<string>>(),
  /** Where each standing is moved from, without stopping or a new Goal. */
  sources: new Map<string, Set<string>>(),
};
const add = (map: Map<string, Set<string>>, key: string, value: string) =>
  map.set(key, (map.get(key) ?? new Set()).add(value));

const explore = (frontier: ReadonlyArray<Standing>): void => {
  if (frontier.length === 0) return;
  const fresh = frontier.flatMap((from) => {
    const fromKey = keyOf(from);
    const tag = tagOf(from);
    return Result.match(decodeGoalState(from), {
      onFailure: () => [],
      onSuccess: (state) =>
        eventsFor(from).flatMap((event) => {
          const outcome = transition(state, event);
          const at = `${tag}|${event._tag}`;
          if (outcome._tag === "Refused") {
            add(reached.outcomes, at, `거절: \`${outcome.reason}\``);
            return [];
          }
          const to = outcome.standing;
          const toKey = keyOf(to);
          add(reached.outcomes, at, toKey === fromKey ? "그대로" : tagOf(to));
          if (event._tag !== "GoalStopped" && event._tag !== "NewGoalStarted")
            add(reached.sources, toKey, fromKey);
          if (reached.standings.has(toKey)) return [];
          reached.standings.set(toKey, to);
          return [to];
        }),
    });
  });
  explore(fresh);
};
const start: Standing = { phase: "chat", goal: null, plan: null };
reached.standings.set(keyOf(start), start);
explore([start]);
const standings = [...reached.standings.values()];

/** `found` and every standing that moves into it, walking the moves backwards from `frontier`. */
const reaching = (frontier: ReadonlyArray<string>, found: Set<string>): ReadonlySet<string> => {
  const fresh = [
    ...new Set(frontier.flatMap((key) => [...(reached.sources.get(key) ?? [])])),
  ].filter((from) => !found.has(from));
  fresh.forEach((from) => found.add(from));
  return fresh.length === 0 ? found : reaching(fresh, found);
};

/** A stored state with `standing`, as a session would hold it. */
const stateFor = (standing: Standing): WorkflowState => {
  const verification = (status: GoalArtifact["verification"]["status"], evidence: boolean) => ({
    status,
    summary: "",
    evidence: evidence ? ["proof"] : [],
    recoveryPhase: null,
    updatedAt: null,
  });
  const goal: GoalArtifact | null =
    standing.goal === null
      ? null
      : {
          version: 2,
          statement: "goal",
          outcomes: [],
          constraints: [],
          nonGoals: [],
          assumptions: [],
          openQuestions: [],
          evidence: [],
          verification: verification(
            standing.goal.passed ? "passed" : "not_run",
            standing.goal.proven,
          ),
          updatedAt: "now",
          status: standing.goal.status,
        };
  const plan: PlanArtifact | null =
    standing.plan === null
      ? null
      : {
          version: 1,
          goalVersion: standing.plan.current ? 2 : 1,
          summary: "plan",
          steps: [
            {
              id: "step",
              title: "step",
              description: "",
              dependsOn: [],
              acceptanceCriteria: [],
              ruleRefs: [],
              status: standing.plan.done ? "done" : "ready",
              evidence: standing.plan.proven ? ["proof"] : [],
            },
          ],
          risks: [],
          openQuestions: [],
          evidence: [],
          verification: {
            ...verification(standing.plan.verification, standing.plan.evidence),
            recoveryPhase: standing.plan.recoveryPhase,
          },
          updatedAt: "now",
          status: standing.plan.status,
        };
  return { phase: standing.phase, goal, plan, ledger: [] };
};

/** The reviewed list of transitions, grouped by state and event. Lists keep the formatter out. */
const transitionsDocument = () => {
  const counts = stateTags.map(
    (tag) => `- \`${tag}\`: ${standings.filter((standing) => tagOf(standing) === tag).length}`,
  );
  const events = [...new Set(eventsFor(start).map((event) => event._tag))];
  const sections = stateTags.flatMap((tag) => [
    "",
    `## \`${tag}\``,
    "",
    ...events.flatMap((event) => {
      const results = [...(reached.outcomes.get(`${tag}|${event}`) ?? [])].sort();
      return results.length === 0 ? [] : [`- \`${event}\`: ${results.join(", ")}`];
    }),
  ]);
  return [
    "# Goal 상태 전이",
    "",
    "`packages/memory-agent/src/workflow/goal-transitions.test.ts`가 만든다. 새 세션에서 모든 사건을 보내 도달한 상태와, 상태마다 각 사건의 결과다. 결과의 상태 이름은 사건 뒤의 상태이고, 그대로는 바뀐 것이 없다는 뜻이다. 전이를 바꾸면 이 파일이 바뀌므로 diff를 리뷰한다.",
    "",
    "## 도달한 상태 수",
    "",
    ...counts,
    ...sections,
    "",
  ].join("\n");
};

describe("Goal transitions", () => {
  it("never reaches a conflict from a new session", () => {
    expect(standings.filter((standing) => Result.isFailure(decodeGoalState(standing)))).toEqual([]);
  });

  it("reaches Completed from every reached state without stopping or a new Goal", () => {
    const completed = standings.filter((standing) => tagOf(standing) === "Completed").map(keyOf);
    const finishing = reaching(completed, new Set(completed));
    expect(standings.filter((standing) => !finishing.has(keyOf(standing)))).toEqual([]);
  });

  it("stores every reached state and reads it back the same", () => {
    expect(
      standings.filter((standing) => keyOf(standingOf(stateFor(standing))) !== keyOf(standing)),
    ).toEqual([]);
  });

  it("matches the reviewed list of transitions", () =>
    expect(transitionsDocument()).toMatchFileSnapshot("../../../../docs/goal-transitions.md"));

  it("repairs each conflict 0.0.17 could leave to a state it stays in", () => {
    const goal = { status: "completed", passed: true, proven: true } as const;
    const plan = {
      status: "completed",
      current: true,
      done: true,
      proven: true,
      verification: "passed",
      evidence: true,
      recoveryPhase: null,
    } as const;
    const conflicts: ReadonlyArray<readonly [Standing, GoalState["_tag"], Standing["phase"]]> = [
      [{ phase: "execute", goal, plan }, "Completed", "completed"],
      [{ phase: "execute", goal: { ...goal, status: "active" }, plan }, "Running", "verify"],
      [
        {
          phase: "plan",
          goal: { ...goal, status: "draft" },
          plan: { ...plan, status: "executing" },
        },
        "Shaping",
        "goal",
      ],
    ];
    expect(
      conflicts.map(([standing]) =>
        Result.match(decodeGoalState(standing), {
          onSuccess: () => null,
          onFailure: (conflict) => {
            const repaired = repair(conflict);
            return [repaired._tag, repaired.standing.phase, tagOf(repaired.standing)];
          },
        }),
      ),
    ).toEqual(conflicts.map(([, tag, phase]) => [tag, phase, tag]));
  });
});
