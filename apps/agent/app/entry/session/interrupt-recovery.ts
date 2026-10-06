export const interruptContinuationError = "Interrupt continuation could not be started.";

/**
 * TanStack reports a continuation as not started when its child run pauses for another approval.
 * A new pending interrupt proves that continuation did start; only an empty batch is actually lost.
 */
// Fixed-arity application/SDK contract; these arguments are not a data-last collection API.
// @effect-diagnostics-next-line missingPipeableSignature:off
export function interruptContinuationState(
  errorMessage: string | undefined,
  pendingInterrupts: number,
): "none" | "continued" | "lost" {
  if (errorMessage !== interruptContinuationError) return "none";
  return pendingInterrupts > 0 ? "continued" : "lost";
}
