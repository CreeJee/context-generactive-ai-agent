/**
 * Keep shared standing rules before role rules, then project/run context.
 * Never sort instructions: order can affect their meaning. Callers classify each block explicitly.
 */
export function promptLayout(
  standing: readonly string[],
  context: readonly string[],
  role: readonly string[] = [],
): string[] {
  return [...standing, ...role, ...context];
}
