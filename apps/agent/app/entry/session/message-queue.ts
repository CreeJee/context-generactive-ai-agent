import { runUiEffect, uiPromise } from "../shared/ui-effect";
import { Data, Effect, Function as EffectFunction } from "effect";
import {
  isApiError,
  NextDelivery,
  type QueuedMessage,
  type QueueEdit,
  QueueItemState,
  type QueueSnapshot,
} from "../api";
import { useProjectScope } from "../events/context";
import { useQueueQuery } from "../queries/session";
import { useEditQueueMutation, useEnqueueMutation } from "../queries/mutations/session";

/** What became of a message written while a run was answering. */
export type AddOutcome = Data.TaggedEnum<{
  queued: {};
  /** Nothing is answering any more: send it as a normal turn. */
  "not-running": {};
  failed: {};
}>;
export const AddOutcome = Data.taggedEnum<AddOutcome>();

/** Messages a page can still change: everything that has not reached the agent. */
export const isPending = (message: QueuedMessage) =>
  !QueueItemState.$is("delivered")(message.state);

/** Messages a run took in while it answered; the conversation shows them, not the queue. */
export const isTakenIn = (message: QueuedMessage) =>
  QueueItemState.$is("delivered")(message.state) && message.state.via !== "next_turn";

/** The authoritative queue snapshot, refreshed by session SSE invalidations. */
export const useMessageQueue: {
  (
    holder: string,
    _generating: boolean,
  ): (sessionId: string) => ReturnType<typeof useMessageQueueBody>;
} & typeof useMessageQueueBody = EffectFunction.dual(3, useMessageQueueBody);
function useMessageQueueBody(sessionId: string, holder: string, _generating: boolean) {
  const projectId = useProjectScope("message_queue");
  const enqueue = useEnqueueMutation(projectId, sessionId, holder);
  const editQueue = useEditQueueMutation(projectId, sessionId, holder);
  const query = useQueueQuery(projectId, sessionId);
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const refresh = () =>
    runUiEffect(uiPromise(() => query.refetch()).pipe(Effect.map((result) => result.data ?? null)));

  const add = (
    text: string,
    attachmentIds: readonly string[],
    mode: "queue" | "steer",
  ): Promise<AddOutcome> =>
    runUiEffect(
      uiPromise(() => enqueue.mutateAsync({ text, attachmentIds, mode })).pipe(
        Effect.as<AddOutcome>(AddOutcome.queued()),
        Effect.catchTag("UnknownError", (failure) =>
          Effect.succeed<AddOutcome>(
            isApiError(failure.cause) && failure.cause.code === "not_running"
              ? AddOutcome["not-running"]()
              : AddOutcome.failed(),
          ),
        ),
      ),
    );

  const change = (id: string, edit: QueueEdit) =>
    runUiEffect(
      uiPromise(() => editQueue.mutateAsync({ id, edit })).pipe(
        // A refused or failed edit shows as the queue the server still has.
        Effect.catchTag("UnknownError", () => Effect.succeed(null)),
        Effect.andThen(uiPromise(() => refresh())),
      ),
    );

  return {
    items: query.data?.items ?? [],
    nextDelivery: query.data?.nextDelivery ?? NextDelivery.empty(),
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
