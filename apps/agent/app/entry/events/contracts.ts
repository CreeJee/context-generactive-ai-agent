import { Schema } from "effect";

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
]);
export type GlobalEventTopic = typeof GlobalEventTopic.Type;

const Revision = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));

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

export const AppReadyEvent = Schema.Struct({
  revision: Revision,
});
export type AppReadyEvent = typeof AppReadyEvent.Type;

export const AppHeartbeatEvent = Schema.Struct({
  at: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type AppHeartbeatEvent = typeof AppHeartbeatEvent.Type;
