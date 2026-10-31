import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import {
  LifecycleIntent,
  LifecycleResult,
  ResumeTaskResult,
  TraceEventsLost,
  TraceStreamEvent,
  TraceTaskDetail,
  TraceTreeSnapshot,
} from "../../work-trace/contracts.ts";
import { sessionHolderHeaders } from "../chat-api.ts";
import { appRefusalFields, refusalWith, SameSite } from "../refusal.ts";
import { LifecycleBlocked } from "./sessions.ts";

const appRefusal = refusalWith(appRefusalFields);

/**
 * What the page asks of one task: retry it from the attempt it saw, or archive, restore or delete
 * it. A retried change with the same `idempotencyKey` answers the first one's operation.
 */
export const TraceTaskChange = Schema.Union([
  Schema.Struct({
    intent: Schema.Literal("resume"),
    expectedAttemptId: Schema.String,
    /** The user accepts that the attempt's unsettled tool calls may run again. */
    confirmUncertain: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    intent: LifecycleIntent,
    idempotencyKey: Schema.optionalKey(Schema.String),
  }),
]);
export type TraceTaskChange = typeof TraceTaskChange.Type;

/** Work Trace is turned off in the settings. */
const WorkTraceDisabled = appRefusal(404, ["work_trace_disabled"]);

/** The settings that turn Work Trace on could not be read. */
const SettingsUnavailable = appRefusal(500, ["settings_unavailable"]);

/** The session the path names does not exist. */
const UnknownSession = appRefusal(404, ["session_not_found"]);

/** The project the path names is not registered. */
const UnknownProject = appRefusal(404, ["project_not_found"]);

/** The session or project has no such task. */
const UnknownTask = appRefusal(404, ["trace_task_not_found"]);

/** Another page holds the session. */
const SessionInUse = appRefusal(423, ["session_in_use"]);

/** The retry cannot start; `reason` says why. */
const ResumeBlocked = ResumeTaskResult.cases.blocked.pipe(HttpApiSchema.status(409));

/** Every refusal of the group, for `appRefusalStatus`. */
export const traceRefusals = [
  WorkTraceDisabled,
  SettingsUnavailable,
  UnknownSession,
  UnknownProject,
  UnknownTask,
  SessionInUse,
];

const task = { task: Schema.String };

/** A trace cursor: the events after it are sent. */
const TraceCursor = Schema.FiniteFromString.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
);

/**
 * What subagents did, kept after their conversation ends (`/api/sessions/:session/trace*`), and
 * the project's own copy, kept after the conversation is deleted (`/api/projects/:project/trace*`).
 */
export class TraceGroup extends HttpApiGroup.make("trace")
  .add(
    /** The session's tasks and the trace cursor the page streams on from. */
    HttpApiEndpoint.get("sessionTree", "/api/sessions/:session/trace", {
      params: { session: Schema.String },
      success: TraceTreeSnapshot,
      error: [WorkTraceDisabled, SettingsUnavailable, UnknownSession],
    }),
    /**
     * The session's trace events after `after`, or after `Last-Event-ID` when the browser
     * reconnects without one, then each new one; `progress` asks the page to reread the tree.
     */
    HttpApiEndpoint.get("sessionStream", "/api/sessions/:session/trace/stream", {
      params: { session: Schema.String },
      query: { after: Schema.optional(TraceCursor) },
      headers: { "last-event-id": Schema.optional(TraceCursor) },
      success: HttpApiSchema.StreamSse({ events: TraceStreamEvent, error: TraceEventsLost }),
      error: [WorkTraceDisabled, SettingsUnavailable, UnknownSession],
    }),
    /** One task's attempts, checkpoints, visible events and the memories it proposed or used. */
    HttpApiEndpoint.get("sessionTask", "/api/sessions/:session/trace/tasks/:task", {
      params: { session: Schema.String, ...task },
      success: TraceTaskDetail,
      error: [WorkTraceDisabled, SettingsUnavailable, UnknownSession, UnknownTask],
    }),
    /**
     * Queues a retry for the next valid parent run (202), or archives, restores or deletes the
     * task. A change still waiting for the task's live attempt to stop, or blocked on the way, is
     * answered 202; a retry or a change that cannot start, 409.
     */
    HttpApiEndpoint.post("changeTask", "/api/sessions/:session/trace/tasks/:task", {
      params: { session: Schema.String, ...task },
      headers: sessionHolderHeaders,
      payload: TraceTaskChange,
      success: [
        LifecycleResult.cases.completed,
        LifecycleResult.cases.waiting_for_stop.pipe(HttpApiSchema.status(202)),
        LifecycleResult.cases.blocked.pipe(HttpApiSchema.status(202)),
        ResumeTaskResult.cases.queued.pipe(HttpApiSchema.status(202)),
      ],
      error: [
        WorkTraceDisabled,
        SettingsUnavailable,
        UnknownSession,
        SessionInUse,
        LifecycleBlocked,
        ResumeBlocked,
      ],
    }),
    /** The project's tasks, including those whose conversation was deleted. */
    HttpApiEndpoint.get("projectTree", "/api/projects/:project/trace", {
      params: { project: Schema.String },
      success: TraceTreeSnapshot,
      error: [WorkTraceDisabled, SettingsUnavailable, UnknownProject],
    }),
    /** One project task, also after its conversation was deleted. */
    HttpApiEndpoint.get("projectTask", "/api/projects/:project/trace/tasks/:task", {
      params: { project: Schema.String, ...task },
      success: TraceTaskDetail,
      error: [WorkTraceDisabled, SettingsUnavailable, UnknownProject, UnknownTask],
    }),
  )
  .middleware(SameSite) {}
