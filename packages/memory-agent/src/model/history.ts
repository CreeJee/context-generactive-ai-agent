import { Function as EffectFunction, Option, Predicate, Schema } from "effect";
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
  rename: (call: ToolCall) => ToolCall,
): AssistantMessage => {
  let content = "";
  for (const thinking of message.thinking ?? [])
    if (thinking.redacted !== true && thinking.content.trim() !== "") content += thinking.content;
  content += message.content ?? "";
  const { thinking: _thinking, ...rest } = message;
  return {
    ...rest,
    content: content === "" ? null : content,
    ...optionalProperty("toolCalls", message.toolCalls?.map(rename)),
  };
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
  const usedIds = new Set<string>();
  for (const message of history)
    if (message.role === "assistant" && !isForeign(message, target) && !isFailed(message))
      for (const call of message.toolCalls ?? []) usedIds.add(call.id);
  const renamed = new Map<string, string>();
  const failedCalls = new Map<string, boolean>();
  const output: Array<StoredMessage> = [];
  let pending: Array<ToolCall> = [];
  const answered = new Set<string>();
  let turnId: string | undefined;
  const closePending = () => {
    for (const call of pending)
      if (!answered.has(call.id))
        output.push({ role: "tool", toolCallId: call.id, content: noResult, error: noResult });
    pending = [];
    answered.clear();
    turnId = undefined;
  };
  const rename =
    (rule: ReplayTarget["toolCallId"]) =>
    (call: ToolCall): ToolCall => {
      let id = call.id;
      let attempt = 0;
      do {
        if (attempt === 1000)
          // The same limit as TanStack: a rule that never yields a free id is a bug in the rule.
          throw new Error(`Tool ID rule could not allocate a unique ID for ${call.id}`);
        id = rule(call.id, attempt++);
      } while (usedIds.has(id));
      usedIds.add(id);
      renamed.set(call.id, id);
      return id === call.id ? call : { ...call, id };
    };
  for (const message of history) {
    const nextSegment =
      message.role === "assistant" &&
      answered.size === 0 &&
      turnId !== undefined &&
      message.id !== undefined &&
      (message.id === turnId || message.id.startsWith(`${turnId}-segment-`));
    if (message.role !== "tool" && !nextSegment) closePending();
    if (message.role === "assistant")
      for (const call of message.toolCalls ?? []) failedCalls.set(call.id, isFailed(message));
    if (isFailed(message)) continue;
    if (message.role === "tool") {
      if (failedCalls.get(message.toolCallId) === true) continue;
      const id = renamed.get(message.toolCallId) ?? message.toolCallId;
      answered.add(id);
      output.push(id === message.toolCallId ? message : { ...message, toolCallId: id });
      continue;
    }
    if (message.role === "user") {
      output.push(message);
      continue;
    }
    let replayed = message;
    if (target !== undefined && isForeign(message, target))
      replayed = asForeign(message, rename(target.toolCallId));
    else for (const call of message.toolCalls ?? []) renamed.set(call.id, call.id);
    if (message.finishReason === "length" && (replayed.toolCalls ?? []).some(isCut))
      replayed = {
        ...replayed,
        toolCalls: (replayed.toolCalls ?? []).map((call) =>
          isCut(call) ? { ...call, function: { ...call.function, arguments: "{}" } } : call,
        ),
      };
    pending = [...pending, ...(replayed.toolCalls ?? [])];
    turnId ??= message.id;
    output.push(replayed);
  }
  closePending();
  return output;
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
  history.map((message): StoredMessage => {
    switch (message.role) {
      case "user":
      case "tool":
        return { ...message, content: sanitizeContent(message.content) };
      case "assistant":
        return {
          ...message,
          content:
            message.content === undefined || message.content === null
              ? null
              : sanitizeText(message.content),
          ...optionalProperty(
            "toolCalls",
            message.toolCalls?.map((call) => ({
              ...call,
              function: { ...call.function, arguments: sanitizeArguments(call.function.arguments) },
            })),
          ),
        };
    }
  });

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
