export type AppQueryKey = readonly unknown[];

export const appQueryKeys = {
  root: ["app"] as const,
  global: {
    root: ["app", "global"] as const,
    auth: ["app", "global", "auth"] as const,
    imports: ["app", "global", "imports"] as const,
    embedding: ["app", "global", "embedding"] as const,
    imageSettings: ["app", "global", "image-settings"] as const,
    kagi: ["app", "global", "kagi"] as const,
    modelsRoot: ["app", "global", "models"] as const,
    models: (provider: string) => [...appQueryKeys.global.modelsRoot, provider] as const,
    projects: ["app", "global", "projects"] as const,
  },
  project: {
    root: (projectId: string) => ["app", "project", projectId] as const,
    sessions: (projectId: string) => ["app", "project", projectId, "sessions"] as const,
    mcp: (projectId: string) => ["app", "project", projectId, "mcp"] as const,
    agents: (projectId: string) => ["app", "project", projectId, "agents"] as const,
    skills: (projectId: string) => ["app", "project", projectId, "skills"] as const,
    trace: (projectId: string) => ["app", "project", projectId, "trace"] as const,
    traceTask: (projectId: string, taskId: string) =>
      ["app", "project", projectId, "trace", "task", taskId] as const,
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
    trace: (projectId: string, sessionId: string) =>
      [...appQueryKeys.session.root(projectId, sessionId), "trace"] as const,
  },
};
