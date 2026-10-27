import { Effect, Schema } from "effect";
import { Tool } from "effect/ai";
import { expect } from "vite-plus/test";
import type { StoredMessage } from "../../src/chat-store/schema.ts";
import { JsonValue } from "../../src/json.ts";
import {
  compatibleRequest,
  compatibleTarget,
  type CompatiblePayload,
} from "../../src/model/compatible.ts";
import { providerPrompt } from "../../src/model/history.ts";
import { toPrompt } from "../../src/model/prompt.ts";
import { subscriptionBody } from "../../src/model/subscription.ts";
import type { SubscriptionModelSelection } from "../../src/providers/contracts.ts";
import { lazyToolsFor } from "../../src/tools/discovery.ts";
import type { RunTool } from "../../src/tools/run-tool.ts";

/**
 * The subscription and compatible requests a continued conversation sends, as the Effect AI model
 * builds them (docs/effect-ai-migration.md step 2). Until TanStack was removed, the tests compared
 * each with the request the TanStack adapter sent for the same thread; the golden files keep what
 * those comparisons proved equal, so a changed request is one the provider sees changed, prompt
 * cache included.
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

const effectTools = tools.map((tool) =>
  Tool.dynamic(tool.name, { description: tool.description, parameters: tool.parameters }),
);

/** The compatible endpoint the requests go to: a model no stored turn came from. */
const endpoint = {
  baseUrl: "http://127.0.0.1:1234/v1",
  model: "local-model",
  contextWindow: 10_000_000,
  outputBudget: 4096,
  toolCalling: true,
};

// `OpenAiClient` sends the payload with its stream fields set again, which keeps their place.
const wireBody = (payload: CompatiblePayload) =>
  JSON.stringify({ ...payload, stream: true, stream_options: { include_usage: true } });

/** The body the Effect AI compatible model sends for `history`; none when refused. */
const effectCompatibleBody = (
  history: ReadonlyArray<StoredMessage>,
  modelTools: ReadonlyArray<Tool.Any>,
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

/** The body the Effect AI model sends for `history`. */
const effectBody = (
  selection: SubscriptionModelSelection,
  threadId: string,
  history: ReadonlyArray<StoredMessage>,
  modelTools: ReadonlyArray<Tool.Any>,
) =>
  subscriptionBody({
    provider: selection.provider,
    selection,
    prompt: providerPrompt(toPrompt(history, [system]), undefined),
    tools: modelTools,
    promptCache: { retention: "long", key: threadId },
  });

// Both texts are request bodies the providers serialized from JSON values.
const parseBody = (text: string): JsonValue => JSON.parse(text);

/**
 * Whether `value` is the golden file at `path`, relative to the test file: the requests the
 * comparisons with TanStack proved equal.
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
