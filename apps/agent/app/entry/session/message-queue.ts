import { ApiError, type QueuedMessage, type QueueEdit, type QueueSnapshot } from "../api";
import { useSessionEventScope } from "../events/context";
import { useQueueQuery } from "../queries/session";
import { useEditQueueMutation, useEnqueueMutation } from "../queries/mutations/session";

/** What became of a message written while a run was answering. */
export type AddOutcome =
  | { readonly kind: "queued" }
  | { readonly kind: "steered"; readonly message: QueuedMessage }
  /** Nothing is answering any more: send it as a normal turn. */
  | { readonly kind: "not-running" }
  /** Steering is not possible right now; nothing was sent and the draft stays. */
  | { readonly kind: "steer-unavailable" }
  | { readonly kind: "failed" };

/** Messages a page can still change: everything that has not reached the agent. */
export const isPending = (message: QueuedMessage) => message.state.kind !== "delivered";

/** Messages a run took in while it answered; the conversation shows them, not the queue. */
export const isTakenIn = (message: QueuedMessage) =>
  message.state.kind === "delivered" && message.state.via !== "next_turn";

/** The authoritative queue snapshot, refreshed by session SSE invalidations. */
export function useMessageQueue(sessionId: string, holder: string, _generating: boolean) {
  const { projectId } = useSessionEventScope();
  if (!projectId) throw new Error("Message queue requires an active project");
  const enqueue = useEnqueueMutation(projectId, sessionId, holder);
  const editQueue = useEditQueueMutation(projectId, sessionId, holder);
  const query = useQueueQuery(projectId, sessionId);
  const refresh = async () => {
    const result = await query.refetch();
    return result.data ?? null;
  };

  const add = async (
    text: string,
    attachmentIds: readonly string[],
    mode: "queue" | "steer",
  ): Promise<AddOutcome> => {
    try {
      const message = await enqueue.mutateAsync({ text, attachmentIds, mode });
      return mode === "steer" ? { kind: "steered", message } : { kind: "queued" };
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === "not_running")
        return { kind: "not-running" };
      if (failure instanceof ApiError && failure.code === "steer_unavailable")
        return { kind: "steer-unavailable" };
      return { kind: "failed" };
    }
  };

  const change = async (id: string, edit: QueueEdit) => {
    await editQueue.mutateAsync({ id, edit }).catch(() => null);
    return refresh();
  };

  return {
    items: query.data?.items ?? [],
    nextDelivery: query.data?.nextDelivery ?? { kind: "empty" as const },
    refresh,
    add,
    change,
  } satisfies {
    items: readonly QueuedMessage[];
    nextDelivery: QueueSnapshot["nextDelivery"];
    refresh: typeof refresh;
    add: typeof add;
    change: typeof change;
  };
}
