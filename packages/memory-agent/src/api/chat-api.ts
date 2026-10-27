import { Array as Arr, Option, Schema, SchemaAST } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
} from "effect/http-api";
import {
  ImagePart,
  StoredInterruptPayload,
  StoredUserMessage,
  TextPart,
} from "../chat-store/schema.ts";
import { JsonValue } from "../json.ts";
import { AgUiEvent } from "../loop/chunks.ts";
import type { sessionHolderHeader } from "../sessions/lease-state.ts";

/**
 * The chat API the page's Effect client calls (docs/effect-ai-migration.md step 6), declared once
 * for the server and the client. A run streams its AG-UI events over SSE. Each event's id is its
 * place in the run's log; a reconnect names the last id it read and continues after it. This
 * module imports no server code, so the browser bundle can use it.
 */

/** Fields some refusals add to their code. */
const details = {
  runId: Schema.optionalKey(Schema.String),
  agent: Schema.optionalKey(Schema.String),
  provider: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  route: Schema.optionalKey(Schema.String),
};

const refusal = <const Codes extends readonly [string, ...Array<string>]>(
  status: number,
  codes: Codes,
) =>
  Schema.Struct({ error: Schema.Literals(codes), ...details }).pipe(HttpApiSchema.status(status));

const BadRequest = refusal(400, [
  "invalid_chat_request",
  "empty_message",
  "unknown_attachment",
  "invalid_stream_offset",
]);
const Unauthorized = refusal(401, ["login_required"]);
const Forbidden = refusal(403, ["cross_site_request", "invalid_origin"]);
const NotFound = refusal(404, ["session_not_found", "project_not_found", "run_not_found"]);
const Conflict = refusal(409, [
  "report_requires_local_model",
  "run_in_progress",
  "external_agent_unavailable",
  "run_id_conflict",
  "run_outcome_uncertain",
  "run_already_completed",
  "workflow_changed",
  "legacy_unbound",
  "owner_mismatch",
  "automatic_goal_admission_unavailable",
  "queued_message_not_next",
  "no_user_turn",
  "model_unavailable_for_account",
  "image_direct_workflow_required",
  "notification_followup_deferred",
  "workflow_followup_deferred",
]);
const PreconditionFailed = refusal(412, ["model_selection_required"]);
const Unprocessable = refusal(422, [
  "images_not_supported",
  "provider_image_generation_unavailable",
  "report_image_generation_unavailable",
  "image_route_unavailable",
]);
const Locked = refusal(423, ["session_in_use"]);
const Internal = refusal(500, ["goal_ledger_unavailable", "goal_workflow_admission_failed"]);
const Unavailable = refusal(503, [
  "provider_auth_unavailable",
  "provider_unavailable",
  "goal_workflow_saturated",
]);

/** What the endpoints refuse with; the cross-site refusal belongs to `SameSite`. */
const refusals = [
  BadRequest,
  Unauthorized,
  NotFound,
  Conflict,
  PreconditionFailed,
  Unprocessable,
  Locked,
  Internal,
  Unavailable,
] as const;

/** A refused request: its code, and the details some codes carry. */
export const Refusal = Schema.Union(refusals);
export type Refusal = typeof Refusal.Type;

const annotatedStatus = SchemaAST.resolveAt<number>("httpApiStatus");

/** The HTTP status a refusal is answered with. */
export const refusalStatus = (refused: Refusal): number =>
  Arr.findFirst(refusals, (schema) => Schema.is(schema)(refused)).pipe(
    Option.flatMapNullishOr((schema) => annotatedStatus(schema.ast)),
    Option.getOrElse(() => 500),
  );

/** Refuses a request that changes a session when another site sent it (PRD R14). */
export class SameSite extends HttpApiMiddleware.Service<SameSite>()(
  "memory-agent/api/chat-api/SameSite",
  { error: Forbidden },
) {}

/** The page's answer to one interrupt of the run it resumes. */
export const ResumeEntry = Schema.Struct({
  interruptId: Schema.String,
  status: Schema.Literals(["resolved", "cancelled"]),
  payload: Schema.optionalKey(JsonValue),
  metadata: Schema.optionalKey(Schema.Record(Schema.String, JsonValue)),
});
export type ResumeEntry = typeof ResumeEntry.Type;

/** A user message the page sends, with the content the thread stores. */
const UserMessage = Schema.Struct({
  id: Schema.String,
  role: Schema.Literal("user"),
  content: StoredUserMessage.fields.content,
});

/**
 * One run of a session, in AG-UI `RunAgentInput` field names. The session is the thread, and the
 * server holds the conversation, so the page sends only its new user turn. The server runs no
 * client tools and reads no client context or state.
 */
export const RunInput = Schema.Struct({
  runId: Schema.String,
  /** The run whose interrupts `resume` answers. */
  parentRunId: Schema.optionalKey(Schema.String),
  messages: Schema.Array(UserMessage),
  resume: Schema.optionalKey(Schema.Array(ResumeEntry)),
  forwardedProps: Schema.optionalKey(
    Schema.Struct({
      /** The turn is the queued message at the head of the queue, not the page's text. */
      queuedNext: Schema.optionalKey(Schema.Literal(true)),
      imageIntent: Schema.optionalKey(Schema.Literal("generate_image")),
    }),
  ),
});
export type RunInput = typeof RunInput.Type;

/** One event of a run's stream. */
export const RunEvent = Schema.Struct({
  /** The event's place in the run's log; `join` continues after it. */
  id: Schema.String,
  event: Schema.Literal("message"),
  data: Schema.fromJsonString(AgUiEvent),
});
export type RunEvent = typeof RunEvent.Type;

/** The run's log could not be read, so its stream ended before the run did. */
export const RunEventsLost = Schema.Struct({ error: Schema.Literal("run_events_unavailable") });

const RunEvents = HttpApiSchema.StreamSse({ events: RunEvent, error: RunEventsLost });

/** A tool call as the page shows it; the states are those the stored transcript has. */
const ToolCallPart = Schema.Struct({
  type: Schema.Literal("tool-call"),
  id: Schema.String,
  name: Schema.String,
  /** The arguments as the model wrote them: JSON text, or text that does not parse. */
  arguments: Schema.String,
  state: Schema.Literals([
    "awaiting-input",
    "input-streaming",
    "input-complete",
    "approval-requested",
    "approval-responded",
    "complete",
    "error",
  ]),
});

const ToolResultPart = Schema.Struct({
  type: Schema.Literal("tool-result"),
  toolCallId: Schema.String,
  /** The result as the model read it. */
  content: Schema.String,
  state: Schema.Literals(["streaming", "complete", "error"]),
});

/** One part of a message, in the order the page shows them. */
export const MessagePart = Schema.Union([
  TextPart,
  Schema.Struct({ type: Schema.Literal("thinking"), content: Schema.String }),
  ImagePart,
  ToolCallPart,
  ToolResultPart,
]).pipe(Schema.toTaggedUnion("type"));
export type MessagePart = typeof MessagePart.Type;

/** A message of the conversation. An assistant message holds one run's text and tool calls. */
export const ChatMessage = Schema.Struct({
  id: Schema.String,
  role: Schema.Literals(["user", "assistant"]),
  parts: Schema.Array(MessagePart),
});
export type ChatMessage = typeof ChatMessage.Type;

/** The approvals a run waits for; the next run answers them with `resume`. */
export const PendingInterrupts = Schema.Struct({
  runId: Schema.String,
  pending: Schema.NonEmptyArray(StoredInterruptPayload),
});
export type PendingInterrupts = typeof PendingInterrupts.Type;

/** What a page opens a session with, or an older page of its messages. */
export const ChatSnapshot = Schema.Struct({
  /** Oldest first. */
  messages: Schema.Array(ChatMessage),
  /** `before` for the page of messages older than these, or null when there are none. */
  older: Schema.NullOr(Schema.String),
  /** The run still going, which `join` follows. */
  activeRun: Schema.NullOr(Schema.Struct({ runId: Schema.String })),
  interrupts: Schema.NullOr(PendingInterrupts),
});
export type ChatSnapshot = typeof ChatSnapshot.Type;

/** How many messages a page of the conversation holds at most. */
export const maxPageSize = 500;

const PageSize = Schema.FiniteFromString.pipe(
  Schema.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: maxPageSize })),
);

/** The header a page sends with every change it makes to a session, as the server reads it. */
const holderHeader = "x-session-holder" satisfies Lowercase<typeof sessionHolderHeader>;

export class ChatGroup extends HttpApiGroup.make("chat").add(
  /** The newest `limit` messages, or those before `before`, with the run and approvals pending. */
  HttpApiEndpoint.get("snapshot", "/api/sessions/:session/messages", {
    params: { session: Schema.String },
    query: { limit: PageSize, before: Schema.optional(Schema.String) },
    success: ChatSnapshot,
    error: refusals,
  }),
  /** Starts a run and streams its events from the start. */
  HttpApiEndpoint.post("run", "/api/sessions/:session/runs", {
    params: { session: Schema.String },
    headers: { [holderHeader]: Schema.optional(Schema.String) },
    payload: RunInput,
    success: RunEvents,
    error: refusals,
  }).middleware(SameSite),
  /** Follows a run's events after `after`, or from the start; a reload or a second tab uses it. */
  HttpApiEndpoint.get("join", "/api/sessions/:session/runs/:run/events", {
    params: { session: Schema.String, run: Schema.String },
    query: { after: Schema.optional(Schema.String) },
    success: RunEvents,
    error: refusals,
  }),
) {}

export class ChatApi extends HttpApi.make("chat").add(ChatGroup) {}
