import { Schema } from "effect";
import { JsonValue } from "../json.ts";
import { PermissionReviewPayload } from "../tools/definitions.ts";

/**
 * Chat rows as the app stores them once TanStack is gone: today's shapes without TanStack's
 * metadata. `tanstack-migration.ts` moves the stored rows to these shapes. Nothing writes them
 * before the switch (step 7 of docs/effect-ai-migration.md).
 */

/** An ISO 8601 time, as `JSON.stringify` writes a `Date`. */
const IsoTime = Schema.String;

export const TextPart = Schema.Struct({ type: Schema.Literal("text"), content: Schema.String });
export const ImagePart = Schema.Struct({
  type: Schema.Literal("image"),
  source: Schema.Union([
    Schema.Struct({ type: Schema.Literal("data"), value: Schema.String, mimeType: Schema.String }),
    Schema.Struct({
      type: Schema.Literal("url"),
      value: Schema.String,
      mimeType: Schema.optionalKey(Schema.String),
    }),
  ]),
});
const Content = Schema.Union([Schema.String, Schema.Array(Schema.Union([TextPart, ImagePart]))]);

export const StoredToolCall = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("function"),
  /** `arguments` is the JSON text the model sent, which may not parse. */
  function: Schema.Struct({ name: Schema.String, arguments: Schema.String }),
});

/** Provider, wire API and model of the call that wrote an assistant message. */
export const MessageSource = Schema.Struct({
  provider: Schema.String,
  /** Absent on messages a Goal worker wrote: its adapter stand-in had no `api` or `kind`. */
  api: Schema.optionalKey(Schema.String),
  model: Schema.String,
});

export const StoredUserMessage = Schema.Struct({
  role: Schema.Literal("user"),
  id: Schema.optionalKey(Schema.String),
  createdAt: Schema.optionalKey(IsoTime),
  content: Content,
});

export const StoredAssistantMessage = Schema.Struct({
  role: Schema.Literal("assistant"),
  id: Schema.optionalKey(Schema.String),
  createdAt: Schema.optionalKey(IsoTime),
  /** Absent or null when the message is only tool calls or thinking. */
  content: Schema.optionalKey(Schema.NullOr(Schema.String)),
  toolCalls: Schema.optionalKey(Schema.Array(StoredToolCall)),
  thinking: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        content: Schema.String,
        signature: Schema.optionalKey(Schema.String),
        /** The provider encrypted the block: `content` is empty and `signature` holds it. */
        redacted: Schema.optionalKey(Schema.Boolean),
      }),
    ),
  ),
  /** The model the user had selected. Model handoff finds the earlier model here. */
  model: Schema.optionalKey(Schema.String),
  /** Replay treats a message from another source as another model's and sends it as plain text. */
  source: Schema.optionalKey(MessageSource),
  /** `length`: the output limit cut the message, so its tool call arguments may not parse. */
  finishReason: Schema.optionalKey(
    Schema.NullOr(Schema.Literals(["stop", "length", "content_filter", "tool_calls"])),
  ),
  /** The turn failed or was cancelled; replay leaves it and its tool results out. */
  stopReason: Schema.optionalKey(Schema.Literals(["error", "aborted"])),
});

export const StoredToolMessage = Schema.Struct({
  role: Schema.Literal("tool"),
  id: Schema.optionalKey(Schema.String),
  createdAt: Schema.optionalKey(IsoTime),
  toolCallId: Schema.String,
  content: Content,
  error: Schema.optionalKey(Schema.String),
});

/** One message of `chat_threads.messages` and `chat_history_groups.messages`. */
export const StoredMessage = Schema.Union([
  StoredUserMessage,
  StoredAssistantMessage,
  StoredToolMessage,
]);
export type StoredMessage = typeof StoredMessage.Type;

/** `chat_history_groups.messages`: the thread's messages one screen message shows, in order. */
export const StoredHistoryGroup = Schema.NonEmptyArray(StoredMessage);

/** `chat_runs.status`. `interrupted` waits for the user; the rest but `running` are terminal. */
export const StoredRunStatus = Schema.Literals([
  "running",
  "interrupted",
  "completed",
  "failed",
  "aborted",
]);

const TokenCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * `chat_runs.usage`: AG-UI 1.0 `TokenUsage`, the accounting of the stream's `RUN_FINISHED` usage.
 * `inputTokens` counts cache reads and writes; `cachedInputTokens`, `cacheWriteInputTokens` and
 * `reasoningTokens` are parts of a total, never additions to it.
 */
export const StoredUsage = Schema.Struct({
  provider: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  inputTokens: Schema.optionalKey(TokenCount),
  outputTokens: Schema.optionalKey(TokenCount),
  totalTokens: Schema.optionalKey(TokenCount),
  reasoningTokens: Schema.optionalKey(TokenCount),
  cachedInputTokens: Schema.optionalKey(TokenCount),
  cacheWriteInputTokens: Schema.optionalKey(TokenCount),
});
export type StoredUsage = typeof StoredUsage.Type;

/** `chat_interrupts.payload`: an AG-UI 1.0 `Interrupt`, discriminated by `reason`. */
export const StoredInterruptPayload = Schema.Union([
  /** A tool that needs approval in `ask` mode. */
  Schema.Struct({
    id: Schema.String,
    reason: Schema.Literal("tool_call"),
    message: Schema.String,
    toolCallId: Schema.String,
    responseSchema: JsonValue,
    metadata: Schema.Struct({
      kind: Schema.Literal("approval"),
      toolName: Schema.String,
      input: JsonValue,
    }),
  }),
  /** The permission review or an every-call tool asks the user. */
  Schema.Struct({
    id: Schema.String,
    reason: Schema.Literal("permission_review"),
    message: Schema.String,
    responseSchema: JsonValue,
    metadata: Schema.Struct({ payload: PermissionReviewPayload }),
  }),
]);
export type StoredInterruptPayload = typeof StoredInterruptPayload.Type;

/**
 * `chat_interrupts.response`. Its own interrupt's `responseSchema` checks it further, as an
 * approval may carry edited arguments of that tool.
 */
export const StoredInterruptResponse = Schema.Union([
  Schema.Struct({
    approved: Schema.Literal(true),
    editedArgs: Schema.optionalKey(Schema.Record(Schema.String, JsonValue)),
  }),
  Schema.Struct({ approved: Schema.Literal(false) }),
]);
