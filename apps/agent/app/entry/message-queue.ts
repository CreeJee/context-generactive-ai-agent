import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type QueuedMessage, type QueueEdit } from "./api";

/** While a run answers, the queue is checked this often to show messages being delivered. */
const pollMs = 1_500;

/** What became of a message written while a run was answering. */
export type AddOutcome =
  | { readonly kind: "queued" }
  | { readonly kind: "steered" }
  /** Nothing is answering any more: send it as a normal turn. */
  | { readonly kind: "not-running" }
  /** Steering is not possible right now; nothing was sent and the draft stays. */
  | { readonly kind: "steer-unavailable" }
  | { readonly kind: "failed" };

/** Messages a page can still change: everything that has not reached the agent. */
export const isPending = (message: QueuedMessage) => message.state.kind !== "delivered";

/**
 * The session's message queue as this page sees it (R03). Refreshed whenever the page's run starts
 * or stops, and polled while it answers.
 */
export function useMessageQueue(sessionId: string, holder: string, generating: boolean) {
  const [items, setItems] = useState<readonly QueuedMessage[]>([]);

  const refresh = useCallback(
    () =>
      api.queue(sessionId).then(
        (next) => {
          setItems(next);
          return next;
        },
        () => null,
      ),
    [sessionId],
  );

  useEffect(() => {
    void refresh();
    if (!generating) return;
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [refresh, generating]);

  const add = async (
    text: string,
    attachmentIds: readonly string[],
    mode: "queue" | "steer",
  ): Promise<AddOutcome> => {
    try {
      await api.enqueue(sessionId, holder, { text, attachmentIds, mode });
      void refresh();
      return mode === "steer" ? { kind: "steered" } : { kind: "queued" };
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

  return { items, refresh, add, change };
}
