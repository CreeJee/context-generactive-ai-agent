import type { AppChangedEvent } from "./contracts";

import { appQueryKeys, type AppQueryKey } from "../queries/keys";
export { appQueryKeys, type AppQueryKey } from "../queries/keys";

export function invalidationKeys(event: AppChangedEvent): readonly AppQueryKey[] {
  if (event.scope === "global") {
    if (event.topic === "all") return [appQueryKeys.global.root];
    // Sign-in state decides which accounts exist and which one is used.
    if (event.topic === "auth") return [appQueryKeys.global.auth, appQueryKeys.global.accountsRoot];
    return [appQueryKeys.global[event.topic]];
  }
  if (event.scope === "project") {
    if (event.topic === "all") return [appQueryKeys.project.root(event.projectId)];
    return [appQueryKeys.project.sessions(event.projectId)];
  }
  if (event.topic === "all") return [appQueryKeys.session.root(event.projectId, event.sessionId)];
  // Board changes are saved Plan changes, so they arrive as run-state too. Card decisions move
  // cards, so the board's and the project inbox's decisions follow them.
  if (event.topic === "run-state")
    return [
      appQueryKeys.session.runState(event.projectId, event.sessionId),
      appQueryKeys.session.board(event.projectId, event.sessionId),
      appQueryKeys.session.decisions(event.projectId, event.sessionId),
      appQueryKeys.project.decisions(event.projectId),
      appQueryKeys.session.kanban(event.projectId, event.sessionId),
    ];
  if (event.topic === "queue")
    return [appQueryKeys.session.queue(event.projectId, event.sessionId)];
  if (event.topic === "subagents")
    return [appQueryKeys.session.subagents(event.projectId, event.sessionId)];
  return [appQueryKeys.session.approvals(event.projectId, event.sessionId)];
}
