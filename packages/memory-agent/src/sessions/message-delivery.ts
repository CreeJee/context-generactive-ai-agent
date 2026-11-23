import { Schema } from "effect";

/**
 * When a message is handed to a conversation, whoever wrote it: `interrupt` cuts into the run in
 * progress, `wake` starts a run when the conversation is idle, `next_run` waits for a run that
 * starts anyway. The orchestrator's notifications carry one; the user's own waiting messages mean
 * the same by their mode (decisions.md "앱이 모델에게 전할 알림은 orchestrator notifications에 둔다").
 */
export const MessageDelivery = Schema.Literals(["interrupt", "wake", "next_run"]);
export type MessageDelivery = typeof MessageDelivery.Type;
