import { Array as EffectArray, Effect, Schema } from "effect";
import type { PlanStep } from "./workflow.ts";

/** A dependency defect the model can fix by revising the Plan's step ids or dependsOn. */
export const PlanDependencyIssue = Schema.Union([
  Schema.TaggedStruct("DuplicateStepId", { stepId: Schema.String }),
  Schema.TaggedStruct("UnknownDependency", { stepId: Schema.String, dependsOn: Schema.String }),
  Schema.TaggedStruct("SelfDependency", { stepId: Schema.String }),
  Schema.TaggedStruct("DependencyCycle", { cycle: Schema.Array(Schema.String) }),
]);
export type PlanDependencyIssue = typeof PlanDependencyIssue.Type;

export class PlanDependenciesRejected extends Schema.TaggedError<PlanDependenciesRejected>()(
  "PlanDependenciesRejected",
  { issues: Schema.NonEmptyArray(PlanDependencyIssue) },
) {}

type DependencyStep = Pick<PlanStep, "id" | "dependsOn">;

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
    if (seen.has(step.id)) issues.push({ _tag: "DuplicateStepId", stepId: step.id });
    seen.add(step.id);
  }
  for (const step of steps)
    for (const dependsOn of EffectArray.dedupe(step.dependsOn)) {
      if (dependsOn === step.id) issues.push({ _tag: "SelfDependency", stepId: step.id });
      else if (!seen.has(dependsOn))
        issues.push({ _tag: "UnknownDependency", stepId: step.id, dependsOn });
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
      if (index >= 0) issues.push({ _tag: "DependencyCycle", cycle: [...path.slice(index), next] });
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

export interface UnmetDependency {
  readonly id: string;
  readonly status: PlanStep["status"];
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
 * Ready steps are pending with every dependency completed. A Plan saved before validation may
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
      case "completed":
        break;
      case "in_progress":
        inProgress.push(step.id);
        break;
      case "blocked":
        blocked.push(step.id);
        break;
      case "pending": {
        const unmet = edges(step).flatMap((id): UnmetDependency[] => {
          const dependency = status.get(id) ?? "completed";
          return dependency === "completed" ? [] : [{ id, status: dependency }];
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
