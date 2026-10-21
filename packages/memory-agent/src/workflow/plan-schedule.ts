import { Array as EffectArray, Effect, Schema } from "effect";
import { stepProgressStatus, type StepProgressStatus } from "./card.ts";
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
  const issues: PlanDependencyIssue[] = [];
  const seen = new Set<string>();
  for (const step of steps) {
    if (seen.has(step.id))
      issues.push(PlanDependencyIssue.cases.DuplicateStepId.make({ stepId: step.id }));
    seen.add(step.id);
  }
  for (const step of steps)
    for (const dependsOn of EffectArray.dedupe(step.dependsOn)) {
      if (dependsOn === step.id)
        issues.push(PlanDependencyIssue.cases.SelfDependency.make({ stepId: step.id }));
      else if (!seen.has(dependsOn))
        issues.push(
          PlanDependencyIssue.cases.UnknownDependency.make({ stepId: step.id, dependsOn }),
        );
    }

  const edges = knownDependencies(steps);
  const dependencies = new Map(steps.map((step) => [step.id, edges(step)]));
  // Depth-first search; every back edge closes one reported cycle.
  const finished = new Set<string>();
  const path: string[] = [];
  const visit = (id: string) => {
    path.push(id);
    for (const next of dependencies.get(id) ?? []) {
      const index = path.indexOf(next);
      if (index >= 0)
        issues.push(
          PlanDependencyIssue.cases.DependencyCycle.make({ cycle: [...path.slice(index), next] }),
        );
      else if (!finished.has(next)) visit(next);
    }
    path.pop();
    finished.add(id);
  };
  for (const id of dependencies.keys()) if (!finished.has(id)) visit(id);
  return issues;
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
export const notStartedStatus = (
  steps: readonly DependencyStep[],
  isDone: (id: string) => boolean,
): ((step: DependencyStep) => "ready" | "backlog") => {
  const edges = knownDependencies(steps);
  return (step) => (step.hold === undefined && edges(step).every(isDone) ? "ready" : "backlog");
};

export interface UnmetDependency {
  readonly id: string;
  /** In the model-facing progress vocabulary, which plan texts keep. */
  readonly status: StepProgressStatus;
}

export interface WaitingStep {
  readonly stepId: string;
  readonly unmet: EffectArray.NonEmptyReadonlyArray<UnmetDependency>;
}

export type PlanSchedule =
  | { readonly kind: "finished" }
  | {
      readonly kind: "runnable";
      readonly ready: ReadonlyArray<string>;
      readonly inProgress: ReadonlyArray<string>;
      readonly waiting: ReadonlyArray<WaitingStep>;
    }
  | {
      readonly kind: "stalled";
      readonly blocked: ReadonlyArray<string>;
      readonly waiting: ReadonlyArray<WaitingStep>;
    };

/**
 * Ready steps have not started and every dependency is done; backlog and ready cards are both
 * not started, so Goal execution schedules them alike. A Plan saved before validation may
 * still name unknown or self dependencies; those are ignored, while a saved cycle never becomes
 * ready and therefore surfaces as a stall the model can repair with update_plan.
 */
export function planSchedule(steps: readonly PlanStep[]): PlanSchedule {
  const status = new Map(steps.map((step) => [step.id, step.status]));
  const edges = knownDependencies(steps);
  const ready: string[] = [];
  const inProgress: string[] = [];
  const blocked: string[] = [];
  const waiting: WaitingStep[] = [];
  for (const step of steps)
    switch (step.status) {
      case "done":
        break;
      case "in_progress":
      case "verify":
        inProgress.push(step.id);
        break;
      case "blocked":
      case "human_decision":
        blocked.push(step.id);
        break;
      case "backlog":
      case "ready": {
        const unmet = edges(step).flatMap((id): UnmetDependency[] => {
          const dependency = status.get(id) ?? "done";
          return dependency === "done" ? [] : [{ id, status: stepProgressStatus(dependency) }];
        });
        if (EffectArray.isReadonlyArrayNonEmpty(unmet)) waiting.push({ stepId: step.id, unmet });
        else ready.push(step.id);
      }
    }
  if (ready.length > 0 || inProgress.length > 0)
    return { kind: "runnable", ready, inProgress, waiting };
  return blocked.length === 0 && waiting.length === 0
    ? { kind: "finished" }
    : { kind: "stalled", blocked, waiting };
}

export const unmetDependencyText = (step: WaitingStep) =>
  `${step.stepId} waits on ${step.unmet.map((dependency) => `${dependency.id} [${dependency.status}]`).join(", ")}`;

/** Deterministic chain of why no remaining step can start. */
export const stalledEvidence = (
  schedule: Extract<PlanSchedule, { kind: "stalled" }>,
): EffectArray.NonEmptyReadonlyArray<string> => {
  const lines = [
    ...schedule.blocked.map((id) => `${id} [blocked]`),
    ...schedule.waiting.map(unmetDependencyText),
  ];
  // A stalled schedule always has at least one blocked or waiting step.
  return EffectArray.isReadonlyArrayNonEmpty(lines) ? lines : ["no startable step"];
};
