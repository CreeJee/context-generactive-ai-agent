import type { Measurement, Component } from "./contracts.ts";

export interface SelectionPolicy {
  delta: number;
  bestScore: number;
  beta0: number;
  beta1: number;
}
export type Selection = { kind: "accepted" } | { kind: "rejected"; reason: string };
export function selectCandidate(
  base: Measurement,
  candidate: Measurement,
  policy: SelectionPolicy,
): Selection {
  if (base.tokens === null || candidate.tokens === null)
    return { kind: "rejected", reason: "usage_unknown" };
  if (candidate.score < policy.bestScore - policy.delta)
    return { kind: "rejected", reason: "below_best_floor" };
  if (
    candidate.coding < base.coding - policy.delta ||
    candidate.memory < base.memory - policy.delta
  )
    return { kind: "rejected", reason: "domain_regression" };
  const gain = candidate.score - base.score;
  const cost = (candidate.tokens - base.tokens) / base.tokens;
  if (gain > policy.delta) {
    if (cost > policy.beta0 + policy.beta1 * gain)
      return { kind: "rejected", reason: "cost_growth" };
  } else if (cost >= 0) return { kind: "rejected", reason: "within_noise_without_savings" };
  return { kind: "accepted" };
}
export const editBudget = (round: number, rounds: number) =>
  Math.ceil(1 + ((3 - 1) * (1 + Math.cos((Math.PI * round) / Math.max(1, rounds - 1)))) / 2);
export function exploration(
  history: readonly {
    edits: readonly { component: Component }[];
    measurement: Measurement | null;
  }[],
) {
  const tried = new Set(
    history
      .filter((entry) => entry.measurement !== null)
      .flatMap((entry) => entry.edits.map((edit) => edit.component)),
  );
  return (["prompt", "client_tool", "context_mgmt", "memory", "config"] as const).filter(
    (component) => !tried.has(component),
  );
}
export function noiseBand(scores: readonly number[]) {
  if (scores.length < 3)
    throw new Error("Repeated baseline requires at least three suite measurements");
  return Math.max(...scores) - Math.min(...scores);
}
