import { createContext, useContext } from "react";
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
