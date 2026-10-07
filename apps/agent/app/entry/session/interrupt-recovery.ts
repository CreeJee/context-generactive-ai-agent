import { Function as EffectFunction } from "effect";
export const interruptContinuationError = "Interrupt continuation could not be started.";

/**
 * TanStack reports a continuation as not started when its child run pauses for another approval.
 * A new pending interrupt proves that continuation did start; only an empty batch is actually lost.
 */
export const interruptContinuationState: {
  (
    pendingInterrupts: number,
  ): (errorMessage: string | undefined) => ReturnType<typeof interruptContinuationStateBody>;
} & typeof interruptContinuationStateBody = EffectFunction.dual(2, interruptContinuationStateBody);
function interruptContinuationStateBody(
  errorMessage: string | undefined,
  pendingInterrupts: number,
): "none" | "continued" | "lost" {
  if (errorMessage !== interruptContinuationError) return "none";
  return pendingInterrupts > 0 ? "continued" : "lost";
}
