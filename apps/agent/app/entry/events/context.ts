import { Schema } from "effect";
import { createContext, useContext } from "react";
import { isTruthy } from "../../truthy.ts";
import type { EventConnectionState } from "./event-source";

export const EventConnectionContext = createContext<EventConnectionState>("connecting");
export const SessionEventScopeContext = createContext<{
  readonly projectId: string | null;
  readonly sessionId: string | null;
}>({ projectId: null, sessionId: null });

export function useEventConnection() {
  return useContext(EventConnectionContext);
}

export function useSessionEventScope() {
  return useContext(SessionEventScopeContext);
}

/** A session view rendered outside a project's event scope: a mistake in the page tree. */
export class ProjectScopeMissing extends Schema.TaggedError<
  ProjectScopeMissing,
  { readonly brand: unique symbol }
>()("ProjectScopeMissing", {
  consumer: Schema.Literals([
    "chat",
    "delegated_work",
    "message_queue",
    "relayed_approval",
    "run_state",
    "session_lease",
    "work_trace",
  ]),
}) {}

/** The active project of a session view. React render cannot return a failure, so none throws. */
export function useProjectScope(consumer: ProjectScopeMissing["consumer"]) {
  const { projectId } = useSessionEventScope();
  if (!isTruthy(projectId)) throw ProjectScopeMissing.make({ consumer });
  return projectId;
}
