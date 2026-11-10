import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { runUiEffect, uiPromise } from "../shared/ui-effect";
import { Data, Effect, Function as EffectFunction, Schema } from "effect";
import {
  isApiError,
  refusalOf,
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

const QueueChangeRefusal = Schema.Literals([
  "queue_not_found",
  "queue_delivered",
  "queue_reserved",
  "queue_not_held",
  "session_in_use",
]);
/** Why the server did not take a change to a queued message. */
const queueChangeRefusals = {
  queue_not_found: msg`그 메시지는 이미 대기열에 없습니다.`,
  queue_delivered: msg`그 메시지는 이미 보냈습니다.`,
  queue_reserved: msg`그 메시지는 지금 보내는 중이라 바꿀 수 없습니다.`,
  queue_not_held: msg`그 메시지는 확인을 기다리지 않고 이미 보낼 차례를 기다립니다.`,
  session_in_use: msg`다른 창이 이 대화를 쓰고 있습니다.`,
} satisfies Record<typeof QueueChangeRefusal.Type, MessageDescriptor>;
const isQueueChangeRefusal = Schema.is(QueueChangeRefusal);

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

  /**
   * Changes a queued message. A refused or failed change shows as the queue the server still has,
   * and gives why it did not go through for the page to say.
   */
  const change = (id: string, edit: QueueEdit): Promise<MessageDescriptor | null> =>
    runUiEffect(
      uiPromise(() => editQueue.mutateAsync({ id, edit })).pipe(
        Effect.as(null),
        Effect.catchTag("UnknownError", (failure) => {
          const code = refusalOf(failure.cause)?.code;
          return Effect.succeed(
            isQueueChangeRefusal(code)
              ? queueChangeRefusals[code]
              : msg`대기열 메시지를 바꾸지 못했습니다. 다시 시도해 주십시오.`,
          );
        }),
        Effect.tap(() => uiPromise(() => refresh())),
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
