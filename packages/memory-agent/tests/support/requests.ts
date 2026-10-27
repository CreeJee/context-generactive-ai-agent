// Native SDK boundary: the TanStack side runs the real `chat()` with a client that only records
// the request body, so both sides are compared on what would go over the wire.
import { chat, toolDefinition, type AnyTool, type ModelMessage } from "@tanstack/ai";
import { Cause, Context, Effect, Layer, Predicate, Schema, Stream } from "effect";
import { Tool } from "effect/ai";
import { expect } from "vite-plus/test";
import type { StoredMessage } from "../../src/chat-store/schema.ts";
import { GlobalConfig, type Settings } from "../../src/config/global-config.ts";
import { JsonValue } from "../../src/json.ts";
import {
  compatibleRequest,
  compatibleTarget,
  type CompatiblePayload,
} from "../../src/model/compatible.ts";
import { providerPrompt } from "../../src/model/history.ts";
import { toPrompt } from "../../src/model/prompt.ts";
import { subscriptionBody } from "../../src/model/subscription.ts";
import { NormalizedStreamEvent } from "../../src/oauth/protocol.ts";
import { optionalProperty } from "../../src/optional-property.ts";
import type { SubscriptionModelSelection } from "../../src/providers/contracts.ts";
import {
  CompatibleFetch,
  CompatibleKeyring,
  OpenAICompatibleSettings,
} from "../../src/providers/openai-compatible.ts";
import { SubscriptionTextAdapter } from "../../src/providers/subscription-adapter.ts";
import { nativeStream } from "../../src/runtime/native-stream.ts";
import { lazyToolsFor } from "../../src/tools/discovery.ts";
import type { RunTool } from "../../src/tools/run-tool.ts";

/**
 * The subscription and compatible requests a continued conversation sends, built by the TanStack
 * adapter and by the Effect AI model (docs/effect-ai-migration.md step 2). Equal bodies mean the
 * switch keeps the provider's view of every conversation, prompt cache included. The golden test
 * and tools/chat-store-check compare the same requests.
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

const tanstackTools = () =>
  tools.map((tool) =>
    toolDefinition({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters,
    }),
  );

const effectTools = tools.map((tool) =>
  Tool.dynamic(tool.name, { description: tool.description, parameters: tool.parameters }),
);

/** The body the TanStack adapter sends for `history`, run through the real `chat()`. */
const tanstackBody = Effect.fnUntraced(function* (
  selection: SubscriptionModelSelection,
  threadId: string,
  history: ReadonlyArray<ModelMessage>,
  chatTools: ReadonlyArray<AnyTool> = tanstackTools(),
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
        tools: [...chatTools],
        threadId,
        promptCache: "long",
      }),
      (cause) => new Cause.UnknownError(cause),
    ),
  );
  return bodies[0] ?? "";
});

/** The compatible endpoint both sides send to: a model no stored turn came from. */
const endpoint = {
  baseUrl: "http://127.0.0.1:1234/v1",
  model: "local-model",
  contextWindow: 10_000_000,
  outputBudget: 4096,
  toolCalling: true,
};

const completion =
  'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"local-model","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

/**
 * The body the TanStack compatible adapter sends for `history`, with this app's fetch changes,
 * run through the real `chat()`; none when it refused the request.
 */
const tanstackCompatibleBody = Effect.fnUntraced(function* (
  threadId: string,
  history: ReadonlyArray<ModelMessage>,
  chatTools: ReadonlyArray<AnyTool> = tanstackTools(),
) {
  let settings: Settings = {};
  const bodies: string[] = [];
  const layer = OpenAICompatibleSettings.layerWith(
    Layer.succeed(CompatibleKeyring, () => ({
      get: () => Promise.resolve(null),
      set: () => Promise.resolve(),
    })),
    Layer.succeed(CompatibleFetch, (_url, init) => {
      bodies.push(Predicate.isString(init?.body) ? init.body : "");
      return Promise.resolve(
        new Response(completion, { headers: { "Content-Type": "text/event-stream" } }),
      );
    }),
  ).pipe(
    Layer.provide(
      Layer.succeed(GlobalConfig, {
        read: Effect.sync(() => settings),
        update: (patch: Partial<Settings>) =>
          Effect.sync(() => (settings = { ...settings, ...patch })),
      }),
    ),
  );
  const api = Context.get(yield* Layer.build(layer), OpenAICompatibleSettings);
  const { model, baseUrl, ...limits } = endpoint;
  const account = (yield* api.create({ baseUrl })).accounts[0]?.id ?? "";
  yield* api.saveModel(account, { id: model, ...limits });
  const adapter = (yield* api.runtime).adapter(yield* api.services.models.select(model));
  yield* Stream.runDrain(
    Stream.fromAsyncIterable(
      chat({
        adapter,
        messages: [...history],
        systemPrompts: [system],
        tools: [...chatTools],
        threadId,
      }),
      (cause) => new Cause.UnknownError(cause),
    ),
  ).pipe(Effect.ensuring(Effect.sync(() => adapter.releaseRun?.())));
  return bodies[0];
}, Effect.scoped);

// `OpenAiClient` sends the payload with its stream fields set again, which keeps their place.
const wireBody = (payload: CompatiblePayload) =>
  JSON.stringify({ ...payload, stream: true, stream_options: { include_usage: true } });

/** The body the Effect AI compatible model sends for the migrated `history`; none when refused. */
const effectCompatibleBody = (
  history: ReadonlyArray<StoredMessage>,
  modelTools: ReadonlyArray<Tool.Any> = effectTools,
) =>
  compatibleRequest({
    endpoint,
    reasoningEffort: "default",
    prompt: providerPrompt(toPrompt(history, [system]), compatibleTarget(endpoint.model)),
    tools: modelTools,
  }).pipe(
    Effect.map(wireBody),
    Effect.orElseSucceed(() => undefined),
  );

/** The body the Effect AI model sends for the migrated `history`. */
const effectBody = (
  selection: SubscriptionModelSelection,
  threadId: string,
  history: ReadonlyArray<StoredMessage>,
  modelTools: ReadonlyArray<Tool.Any> = effectTools,
) =>
  subscriptionBody({
    provider: selection.provider,
    selection,
    prompt: providerPrompt(toPrompt(history, [system]), undefined),
    tools: modelTools,
    promptCache: { retention: "long", key: threadId },
  });

const isList = (value: JsonValue): value is ReadonlyArray<JsonValue> => Array.isArray(value);
const isRecord = (value: JsonValue): value is { readonly [key: string]: JsonValue } =>
  Predicate.isObject(value) && !Array.isArray(value);

/** Where two JSON values first differ; key order counts except under `unordered` paths. */
const differenceAt = (
  a: JsonValue,
  b: JsonValue,
  path: string,
  unordered: (path: string) => boolean,
): string | undefined => {
  if (isList(a) && isList(b)) {
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
      const at = `${path}[${index}]`;
      if (index >= a.length || index >= b.length) return `${at} missing`;
      const found = differenceAt(a[index]!, b[index]!, at, unordered);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (isRecord(a) && isRecord(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const at = `${path}.${key}`;
      if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key)) return `${at} missing`;
      const found = differenceAt(a[key]!, b[key]!, at, unordered);
      if (found !== undefined) return found;
    }
    return unordered(path) || Object.keys(a).join() === Object.keys(b).join()
      ? undefined
      : `${path} key order`;
  }
  return a === b ? undefined : path === "" ? "(root)" : path;
};

// Both texts are request bodies the providers serialized from JSON values.
const parseBody = (text: string): JsonValue => JSON.parse(text);

/**
 * Where two request bodies first differ, as a path of keys and indexes; never their values. A
 * body that is missing is a request that was refused before it was sent.
 */
const firstDifference = (
  expected: string | undefined,
  actual: string | undefined,
  unordered?: (path: string) => boolean,
): string | undefined => {
  if (expected === actual) return undefined;
  if (expected === undefined || actual === undefined)
    return expected === undefined ? "(TanStack sent no request)" : "(Effect AI sent no request)";
  const difference = differenceAt(
    parseBody(expected),
    parseBody(actual),
    "",
    unordered ?? (() => false),
  );
  return difference ?? (unordered === undefined ? "(same JSON, different text)" : undefined);
};

/**
 * TanStack moved `strict` to the second key of each tool it found strict-compatible, and this
 * app set it back to false in place. Effect AI sends every tool non-strict with its keys in one
 * order, so the compatible tools are compared without key order.
 */
const compatibleUnordered = (path: string) => /^\.tools\[\d+\]\.function$/.test(path);

/**
 * For each provider, where the request continuing a thread differs between TanStack, which reads
 * `tanstack`, and the Effect AI model, which reads `stored`: the same thread before and after the
 * migration. `next` must already end both.
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
  Effect.all([
    Effect.forEach(selections, (selection) =>
      Effect.map(tanstackBody(selection, threadId, tanstack), (expected) => ({
        provider: selection.provider,
        difference: firstDifference(expected, effectBody(selection, threadId, stored)),
      })),
    ),
    Effect.map(
      Effect.all([tanstackCompatibleBody(threadId, tanstack), effectCompatibleBody(stored)]),
      ([expected, actual]) => ({
        provider: "openai-compatible",
        difference: firstDifference(expected, actual, compatibleUnordered),
      }),
    ),
  ]).pipe(Effect.map(([subscription, compatible]) => [...subscription, compatible]));

/**
 * For each subscription provider, where the request continuing a one-message thread differs when
 * TanStack offers `chatTools` and the Effect AI model offers `modelTools`.
 */
export const toolRequestDifferences = ({
  chatTools,
  modelTools,
}: {
  readonly chatTools: ReadonlyArray<AnyTool>;
  readonly modelTools: ReadonlyArray<Tool.Any>;
}) =>
  Effect.forEach(selections, (selection) =>
    Effect.map(tanstackBody(selection, "thread-1", [asTanStack(next)], chatTools), (expected) => ({
      provider: selection.provider,
      difference: firstDifference(expected, effectBody(selection, "thread-1", [next], modelTools)),
    })),
  );

/** The same for the compatible endpoint, whose tools are compared without key order. */
export const compatibleToolRequestDifference = ({
  chatTools,
  modelTools,
}: {
  readonly chatTools: ReadonlyArray<AnyTool>;
  readonly modelTools: ReadonlyArray<Tool.Any>;
}) =>
  Effect.map(
    Effect.all([
      tanstackCompatibleBody("thread-1", [asTanStack(next)], chatTools),
      effectCompatibleBody([next], modelTools),
    ]),
    ([expected, actual]) => firstDifference(expected, actual, compatibleUnordered),
  );

/**
 * Where a tool set's requests first differ between its TanStack tools and its Effect AI tools as the
 * loop offers them, lazy ones by name: anthropic, openai, then the compatible endpoint.
 */
export const runToolRequestDifferences = ({
  chatTools,
  runTools,
}: {
  readonly chatTools: ReadonlyArray<AnyTool>;
  readonly runTools: ReadonlyArray<RunTool>;
}) =>
  Effect.gen(function* () {
    const lazyTools = yield* lazyToolsFor(runTools, []);
    const modelTools = (yield* lazyTools.offered).map((tool) => tool.tool);
    const subscription = yield* toolRequestDifferences({ chatTools, modelTools });
    return [
      ...subscription.map(({ difference }) => difference),
      yield* compatibleToolRequestDifference({ chatTools, modelTools }),
    ];
  });

/**
 * Whether `value` is the golden file at `path`, relative to the test file: the requests the
 * comparisons above proved equal, kept for when TanStack is gone.
 */
export const matchGolden = (path: string) => (value: JsonValue) =>
  Effect.flatMap(encodeGolden(value), (text) =>
    Effect.promise(() => expect(`${text}\n`).toMatchFileSnapshot(path)),
  );

const encodeGolden = Schema.encodeEffect(Schema.fromJsonString(JsonValue, { space: 2 }));

const subscriptionBodies = (
  threadId: string,
  stored: ReadonlyArray<StoredMessage>,
  modelTools: ReadonlyArray<Tool.Any>,
): JsonValue =>
  Object.fromEntries(
    selections.map((selection) => [
      selection.provider,
      parseBody(effectBody(selection, threadId, stored, modelTools)),
    ]),
  );

const compatibleBody = (
  stored: ReadonlyArray<StoredMessage>,
  modelTools: ReadonlyArray<Tool.Any>,
) =>
  Effect.map(effectCompatibleBody(stored, modelTools), (body) =>
    body === undefined ? null : parseBody(body),
  );

/**
 * The request the Effect AI model sends each provider to continue a thread that reads `stored`;
 * the compatible one is null when the model refused it. `next` must already end the thread.
 */
export const requestBodies = ({
  threadId,
  stored,
}: {
  readonly threadId: string;
  readonly stored: ReadonlyArray<StoredMessage>;
}) =>
  Effect.map(compatibleBody(stored, effectTools), (compatible) => ({
    subscription: subscriptionBodies(threadId, stored, effectTools),
    compatible,
  }));

/** The request each subscription provider gets for a one-message thread that offers `modelTools`. */
export const subscriptionToolRequestBodies = (modelTools: ReadonlyArray<Tool.Any>) =>
  subscriptionBodies("thread-1", [next], modelTools);

/** The same for every provider; the compatible one is null when the model refused it. */
export const toolRequestBodies = (modelTools: ReadonlyArray<Tool.Any>) =>
  Effect.map(compatibleBody([next], modelTools), (compatible) => ({
    subscription: subscriptionToolRequestBodies(modelTools),
    compatible,
  }));

/** The requests for a tool set as the loop offers it, lazy ones by name. */
export const runToolRequestBodies = (runTools: ReadonlyArray<RunTool>) =>
  Effect.flatMap(lazyToolsFor(runTools, []), (lazyTools) =>
    Effect.flatMap(lazyTools.offered, (offered) =>
      toolRequestBodies(offered.map((tool) => tool.tool)),
    ),
  );
