import { Array as EffectArray, Data, Effect, Function as EffectFunction, Schema } from "effect";
import { stepProgressStatus, type CardStatus, type StepProgressStatus } from "./card.ts";
import type { PlanStep } from "./workflow.ts";

/** A dependency defect the model can fix by revising the Plan's step ids or dependsOn. */
export const PlanDependencyIssue = Schema.TaggedUnion({
  DuplicateStepId: { stepId: Schema.String },
  UnknownDependency: { stepId: Schema.String, dependsOn: Schema.String },
  SelfDependency: { stepId: Schema.String },
  DependencyCycle: { cycle: Schema.Array(Schema.String) },
});
export type PlanDependencyIssue = typeof PlanDependencyIssue.Type;

export class PlanDependenciesRejected extends Schema.TaggedError<PlanDependenciesRejected>()(
  "PlanDependenciesRejected",
  { issues: Schema.NonEmptyArray(PlanDependencyIssue) },
) {}

type DependencyStep = Pick<PlanStep, "id" | "dependsOn"> & Partial<Pick<PlanStep, "hold">>;

/** Edges to other existing steps; unknown and self references carry no ordering. */
const knownDependencies = (steps: readonly DependencyStep[]) => {
  const ids = new Set(steps.map((step) => step.id));
  return (step: DependencyStep) =>
    EffectArray.dedupe(step.dependsOn.filter((id) => id !== step.id && ids.has(id)));
};

export function planDependencyIssues(
  steps: readonly DependencyStep[],
): ReadonlyArray<PlanDependencyIssue> {
  const ids = new Set(steps.map((step) => step.id));
  // Every repeat of an id after its first step is one duplicate.
  const duplicates = steps.flatMap((step, index): PlanDependencyIssue[] =>
    steps.findIndex((other) => other.id === step.id) < index
      ? [PlanDependencyIssue.cases.DuplicateStepId.make({ stepId: step.id })]
      : [],
  );
  const references = steps.flatMap((step) =>
    EffectArray.dedupe(step.dependsOn).flatMap((dependsOn): PlanDependencyIssue[] =>
      dependsOn === step.id
        ? [PlanDependencyIssue.cases.SelfDependency.make({ stepId: step.id })]
        : ids.has(dependsOn)
          ? []
          : [PlanDependencyIssue.cases.UnknownDependency.make({ stepId: step.id, dependsOn })],
    ),
  );

  const edges = knownDependencies(steps);
  const dependencies = new Map(steps.map((step) => [step.id, edges(step)]));
  // Depth-first search; every back edge closes one reported cycle.
  const cycles: PlanDependencyIssue[] = [];
  const finished = new Set<string>();
  const path: string[] = [];
  const visit = (id: string) => {
    path.push(id);
    for (const next of dependencies.get(id) ?? []) {
      const index = path.indexOf(next);
      if (index >= 0)
        cycles.push(
          PlanDependencyIssue.cases.DependencyCycle.make({ cycle: [...path.slice(index), next] }),
        );
      else if (!finished.has(next)) visit(next);
    }
    path.pop();
    finished.add(id);
  };
  for (const id of dependencies.keys()) if (!finished.has(id)) visit(id);
  return [...duplicates, ...references, ...cycles];
}

/** Plan saves reject dependency defects; persisted Plans are only read through planSchedule. */
export const validatePlanDependencies = Effect.fnUntraced(function* (
  steps: readonly DependencyStep[],
): Effect.fn.Return<void, PlanDependenciesRejected> {
  const issues = planDependencyIssues(steps);
  if (EffectArray.isReadonlyArrayNonEmpty(issues))
    return yield* PlanDependenciesRejected.make({ issues });
});

/** Status of a card not started yet: ready once every known dependency is done, unless held. */
export const notStartedStatus: {
  (
    isDone: (id: string) => boolean,
  ): (steps: readonly DependencyStep[]) => ReturnType<typeof notStartedStatusBody>;
} & typeof notStartedStatusBody = EffectFunction.dual(2, notStartedStatusBody);
function notStartedStatusBody(
  steps: readonly DependencyStep[],
  isDone: (id: string) => boolean,
): (step: DependencyStep) => "ready" | "backlog" {
  const edges = knownDependencies(steps);
  return (step) => (step.hold === undefined && edges(step).every(isDone) ? "ready" : "backlog");
}

export interface UnmetDependency {
  readonly id: string;
  /** In the model-facing progress vocabulary, which plan texts keep. */
  readonly status: StepProgressStatus;
}

export interface WaitingStep {
  readonly stepId: string;
  readonly unmet: EffectArray.NonEmptyReadonlyArray<UnmetDependency>;
}

/** Where a card sits in Goal execution's schedule. */
const scheduleStage = {
  done: "done",
  in_progress: "inProgress",
  verify: "inProgress",
  blocked: "blocked",
  human_decision: "blocked",
  backlog: "notStarted",
  ready: "notStarted",
} as const satisfies Record<CardStatus, string>;

export type PlanSchedule = Data.TaggedEnum<{
  finished: {};
  runnable: {
    readonly ready: ReadonlyArray<string>;
    readonly inProgress: ReadonlyArray<string>;
    readonly waiting: ReadonlyArray<WaitingStep>;
  };
  stalled: {
    readonly blocked: ReadonlyArray<string>;
    readonly waiting: ReadonlyArray<WaitingStep>;
  };
}>;
export const PlanSchedule = Data.taggedEnum<PlanSchedule>();

/**
 * Ready steps have not started and every dependency is done; backlog and ready cards are both
 * not started, so Goal execution schedules them alike. A Plan saved before validation may
 * still name unknown or self dependencies; those are ignored, while a saved cycle never becomes
 * ready and therefore surfaces as a stall the model can repair with update_plan.
 */
export function planSchedule(steps: readonly PlanStep[]): PlanSchedule {
  const status = new Map(steps.map((step) => [step.id, step.status]));
  const edges = knownDependencies(steps);
  const inStage = (stage: (typeof scheduleStage)[CardStatus]) =>
    steps.filter((step) => scheduleStage[step.status] === stage);
  const inProgress = inStage("inProgress").map((step) => step.id);
  const blocked = inStage("blocked").map((step) => step.id);
  const notStarted = inStage("notStarted").map((step) => ({
    stepId: step.id,
    unmet: edges(step).flatMap((id): UnmetDependency[] => {
      const dependency = status.get(id) ?? "done";
      return dependency === "done" ? [] : [{ id, status: stepProgressStatus(dependency) }];
    }),
  }));
  const ready = notStarted.filter(({ unmet }) => unmet.length === 0).map(({ stepId }) => stepId);
  const waiting = notStarted.flatMap(({ stepId, unmet }): WaitingStep[] =>
    EffectArray.isReadonlyArrayNonEmpty(unmet) ? [{ stepId, unmet }] : [],
  );
  return ready.length > 0 || inProgress.length > 0
    ? PlanSchedule.runnable({ ready, inProgress, waiting })
    : blocked.length === 0 && waiting.length === 0
      ? PlanSchedule.finished()
      : PlanSchedule.stalled({ blocked, waiting });
}

export const unmetDependencyText = (step: WaitingStep) =>
  `${step.stepId} waits on ${step.unmet.map((dependency) => `${dependency.id} [${dependency.status}]`).join(", ")}`;

/** Deterministic chain of why no remaining step can start. */
export const stalledEvidence = (
  schedule: Data.TaggedEnum.Value<PlanSchedule, "stalled">,
): EffectArray.NonEmptyReadonlyArray<string> => {
  const lines = [
    ...schedule.blocked.map((id) => `${id} [blocked]`),
    ...schedule.waiting.map(unmetDependencyText),
  ];
  // A stalled schedule always has at least one blocked or waiting step.
  return EffectArray.isReadonlyArrayNonEmpty(lines) ? lines : ["no startable step"];
};
