import type { AppChangedEvent } from "./contracts";

import { appQueryKeys, type AppQueryKey } from "../queries/keys";
export { appQueryKeys, type AppQueryKey } from "../queries/keys";

export function invalidationKeys(event: AppChangedEvent): readonly AppQueryKey[] {
  if (event.scope === "global") {
    if (event.topic === "all") return [appQueryKeys.global.root];
    return [appQueryKeys.global[event.topic]];
  }
  if (event.scope === "project") {
    if (event.topic === "all") return [appQueryKeys.project.root(event.projectId)];
    return [appQueryKeys.project.sessions(event.projectId)];
  }
  if (event.topic === "all") return [appQueryKeys.session.root(event.projectId, event.sessionId)];
  if (event.topic === "run-state")
    return [appQueryKeys.session.runState(event.projectId, event.sessionId)];
  if (event.topic === "queue")
    return [appQueryKeys.session.queue(event.projectId, event.sessionId)];
  if (event.topic === "subagents")
    return [appQueryKeys.session.subagents(event.projectId, event.sessionId)];
  return [appQueryKeys.session.approvals(event.projectId, event.sessionId)];
}
