import {
  Array as Arr,
  Function as EffectFunction,
  HashMap,
  HashSet,
  Match,
  Option,
  Predicate,
  Schema,
} from "effect";
import type { Prompt } from "effect/ai";
import type { MessageSource, StoredMessage } from "../chat-store/schema.ts";
import { JsonValue } from "../json.ts";
import { optionalProperty } from "../optional-property.ts";
import { fromPrompt, toPrompt } from "./prompt.ts";

/**
 * The history a provider request carries, built from stored messages the way TanStack 1.0 built it
 * (`transformMessagesForReplay`, then `sanitizeProviderRequest`). A conversation continued after
 * the switch must send the requests it sent before (docs/effect-ai-migration.md step 2).
 */

type AssistantMessage = Extract<StoredMessage, { readonly role: "assistant" }>;
type ToolMessage = Extract<StoredMessage, { readonly role: "tool" }>;
type ToolCall = NonNullable<AssistantMessage["toolCalls"]>[number];

/** The model a request goes to, and how it renames another model's tool call ids. */
export interface ReplayTarget {
  readonly source: Required<typeof MessageSource.Type>;
  /** A new id for another model's call; `attempt` counts the ids already taken. */
  readonly toolCallId: (id: string, attempt: number) => string;
}

const noResult = "No result provided";
const decodeJson = Schema.decodeOption(Schema.fromJsonString(JsonValue));
const decodeJsonString = Schema.decodeOption(Schema.fromJsonString(Schema.String));
const encodeJsonString = Schema.encodeOption(Schema.fromJsonString(Schema.String));

const isFailed = (message: StoredMessage) =>
  message.role === "assistant" && message.stopReason !== undefined;

const isForeign = (message: AssistantMessage, target: ReplayTarget | undefined) =>
  target !== undefined &&
  message.source !== undefined &&
  (message.source.provider !== target.source.provider ||
    message.source.api !== target.source.api ||
    message.source.model !== target.source.model);

/** Arguments the output limit cut, which do not parse. */
const isCut = (call: ToolCall) =>
  Option.isNone(decodeJson(call.function.arguments === "" ? "{}" : call.function.arguments));

/**
 * Another model's turn as this model can read it: thinking becomes text, signatures are dropped,
 * and the calls get ids this provider accepts.
 */
const asForeign = (
  message: AssistantMessage,
  toolCalls: ReadonlyArray<ToolCall>,
): AssistantMessage => {
  const content = [
    ...(message.thinking ?? [])
      .filter((thinking) => thinking.redacted !== true && thinking.content.trim() !== "")
      .map((thinking) => thinking.content),
    message.content ?? "",
  ].join("");
  const { thinking: _thinking, ...rest } = message;
  return {
    ...rest,
    content: content === "" ? null : content,
    ...optionalProperty(
      "toolCalls",
      Option.getOrUndefined(Option.as(Option.fromNullishOr(message.toolCalls), [...toolCalls])),
    ),
  };
};

/** What replaying has seen so far. */
interface Replay {
  /** Ids the calls this request sends already take. */
  readonly used: HashSet.HashSet<string>;
  /** The id each call is sent under. */
  readonly renamed: HashMap.HashMap<string, string>;
  /** Whether the turn that made each call failed. */
  readonly failedCalls: HashMap.HashMap<string, boolean>;
  /** The open turn's calls, the ids answered since it opened, and its message id. */
  readonly pending: ReadonlyArray<ToolCall>;
  readonly answered: HashSet.HashSet<string>;
  readonly turnId: Option.Option<string>;
}

/** The state after one message, and the messages it adds to the request. */
type Replayed = readonly [Replay, ReadonlyArray<StoredMessage>];

/** Closes the open turn: a call it left without a result is answered with {@link noResult}. */
const closed = (state: Replay): Replayed => [
  { ...state, pending: [], answered: HashSet.empty(), turnId: Option.none() },
  state.pending
    .filter((call) => !HashSet.has(state.answered, call.id))
    .map((call) => ({ role: "tool", toolCallId: call.id, content: noResult, error: noResult })),
];

/** The first id `rule` gives for `id` that no call takes yet. */
const freeId = (rule: ReplayTarget["toolCallId"], id: string, used: HashSet.HashSet<string>) =>
  Arr.findFirst(Arr.range(0, 999), (attempt) =>
    Option.liftPredicate(rule(id, attempt), (candidate) => !HashSet.has(used, candidate)),
  ).pipe(
    // The same limit as TanStack: a rule that never yields a free id is a bug in the rule.
    Option.getOrThrowWith(() => new Error(`Tool ID rule could not allocate a unique ID for ${id}`)),
  );

/** A tool result, sent under its call's id unless its call's turn failed. */
const answer = (state: Replay, message: ToolMessage): Replayed => {
  const id = Option.getOrElse(
    HashMap.get(state.renamed, message.toolCallId),
    () => message.toolCallId,
  );
  return Option.exists(HashMap.get(state.failedCalls, message.toolCallId), (failed) => failed)
    ? [state, []]
    : [
        { ...state, answered: HashSet.add(state.answered, id) },
        [id === message.toolCallId ? message : { ...message, toolCallId: id }],
      ];
};

/** An assistant turn that did not fail, as `target` reads it. */
const sent = (
  state: Replay,
  message: AssistantMessage,
  target: ReplayTarget | undefined,
): Replayed => {
  const calls = message.toolCalls ?? [];
  const [renamed, replayed] = Option.match(
    Option.filter(Option.fromNullishOr(target), (to) => isForeign(message, to)),
    {
      onSome: (to): readonly [Replay, AssistantMessage] => {
        const [ids, toolCalls] = Arr.mapAccum(
          calls,
          { used: state.used, renamed: state.renamed },
          (taken, call) => {
            const id = freeId(to.toolCallId, call.id, taken.used);
            return [
              {
                used: HashSet.add(taken.used, id),
                renamed: HashMap.set(taken.renamed, call.id, id),
              },
              id === call.id ? call : { ...call, id },
            ] as const;
          },
        );
        return [{ ...state, ...ids }, asForeign(message, toolCalls)];
      },
      onNone: (): readonly [Replay, AssistantMessage] => [
        {
          ...state,
          renamed: Arr.reduce(calls, state.renamed, (known, call) =>
            HashMap.set(known, call.id, call.id),
          ),
        },
        message,
      ],
    },
  );
  const replayedCalls = replayed.toolCalls ?? [];
  const turn =
    message.finishReason === "length" && replayedCalls.some(isCut)
      ? {
          ...replayed,
          toolCalls: replayedCalls.map((call) =>
            isCut(call) ? { ...call, function: { ...call.function, arguments: "{}" } } : call,
          ),
        }
      : replayed;
  return [
    {
      ...renamed,
      pending: [...renamed.pending, ...(turn.toolCalls ?? [])],
      turnId: Option.orElse(renamed.turnId, () => Option.fromNullishOr(message.id)),
    },
    [turn],
  ];
};

/**
 * Leaves out failed and cancelled turns with their tool results, answers calls left without a
 * result, empties arguments the output limit cut, and, for a `target`, rewrites other models'
 * turns. Without a target only the first three apply, as for the subscription providers.
 */
const replayHistory = (
  history: ReadonlyArray<StoredMessage>,
  target: ReplayTarget | undefined,
): Array<StoredMessage> => {
  const start: Replay = {
    used: HashSet.fromIterable(
      history
        .filter((message): message is AssistantMessage => message.role === "assistant")
        .filter((message) => !isForeign(message, target) && !isFailed(message))
        .flatMap((message) => (message.toolCalls ?? []).map((call) => call.id)),
    ),
    renamed: HashMap.empty(),
    failedCalls: HashMap.empty(),
    pending: [],
    answered: HashSet.empty(),
    turnId: Option.none(),
  };
  const [last, added] = Arr.mapAccum(history, start, (state, message): Replayed => {
    // A turn split into segments keeps its calls open until a result answers one of them.
    const nextSegment =
      message.role === "assistant" &&
      HashSet.size(state.answered) === 0 &&
      Option.exists(
        state.turnId,
        (turnId) =>
          message.id !== undefined &&
          (message.id === turnId || message.id.startsWith(`${turnId}-segment-`)),
      );
    const [open, unanswered] =
      message.role !== "tool" && !nextSegment ? closed(state) : ([state, []] as const);
    const [after, own] = Match.value(message).pipe(
      Match.discriminatorsExhaustive("role")({
        user: (user): Replayed => [open, [user]],
        tool: (tool) => answer(open, tool),
        assistant: (assistant): Replayed => {
          const recorded = {
            ...open,
            failedCalls: Arr.reduce(assistant.toolCalls ?? [], open.failedCalls, (known, call) =>
              HashMap.set(known, call.id, isFailed(assistant)),
            ),
          };
          return isFailed(assistant) ? [recorded, []] : sent(recorded, assistant, target);
        },
      }),
    );
    return [after, [...unanswered, ...own]];
  });
  return [...added.flat(), ...closed(last)[1]];
};

/** Removes lone UTF-16 surrogates, which are invalid on the wire; valid pairs stay. */
export const sanitizeText = (text: string) =>
  text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");

/** Cleans the strings inside the arguments; arguments that change nothing keep their bytes. */
const sanitizeArguments = (text: string) =>
  Option.isNone(decodeJson(text))
    ? text
    : text.replace(/"(?:\\.|[^"\\])*"/g, (token) =>
        Option.match(decodeJsonString(token), {
          onNone: () => token,
          onSome: (decoded) => {
            const clean = sanitizeText(decoded);
            return clean === decoded
              ? token
              : Option.getOrElse(encodeJsonString(clean), () => token);
          },
        }),
      );

const sanitizeContent = (content: Extract<StoredMessage, { readonly role: "user" }>["content"]) =>
  Predicate.isString(content)
    ? sanitizeText(content)
    : content.map((part) =>
        part.type === "text" ? { ...part, content: sanitizeText(part.content) } : part,
      );

/** Removes lone surrogates from message text and tool call arguments. Thinking stays as signed. */
const sanitizeHistory = (history: ReadonlyArray<StoredMessage>): Array<StoredMessage> =>
  history.map((message): StoredMessage =>
    Match.value(message).pipe(
      Match.discriminatorsExhaustive("role")({
        user: (user): StoredMessage => ({ ...user, content: sanitizeContent(user.content) }),
        tool: (tool): StoredMessage => ({ ...tool, content: sanitizeContent(tool.content) }),
        assistant: (assistant): StoredMessage => ({
          ...assistant,
          content: Option.getOrNull(
            Option.map(Option.fromNullishOr(assistant.content), sanitizeText),
          ),
          ...optionalProperty(
            "toolCalls",
            assistant.toolCalls?.map((call) => ({
              ...call,
              function: {
                ...call.function,
                arguments: sanitizeArguments(call.function.arguments),
              },
            })),
          ),
        }),
      }),
    ),
  );

/**
 * The history a request to `target` carries. The subscription providers pass no target: they
 * read another model's turns as their own. `providerPrompt` applies it to a prompt.
 */
export const providerHistory: {
  (
    target: ReplayTarget | undefined,
  ): (history: ReadonlyArray<StoredMessage>) => Array<StoredMessage>;
  (history: ReadonlyArray<StoredMessage>, target: ReplayTarget | undefined): Array<StoredMessage>;
} = EffectFunction.dual(
  2,
  (history: ReadonlyArray<StoredMessage>, target: ReplayTarget | undefined) =>
    sanitizeHistory(replayHistory(history, target)),
);

/**
 * The prompt a request to `target` sends, from the prompt of the stored conversation
 * (`toPrompt`): its history replayed, and its system prompts without lone surrogates.
 */
export const providerPrompt: {
  (target: ReplayTarget | undefined): (prompt: Prompt.Prompt) => Prompt.Prompt;
  (prompt: Prompt.Prompt, target: ReplayTarget | undefined): Prompt.Prompt;
} = EffectFunction.dual(2, (prompt: Prompt.Prompt, target: ReplayTarget | undefined) => {
  const { system, history } = fromPrompt(prompt);
  return toPrompt(providerHistory(history, target), system.map(sanitizeText));
});
