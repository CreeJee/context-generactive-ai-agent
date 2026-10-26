import {
  Array as EffectArray,
  Data,
  Iterable as EffectIterable,
  Match,
  MutableHashMap,
  MutableHashSet,
  Option,
  Predicate,
  Result,
  Function as EffectFunction,
} from "effect";
import { sha256 } from "../runtime/synchronous-crypto.ts";
import type { ModelMessage } from "@tanstack/ai";

export interface HistoryGroup {
  readonly id: string;
  readonly messages: ModelMessage[];
}

export type HistoryGroupingResult = Data.TaggedEnum<{
  ready: { readonly groups: HistoryGroup[] };
  "id-collision": { readonly id: string };
}>;
export const HistoryGroupingResult = Data.taggedEnum<HistoryGroupingResult>();

export type HistoryMessagesResult = Data.TaggedEnum<{
  ready: { readonly messages: ModelMessage[] };
  "id-collision": { readonly id: string };
}>;
export const HistoryMessagesResult = Data.taggedEnum<HistoryMessagesResult>();

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
  const prefix = `stored:${threadId}:`;
  /** The source ordinal a released cursor, or one of its fallbacks, was made for. */
  const ordinalOf = (id: string) =>
    Option.flatMap(
      Option.liftPredicate(id, (cursor) => cursor.startsWith(prefix)),
      (cursor) => {
        const suffix = cursor.indexOf(":fallback:", prefix.length);
        const base = suffix === -1 ? cursor : cursor.slice(0, suffix);
        return Option.liftPredicate(
          Number(base.slice(prefix.length)),
          (ordinal) =>
            Number.isSafeInteger(ordinal) && ordinal >= 0 && base === `${prefix}${ordinal}`,
        );
      },
    );
  const cursors = retainedCursorIds.flatMap((id) =>
    Option.toArray(Option.map(ordinalOf(id), (ordinal) => ({ ordinal, id }))),
  );
  // Per ordinal, the first released cursor no explicit ID reserves, else the first one.
  const retainedByOrdinal = MutableHashMap.fromIterable(
    Object.values(EffectArray.groupBy(cursors, ({ ordinal }) => String(ordinal))).map(
      (candidates) =>
        [
          candidates[0].ordinal,
          Option.getOrElse(
            EffectArray.findFirst(candidates, ({ id }) => !MutableHashSet.has(reservedIds, id)),
            () => candidates[0],
          ).id,
        ] as const,
    ),
  );
  // Before each message: whether an assistant answered after the last user message.
  const answering = EffectArray.scan(
    messages,
    false,
    (hasAssistant, message) =>
      message.role === "assistant" || (message.role !== "user" && hasAssistant),
  );
  /** The first ID from `base` on that nothing holds yet. */
  const freeFrom = (base: string) =>
    Option.getOrThrow(
      EffectIterable.findFirst(
        EffectIterable.makeBy((suffix) => (suffix === 0 ? base : `${base}:fallback:${suffix - 1}`)),
        (id) => !MutableHashSet.has(reservedIds, id),
      ),
    );
  /** The ID a message without one shows as; fails with a retained cursor an explicit ID holds. */
  const idOf = (message: ModelMessage, ordinal: number) => {
    // Linked tool results belong to the assistant's cursor. A stored-looking
    // explicit cursor elsewhere must not reserve the tool result's source ordinal.
    const linkedTool =
      message.role === "tool" && message.toolCallId !== undefined && answering[ordinal] === true;
    return Option.match(
      Option.filter(MutableHashMap.get(retainedByOrdinal, ordinal), () => !linkedTool),
      {
        onNone: () => Result.succeed(freeFrom(`stored:${threadId}:${ordinal}`)),
        onSome: (retained) =>
          Result.liftPredicate(
            retained,
            (id) => !MutableHashSet.has(reservedIds, id),
            EffectFunction.identity,
          ),
      },
    );
  };
  // Each ID is reserved as it is given, so later fallbacks step past it. Only the first
  // collision is reported; what comes after it is never published.
  const normalized = messages.map((message, ordinal): Result.Result<ModelMessage, string> =>
    message.id === undefined
      ? Result.map(idOf(message, ordinal), (id) => {
          MutableHashSet.add(reservedIds, id);
          return { ...message, id };
        })
      : Result.succeed(message),
  );
  return Result.match(Result.all(normalized), {
    onFailure: (id) => HistoryMessagesResult["id-collision"]({ id }),
    onSuccess: (ready) => HistoryMessagesResult.ready({ messages: ready }),
  });
}

interface Grouping {
  readonly groups: HistoryGroup[];
  /** The group later assistant segments and linked tool results join, until a user message. */
  readonly assistant: Option.Option<HistoryGroup>;
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
  const namespace = sha256(threadId);
  // Never re-key an earlier page because a newly appended explicit ID collides.
  // The storage caller must handle this tagged result, not publish ambiguous cursors.
  const reserve = (id: string) =>
    Result.map(
      Result.liftPredicate(
        id,
        (free) => !MutableHashSet.has(reservedIds, free),
        EffectFunction.identity,
      ),
      (free) => {
        MutableHashSet.add(reservedIds, free);
        return free;
      },
    );
  /** Adds `message` to its group: the assistant's, or a new one. */
  const place = (state: Grouping, message: ModelMessage, id: string) => {
    const joined = (group: HistoryGroup) => {
      group.messages.push(message);
      return state;
    };
    /** Starts a group with `message`; `assistant` picks the group later messages join. */
    const started = (assistant: (group: HistoryGroup) => Option.Option<HistoryGroup>) => {
      const group = { id, messages: [message] };
      state.groups.push(group);
      return { groups: state.groups, assistant: assistant(group) };
    };
    return Match.value(message.role).pipe(
      Match.withReturnType<Grouping>(),
      Match.when("tool", () =>
        Option.match(
          Option.filter(state.assistant, () => message.toolCallId !== undefined),
          { onSome: joined, onNone: () => started(EffectFunction.constant(state.assistant)) },
        ),
      ),
      Match.when("assistant", () =>
        Option.match(
          Option.filter(state.assistant, (answer) => id.startsWith(`${answer.id}-segment-`)),
          { onSome: joined, onNone: () => started(Option.some) },
        ),
      ),
      Match.when("user", () => started(Option.none)),
      Match.orElse(() => state),
    );
  };
  const step = (state: Grouping, original: ModelMessage, index: number) =>
    Result.gen(function* () {
      const own = yield* Option.match(
        Option.liftPredicate(original.id ?? "", (id) => id.length > 0),
        {
          onSome: (id) => Result.succeed(id),
          onNone: () => reserve(`history-legacy-${namespace}-${index}`),
        },
      );
      // Stable derived IDs allow the SDK to return retained UI IDs as cursors.
      // Reused assistant IDs become SDK segments only in this derived view.
      const id =
        original.role === "assistant" &&
        Option.exists(state.assistant, (answer) => answer.id === own)
          ? yield* reserve(`${own}-segment-history-${index}`)
          : own;
      return place(state, original.id === id ? original : { ...original, id }, id);
    });
  const grouped = messages.reduce<Result.Result<Grouping, string>>(
    (result, original, index) => Result.flatMap(result, (state) => step(state, original, index)),
    Result.succeed({ groups: [], assistant: Option.none() }),
  );
  return Result.match(grouped, {
    onFailure: (id) => HistoryGroupingResult["id-collision"]({ id }),
    onSuccess: ({ groups }) => {
      // Later keys win, so reversing keeps the first group that uses each ID.
      const firstUse = MutableHashMap.fromIterable(
        groups.map((group, index) => [group.id, index] as const).toReversed(),
      );
      return Option.match(
        EffectArray.findFirst(
          groups,
          (group, index) => !Option.contains(MutableHashMap.get(firstUse, group.id), index),
        ),
        {
          onSome: (repeated) => HistoryGroupingResult["id-collision"]({ id: repeated.id }),
          onNone: () => HistoryGroupingResult.ready({ groups }),
        },
      );
    },
  });
}
