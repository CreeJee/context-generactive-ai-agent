import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type QueuedMessage, type QueueEdit } from "./api";
import { useSessionEventScope } from "./events/providers";
import { appQueryKeys } from "./events/query-keys";

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
  const queryClient = useQueryClient();
  const queryKey = appQueryKeys.session.queue(projectId, sessionId);
  const query = useQuery({ queryKey, queryFn: () => api.queue(sessionId) });
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
      const message = await api.enqueue(sessionId, holder, { text, attachmentIds, mode });
      await queryClient.invalidateQueries({ queryKey });
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
    await api.editQueued(sessionId, holder, id, edit).catch(() => null);
    return refresh();
  };

  return { items: query.data ?? [], refresh, add, change };
}
