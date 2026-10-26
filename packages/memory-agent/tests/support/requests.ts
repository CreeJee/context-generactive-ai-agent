// Native SDK boundary: the TanStack side runs the real `chat()` with a client that only records
// the request body, so both sides are compared on what would go over the wire.
import { chat, toolDefinition, type ModelMessage } from "@tanstack/ai";
import { Cause, Effect, Predicate, Stream } from "effect";
import { Tool } from "effect/ai";
import type { StoredMessage } from "../../src/chat-store/schema.ts";
import type { JsonValue } from "../../src/json.ts";
import { providerPrompt } from "../../src/model/history.ts";
import { toPrompt } from "../../src/model/prompt.ts";
import { subscriptionBody } from "../../src/model/subscription.ts";
import { NormalizedStreamEvent } from "../../src/oauth/protocol.ts";
import { optionalProperty } from "../../src/optional-property.ts";
import type { SubscriptionModelSelection } from "../../src/providers/contracts.ts";
import { SubscriptionTextAdapter } from "../../src/providers/subscription-adapter.ts";
import { nativeStream } from "../../src/runtime/native-stream.ts";

/**
 * The subscription request a continued conversation sends, built by the TanStack adapter and by
 * the Effect AI model (docs/effect-ai-migration.md step 2). Equal bodies mean the switch keeps
 * the provider's view of every conversation, prompt cache included. The golden test and
 * tools/chat-store-check compare the same requests.
 */

/** A system prompt with a lone surrogate, which both sides remove. */
export const system = "Follow the rules. \uD800";

/** The message that continues the conversation. */
export const next: StoredMessage = { role: "user", content: "next" };

/** Tools out of name order, so the sorting the prompt cache needs is compared too. */
const tools = [
  {
    name: "read_file",
    description: "Read a file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "list_files",
    description: "List files",
    parameters: { type: "object", properties: {} },
  },
];

const selections: ReadonlyArray<SubscriptionModelSelection> = [
  { provider: "anthropic", model: "claude-opus-5-5", reasoningEffort: "high" },
  { provider: "openai", model: "gpt-5.5", reasoningEffort: "medium" },
];

// A stored message is TanStack's message text with its kept metadata lifted, so once the fields go
// back under `metadata.tanstack`, parsing the text restores the message.
const parseMessage = (text: string): ModelMessage => JSON.parse(text);

/** The messages of a thread row TanStack wrote. */
export const parseTanStackMessages = (text: string): ReadonlyArray<ModelMessage> =>
  JSON.parse(text);

/** A migrated message as TanStack stored it, for a history that only exists migrated. */
export const asTanStack = (message: StoredMessage): ModelMessage => {
  if (message.role !== "assistant") return parseMessage(JSON.stringify(message));
  const { model, source, finishReason, stopReason, ...rest } = message;
  const tanstack = {
    ...optionalProperty("model", model),
    ...optionalProperty("source", source),
    ...optionalProperty("finishReason", finishReason),
    ...optionalProperty("stopReason", stopReason),
  };
  return parseMessage(
    JSON.stringify(Object.keys(tanstack).length === 0 ? rest : { ...rest, metadata: { tanstack } }),
  );
};

/** The body the TanStack adapter sends for `history`, run through the real `chat()`. */
const tanstackBody = Effect.fnUntraced(function* (
  selection: SubscriptionModelSelection,
  threadId: string,
  history: ReadonlyArray<ModelMessage>,
) {
  const bodies: string[] = [];
  const adapter = new SubscriptionTextAdapter(
    {
      stream(body) {
        bodies.push(body);
        return nativeStream(Stream.make(NormalizedStreamEvent.text({ text: "ok" })));
      },
    },
    selection,
  );
  yield* Stream.runDrain(
    Stream.fromAsyncIterable(
      chat({
        adapter,
        messages: [...history],
        systemPrompts: [system],
        tools: tools.map((tool) =>
          toolDefinition({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.parameters,
          }),
        ),
        threadId,
        promptCache: "long",
      }),
      (cause) => new Cause.UnknownError(cause),
    ),
  );
  return bodies[0] ?? "";
});

/** The body the Effect AI model sends for the migrated `history`. */
const effectBody = (
  selection: SubscriptionModelSelection,
  threadId: string,
  history: ReadonlyArray<StoredMessage>,
) =>
  subscriptionBody({
    provider: selection.provider,
    selection,
    prompt: providerPrompt(toPrompt(history, [system]), undefined),
    tools: tools.map((tool) =>
      Tool.dynamic(tool.name, { description: tool.description, parameters: tool.parameters }),
    ),
    promptCache: { retention: "long", key: threadId },
  });

const isList = (value: JsonValue): value is ReadonlyArray<JsonValue> => Array.isArray(value);
const isRecord = (value: JsonValue): value is { readonly [key: string]: JsonValue } =>
  Predicate.isObject(value) && !Array.isArray(value);

const differenceAt = (a: JsonValue, b: JsonValue, path: string): string | undefined => {
  if (isList(a) && isList(b)) {
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
      const at = `${path}[${index}]`;
      if (index >= a.length || index >= b.length) return `${at} missing`;
      const found = differenceAt(a[index]!, b[index]!, at);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (isRecord(a) && isRecord(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const at = `${path}.${key}`;
      if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key)) return `${at} missing`;
      const found = differenceAt(a[key]!, b[key]!, at);
      if (found !== undefined) return found;
    }
    return Object.keys(a).join() === Object.keys(b).join() ? undefined : `${path} key order`;
  }
  return a === b ? undefined : path === "" ? "(root)" : path;
};

// Both texts are request bodies the providers serialized from JSON values.
const parseBody = (text: string): JsonValue => JSON.parse(text);

/** Where two JSON texts first differ, as a path of keys and indexes; never their values. */
const firstDifference = (expected: string, actual: string): string | undefined =>
  expected === actual
    ? undefined
    : (differenceAt(parseBody(expected), parseBody(actual), "") ?? "(same JSON, different text)");

/**
 * For each subscription provider, where the request continuing a thread differs between
 * TanStack, which reads `tanstack`, and the Effect AI model, which reads `stored`: the same
 * thread before and after the migration. `next` must already end both.
 */
export const requestDifferences = ({
  threadId,
  tanstack,
  stored,
}: {
  readonly threadId: string;
  readonly tanstack: ReadonlyArray<ModelMessage>;
  readonly stored: ReadonlyArray<StoredMessage>;
}) =>
  Effect.forEach(selections, (selection) =>
    Effect.map(tanstackBody(selection, threadId, tanstack), (expected) => ({
      provider: selection.provider,
      difference: firstDifference(expected, effectBody(selection, threadId, stored)),
    })),
  );
