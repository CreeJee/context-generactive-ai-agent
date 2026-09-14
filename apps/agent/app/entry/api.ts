import type {
  Attachment,
  AuthState,
  CodexModel,
  ModelSelection,
  PermissionMode,
  Project,
  Session,
} from "memory-agent";
import {
  sessionHolderHeader,
  type CancelResult,
  type LeaseView,
  type SessionRunState,
} from "memory-agent/definitions";

export type {
  Attachment,
  AuthState,
  CancelResult,
  CodexModel,
  LeaseView,
  ModelSelection,
  PermissionMode,
  Project,
  Session,
  SessionRunState,
};

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

async function call<T>(
  method: "GET" | "POST",
  path: string,
  body?: JsonBody,
  headers: Readonly<Record<string, string>> = {},
): Promise<T> {
  const response = await fetch(
    path,
    method === "POST"
      ? {
          method,
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(body ?? {}),
        }
      : { method, headers },
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
  setPermissionMode: (projectId: string, permissionMode: PermissionMode) =>
    call<Project>("POST", `/api/projects/${encodeURIComponent(projectId)}`, { permissionMode }),

  sessions: (projectId: string) =>
    call<Session[]>("GET", `/api/sessions?project=${encodeURIComponent(projectId)}`),
  createSession: (projectId: string) => call<Session>("POST", "/api/sessions", { projectId }),
  sessionRunState: (sessionId: string, holder: string) =>
    call<SessionRunState>(
      "GET",
      `/api/sessions/${encodeURIComponent(sessionId)}?holder=${encodeURIComponent(holder)}`,
    ),
  cancelRun: (sessionId: string, holder: string) =>
    call<CancelResult>(
      "POST",
      `/api/sessions/${encodeURIComponent(sessionId)}/cancel`,
      {},
      { [sessionHolderHeader]: holder },
    ),
  leaseAction: (sessionId: string, holder: string, action: "claim" | "release") =>
    call<LeaseView>("POST", `/api/sessions/${encodeURIComponent(sessionId)}/lease`, {
      holder,
      action,
    }),

  /** Uploads one image as raw bytes; the server checks what it really is. */
  uploadAttachment: async (file: File) => {
    const response = await fetch("/api/attachments", {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    });
    const json: Attachment & ErrorBody = await response.json();
    if (!response.ok)
      throw new ApiError(response.status, json.error ?? "upload_failed", json.reason ?? null);
    return json;
  },
};

const attachmentRejections = new Map([
  ["too_large", "20MB보다 큰 이미지는 올릴 수 없어요."],
  ["unsupported_type", "PNG, JPEG, GIF, WebP 이미지만 올릴 수 있어요."],
  ["empty", "빈 파일이에요."],
]);

export function attachmentErrorMessage(error: Error) {
  if (error instanceof ApiError && error.reason)
    return attachmentRejections.get(error.reason) ?? error.reason;
  return "이미지를 올리지 못했어요.";
}

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
