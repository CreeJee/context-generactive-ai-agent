import type { UIMessage } from "@tanstack/ai-react";
import type { AuthState, CodexModel, ModelSelection, Project, Session } from "memory-agent";

export type { AuthState, CodexModel, ModelSelection, Project, Session };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly reason: string | null,
  ) {
    super(code);
  }
}

interface ErrorBody {
  error?: string;
  reason?: string;
}

type JsonBody = Readonly<Record<string, string | undefined>>;

async function call<T>(method: "GET" | "POST", path: string, body?: JsonBody): Promise<T> {
  const response = await fetch(
    path,
    method === "POST"
      ? {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body ?? {}),
        }
      : { method },
  );
  const json: T & ErrorBody = await response.json();
  if (!response.ok)
    throw new ApiError(response.status, json.error ?? "request_failed", json.reason ?? null);
  return json;
}

export const api = {
  auth: () => call<AuthState>("GET", "/api/auth"),
  authAction: (intent: "login" | "cancel" | "logout") =>
    call<AuthState>("POST", "/api/auth", { intent }),

  models: () =>
    call<{ models: CodexModel[]; selected: ModelSelection | null }>("GET", "/api/models"),
  selectModel: (model: string, reasoningEffort?: string) =>
    call<ModelSelection>("POST", `/api/models/${encodeURIComponent(model)}`, { reasoningEffort }),

  projects: () => call<Project[]>("GET", "/api/projects"),
  addProject: (root: string) => call<Project>("POST", "/api/projects", { root }),

  sessions: (projectId: string) =>
    call<Session[]>("GET", `/api/sessions?project=${encodeURIComponent(projectId)}`),
  createSession: (projectId: string) => call<Session>("POST", "/api/sessions", { projectId }),
  messages: (sessionId: string) =>
    call<UIMessage[]>("GET", `/api/sessions/${encodeURIComponent(sessionId)}/messages`),
};

const projectRejections = new Map([
  ["not_found", "경로를 찾을 수 없어요."],
  ["not_directory", "폴더 경로가 아니에요."],
  ["overlaps_storage", "앱 저장소 폴더와 겹치는 경로는 등록할 수 없어요."],
  ["already_registered", "이미 등록된 프로젝트예요."],
]);

export function projectErrorMessage(error: Error) {
  if (error instanceof ApiError && error.reason)
    return projectRejections.get(error.reason) ?? error.reason;
  return "프로젝트를 추가하지 못했어요.";
}
