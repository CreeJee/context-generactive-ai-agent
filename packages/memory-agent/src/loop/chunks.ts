import { Schema } from "effect";
import { StoredInterruptPayload, StoredUsage } from "../chat-store/schema.ts";
import { JsonValue } from "../json.ts";

/**
 * The AG-UI 1.0 events a run streams to the page (docs/effect-ai-migration.md step 4): the standard
 * shapes only, with no TanStack fields. Every event the loop writes is one of these; the client
 * decodes the stream with the same Schema (step 6). When Effect's `AgUiSchema` is merged, it
 * replaces this module.
 */

/** Milliseconds since the epoch, as AG-UI writes them. */
const timestamp = Schema.optionalKey(Schema.Int);

const event = <const Type extends string, const Fields extends Schema.Struct.Fields>(
  type: Type,
  fields: Fields,
) => Schema.Struct({ type: Schema.Literal(type), timestamp, ...fields });

export const RunStarted = event("RUN_STARTED", {
  threadId: Schema.String,
  runId: Schema.String,
  /** The run whose interrupts this run answers. */
  parentRunId: Schema.optionalKey(Schema.String),
});

/** Why a run that did not fail ended. An absent outcome is a success. */
export const RunOutcome = Schema.Union([
  Schema.Struct({ type: Schema.Literal("success") }),
  /** The run waits for the user; the next run answers these with `resume`. */
  Schema.Struct({
    type: Schema.Literal("interrupt"),
    interrupts: Schema.NonEmptyArray(StoredInterruptPayload),
  }),
  Schema.Struct({ type: Schema.Literal("cancelled") }),
]).pipe(Schema.toTaggedUnion("type"));
export type RunOutcome = typeof RunOutcome.Type;

export const RunFinished = event("RUN_FINISHED", {
  threadId: Schema.String,
  runId: Schema.String,
  outcome: Schema.optionalKey(RunOutcome),
  usage: Schema.optionalKey(Schema.Array(StoredUsage)),
});

export const RunError = event("RUN_ERROR", {
  /** Shown to the user, so it never carries a provider's text. */
  message: Schema.String,
  code: Schema.optionalKey(Schema.String),
  usage: Schema.optionalKey(Schema.Array(StoredUsage)),
});

export const TextMessageStart = event("TEXT_MESSAGE_START", {
  messageId: Schema.String,
  role: Schema.Literal("assistant"),
});
export const TextMessageContent = event("TEXT_MESSAGE_CONTENT", {
  messageId: Schema.String,
  delta: Schema.String,
});
export const TextMessageEnd = event("TEXT_MESSAGE_END", { messageId: Schema.String });

export const ReasoningStart = event("REASONING_START", { messageId: Schema.String });
export const ReasoningMessageStart = event("REASONING_MESSAGE_START", {
  messageId: Schema.String,
  role: Schema.Literal("reasoning"),
});
export const ReasoningMessageContent = event("REASONING_MESSAGE_CONTENT", {
  messageId: Schema.String,
  delta: Schema.String,
});
export const ReasoningMessageEnd = event("REASONING_MESSAGE_END", { messageId: Schema.String });
export const ReasoningEnd = event("REASONING_END", { messageId: Schema.String });

export const ToolCallStart = event("TOOL_CALL_START", {
  toolCallId: Schema.String,
  toolCallName: Schema.String,
  /** The assistant message that made the call. */
  parentMessageId: Schema.optionalKey(Schema.String),
});
export const ToolCallArgs = event("TOOL_CALL_ARGS", {
  toolCallId: Schema.String,
  delta: Schema.String,
});
/** The call's arguments are complete. */
export const ToolCallEnd = event("TOOL_CALL_END", { toolCallId: Schema.String });
export const ToolCallResult = event("TOOL_CALL_RESULT", {
  messageId: Schema.String,
  toolCallId: Schema.String,
  /** The result as the model reads it: JSON text, or text that is not JSON. */
  content: Schema.String,
  role: Schema.Literal("tool"),
});

/** The app's own events, such as a queued message reaching the run or the context meter. */
export const Custom = event("CUSTOM", { name: Schema.String, value: JsonValue });

/** One event of a run's stream. */
export const AgUiEvent = Schema.Union([
  RunStarted,
  RunFinished,
  RunError,
  TextMessageStart,
  TextMessageContent,
  TextMessageEnd,
  ReasoningStart,
  ReasoningMessageStart,
  ReasoningMessageContent,
  ReasoningMessageEnd,
  ReasoningEnd,
  ToolCallStart,
  ToolCallArgs,
  ToolCallEnd,
  ToolCallResult,
  Custom,
]).pipe(Schema.toTaggedUnion("type"));
export type AgUiEvent = typeof AgUiEvent.Type;
