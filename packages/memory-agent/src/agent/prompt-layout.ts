/**
 * Keep shared standing rules before role rules, then project/run context.
 * Never sort instructions: order can affect their meaning. Callers classify each block explicitly.
 */
// Fixed-arity application/SDK contract; these arguments are not a data-last collection API.
// @effect-diagnostics-next-line missingPipeableSignature:off
export function promptLayout(
  standing: readonly string[],
  context: readonly string[],
  role: readonly string[] = [],
): string[] {
  return [...standing, ...role, ...context];
}
