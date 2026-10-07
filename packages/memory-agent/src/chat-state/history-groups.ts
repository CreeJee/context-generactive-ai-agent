import {
  MutableHashMap,
  MutableHashSet,
  Option,
  Predicate,
  Function as EffectFunction,
} from "effect";
import { createHash } from "node:crypto";
import type { ModelMessage } from "@tanstack/ai";

export interface HistoryGroup {
  readonly id: string;
  readonly messages: ModelMessage[];
}

export type HistoryGroupingResult =
  | { readonly type: "ready"; readonly groups: HistoryGroup[] }
  | { readonly type: "id-collision"; readonly id: string };

export type HistoryMessagesResult =
  | { readonly type: "ready"; readonly messages: ModelMessage[] }
  | { readonly type: "id-collision"; readonly id: string };

/** Preserve released fallback cursors unless an explicit ID already reserves them. */
export const historyProjectionMessages: {
  (
    messages: readonly ModelMessage[],
    retainedCursorIds: readonly string[],
  ): (threadId: string) => ReturnType<typeof historyProjectionMessagesBody>;
} & typeof historyProjectionMessagesBody = EffectFunction.dual(
  (args) => Predicate.isString(args[0]),
  historyProjectionMessagesBody,
);
function historyProjectionMessagesBody(
  threadId: string,
  messages: readonly ModelMessage[],
  retainedCursorIds: readonly string[],
): HistoryMessagesResult {
  const reservedIds = MutableHashSet.fromIterable(
    messages.flatMap((message) => (message.id === undefined ? [] : [message.id])),
  );
  const retainedByOrdinal = MutableHashMap.empty<number, string>();
  const prefix = `stored:${threadId}:`;
  for (const id of retainedCursorIds) {
    if (!id.startsWith(prefix)) continue;
    const suffix = id.indexOf(":fallback:", prefix.length);
    const base = suffix === -1 ? id : id.slice(0, suffix);
    const ordinal = Number(base.slice(prefix.length));
    if (Number.isSafeInteger(ordinal) && ordinal >= 0 && base === `${prefix}${ordinal}`) {
      const previous = Option.getOrUndefined(MutableHashMap.get(retainedByOrdinal, ordinal));
      if (
        previous === undefined ||
        (MutableHashSet.has(reservedIds, previous) && !MutableHashSet.has(reservedIds, id))
      )
        MutableHashMap.set(retainedByOrdinal, ordinal, id);
    }
  }
  const normalized: ModelMessage[] = [];
  let hasAssistant = false;
  for (const [ordinal, message] of messages.entries()) {
    let ownsCursor = true;
    switch (message.role) {
      case "assistant":
        hasAssistant = true;
        break;
      case "user":
        hasAssistant = false;
        break;
      case "tool":
        ownsCursor = message.toolCallId === undefined || !hasAssistant;
        break;
    }
    if (message.id !== undefined) {
      normalized.push(message);
      continue;
    }
    const base = `stored:${threadId}:${ordinal}`;
    // Linked tool results belong to the assistant's cursor. A stored-looking
    // explicit cursor elsewhere must not reserve the tool result's source ordinal.
    const retained = ownsCursor
      ? Option.getOrUndefined(MutableHashMap.get(retainedByOrdinal, ordinal))
      : undefined;
    let id = retained ?? base;
    if (retained !== undefined && MutableHashSet.has(reservedIds, retained))
      return { type: "id-collision", id: retained };
    let suffix = 0;
    while (MutableHashSet.has(reservedIds, id)) {
      id = `${base}:fallback:${suffix++}`;
    }
    MutableHashSet.add(reservedIds, id);
    normalized.push({ ...message, id });
  }
  return { type: "ready", messages: normalized };
}

/**
 * Build storage units matching @tanstack/ai's modelMessagesToUIMessages.
 * Only used to build a derived projection, never to rewrite the model transcript.
 * A tool without toolCallId creates a standalone UI message without resetting
 * the SDK's current assistant; subsequent results/segments still join that assistant.
 */
export const groupHistoryMessages: {
  (
    messages: readonly ModelMessage[],
  ): (threadId: string) => ReturnType<typeof groupHistoryMessagesBody>;
} & typeof groupHistoryMessagesBody = EffectFunction.dual(2, groupHistoryMessagesBody);
function groupHistoryMessagesBody(
  threadId: string,
  messages: readonly ModelMessage[],
): HistoryGroupingResult {
  const reservedIds = MutableHashSet.fromIterable(
    messages.flatMap((message) =>
      message.id !== undefined && message.id.length > 0 ? [message.id] : [],
    ),
  );
  const namespace = createHash("sha256").update(threadId).digest("hex");
  const groups: HistoryGroup[] = [];
  let assistant: HistoryGroup | undefined;

  for (const [index, original] of messages.entries()) {
    let id = original.id;
    if (id === undefined || id.length === 0) {
      id = `history-legacy-${namespace}-${index}`;
      // Never re-key an earlier page because a newly appended explicit ID collides.
      // The storage caller must handle this tagged result, not publish ambiguous cursors.
      if (MutableHashSet.has(reservedIds, id)) return { type: "id-collision", id };
      MutableHashSet.add(reservedIds, id);
    }
    // Stable derived IDs allow the SDK to return retained UI IDs as cursors.
    // Reused assistant IDs become SDK segments only in this derived view.
    if (original.role === "assistant" && assistant !== undefined && id === assistant.id) {
      id = `${assistant.id}-segment-history-${index}`;
      if (MutableHashSet.has(reservedIds, id)) return { type: "id-collision", id };
      MutableHashSet.add(reservedIds, id);
    }
    const message = original.id === id ? original : { ...original, id };
    switch (message.role) {
      case "tool":
        if (message.toolCallId !== undefined && assistant !== undefined) {
          assistant.messages.push(message);
        } else {
          groups.push({ id, messages: [message] });
        }
        break;
      case "assistant":
        if (assistant !== undefined && id.startsWith(`${assistant.id}-segment-`)) {
          assistant.messages.push(message);
        } else {
          assistant = { id, messages: [message] };
          groups.push(assistant);
        }
        break;
      case "user":
        groups.push({ id, messages: [message] });
        assistant = undefined;
        break;
    }
  }
  const seen = MutableHashSet.empty<string>();
  for (const group of groups) {
    if (MutableHashSet.has(seen, group.id)) return { type: "id-collision", id: group.id };
    MutableHashSet.add(seen, group.id);
  }
  return { type: "ready", groups };
}
