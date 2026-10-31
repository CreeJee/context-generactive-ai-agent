import { Schema } from "effect";

/**
 * The invalidation events a page follows, as the server sends them over SSE. This module imports
 * no server code, so the browser bundle can use it.
 */

export const SessionEventTopic = Schema.Literals([
  "all",
  "run-state",
  "queue",
  "subagents",
  "relayed-approvals",
]);
export type SessionEventTopic = typeof SessionEventTopic.Type;

export const ProjectEventTopic = Schema.Literals(["all", "sessions"]);
export type ProjectEventTopic = typeof ProjectEventTopic.Type;

export const GlobalEventTopic = Schema.Literals([
  "all",
  "auth",
  "imports",
  "embedding",
  "projects",
  "kanban",
]);
export type GlobalEventTopic = typeof GlobalEventTopic.Type;

const Revision = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));

/** Something the page shows changed; the page reloads the queries of its scope and topic. */
export const AppChangedEvent = Schema.Union([
  Schema.Struct({
    scope: Schema.Literal("session"),
    projectId: Schema.String,
    sessionId: Schema.String,
    topic: SessionEventTopic,
    revision: Revision,
  }),
  Schema.Struct({
    scope: Schema.Literal("project"),
    projectId: Schema.String,
    topic: ProjectEventTopic,
    revision: Revision,
  }),
  Schema.Struct({
    scope: Schema.Literal("global"),
    topic: GlobalEventTopic,
    revision: Revision,
  }),
]);
export type AppChangedEvent = typeof AppChangedEvent.Type;

/** The revision a stream starts after: the page reloads what it read before it. */
export const AppReadyEvent = Schema.Struct({ revision: Revision });
export type AppReadyEvent = typeof AppReadyEvent.Type;

/** Nothing changed for a while; keeps the connection open. */
export const AppHeartbeatEvent = Schema.Struct({
  at: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type AppHeartbeatEvent = typeof AppHeartbeatEvent.Type;

/** One SSE event of an invalidation stream: `ready` first, then `changed` and `heartbeat`. */
export const AppEventFrame = Schema.Union([
  Schema.Struct({ event: Schema.Literal("ready"), data: Schema.fromJsonString(AppReadyEvent) }),
  Schema.Struct({
    /** The change's revision. */
    id: Schema.String,
    event: Schema.Literal("changed"),
    data: Schema.fromJsonString(AppChangedEvent),
  }),
  Schema.Struct({
    event: Schema.Literal("heartbeat"),
    data: Schema.fromJsonString(AppHeartbeatEvent),
  }),
]);
export type AppEventFrame = typeof AppEventFrame.Type;
