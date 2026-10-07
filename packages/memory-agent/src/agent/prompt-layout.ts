import { Function as EffectFunction } from "effect";

/**
 * Keep shared standing rules before role rules, then project/run context.
 * Never sort instructions: order can affect their meaning. Callers classify each block explicitly.
 */
function promptLayoutBody(
  standing: readonly string[],
  context: readonly string[],
  role: readonly string[],
): string[] {
  return [...standing, ...role, ...context];
}

export const promptLayout: {
  (standing: readonly string[], context: readonly string[], role: readonly string[]): string[];
  (context: readonly string[], role: readonly string[]): (standing: readonly string[]) => string[];
} = EffectFunction.dual(3, promptLayoutBody);
