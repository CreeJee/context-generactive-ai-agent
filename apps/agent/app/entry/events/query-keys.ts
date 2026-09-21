import type { AppChangedEvent } from "./contracts";

export type AppQueryKey = readonly unknown[];

export const appQueryKeys = {
  root: ["app"] as const,
  global: {
    root: ["app", "global"] as const,
    auth: ["app", "global", "auth"] as const,
    imports: ["app", "global", "imports"] as const,
    embedding: ["app", "global", "embedding"] as const,
    projects: ["app", "global", "projects"] as const,
  },
  project: {
    root: (projectId: string) => ["app", "project", projectId] as const,
    sessions: (projectId: string) => ["app", "project", projectId, "sessions"] as const,
  },
  session: {
    root: (projectId: string, sessionId: string) =>
      ["app", "project", projectId, "session", sessionId] as const,
    runState: (projectId: string, sessionId: string) =>
      [...appQueryKeys.session.root(projectId, sessionId), "run-state"] as const,
    queue: (projectId: string, sessionId: string) =>
      [...appQueryKeys.session.root(projectId, sessionId), "queue"] as const,
    subagents: (projectId: string, sessionId: string) =>
      [...appQueryKeys.session.root(projectId, sessionId), "subagents"] as const,
    approvals: (projectId: string, sessionId: string) =>
      [...appQueryKeys.session.root(projectId, sessionId), "relayed-approvals"] as const,
  },
};

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
