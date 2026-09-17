import type {
  Attachment,
  AuthState,
  CodexModel,
  EmbeddingChoice,
  EmbeddingOverview,
  ExternalAgentsOverview,
  ExternalAgentView,
  GpuState,
  ImportActivity,
  ImportOverview,
  KagiStatus,
  McpOverview,
  McpScope,
  McpServerView,
  ModelSelection,
  PermissionMode,
  Project,
  Session,
  SkillCatalog,
} from "memory-agent";
import type { ModelMessage } from "@tanstack/ai";
import type { UIMessage } from "@tanstack/ai-react";
import { Schema } from "effect";
import {
  sessionHolderHeader,
  type CancelResult,
  type CompactResult,
  type ContextView,
  type LeaseView,
  type QueueEdit,
  type QueuedMessage,
  type SessionRunState,
  type ApprovalRequester,
  type RelayedApprovalView,
  type SubagentView,
} from "memory-agent/definitions";

export type {
  Attachment,
  AuthState,
  CancelResult,
  CodexModel,
  CompactResult,
  ContextView,
  EmbeddingChoice,
  EmbeddingOverview,
  ExternalAgentsOverview,
  ExternalAgentView,
  GpuState,
  ImportActivity,
  ImportOverview,
  KagiStatus,
  LeaseView,
  McpOverview,
  McpScope,
  McpServerView,
  ModelSelection,
  PermissionMode,
  Project,
  QueueEdit,
  QueuedMessage,
  Session,
  SessionRunState,
  SkillCatalog,
  ApprovalRequester,
  RelayedApprovalView,
  SubagentView,
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

type JsonBody = Readonly<Record<string, string | boolean | readonly string[] | undefined>>;

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
  setCrossRecallExcluded: (projectId: string, crossRecallExcluded: boolean) =>
    call<Project>("POST", `/api/projects/${encodeURIComponent(projectId)}`, {
      crossRecallExcluded,
    }),
  setPermissionMode: (projectId: string, permissionMode: PermissionMode) =>
    call<Project>("POST", `/api/projects/${encodeURIComponent(projectId)}`, { permissionMode }),
  /** Takes a project out of the sidebar. Its memory stays and adding the folder again brings it back. */
  hideProject: (projectId: string) =>
    call<Project>("POST", `/api/projects/${encodeURIComponent(projectId)}`, { hidden: true }),

  sessions: (projectId: string) =>
    call<Session[]>("GET", `/api/sessions?project=${encodeURIComponent(projectId)}`),
  archivedSessions: (projectId: string) =>
    call<Session[]>("GET", `/api/sessions?project=${encodeURIComponent(projectId)}&archived=1`),
  /** Refused with 409 while it is answering and 423 while another page holds it. */
  setArchived: (sessionId: string, holder: string, archived: boolean) =>
    call<Session>(
      "POST",
      `/api/sessions/${encodeURIComponent(sessionId)}`,
      { archived },
      { [sessionHolderHeader]: holder },
    ),
  /** `agent`: talk directly to that trusted external ACP agent instead of the app's model. */
  createSession: (projectId: string, agent?: string) =>
    call<Session>("POST", "/api/sessions", { projectId, agent }),
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
  /** Refused with 409 while the session is answering. */
  compactSession: (sessionId: string, holder: string) =>
    call<CompactResult>(
      "POST",
      `/api/sessions/${encodeURIComponent(sessionId)}/compact`,
      {},
      { [sessionHolderHeader]: holder },
    ),
  leaseAction: (sessionId: string, holder: string, action: "claim" | "release") =>
    call<LeaseView>("POST", `/api/sessions/${encodeURIComponent(sessionId)}/lease`, {
      holder,
      action,
    }),

  queue: (sessionId: string) =>
    call<QueuedMessage[]>("GET", `/api/sessions/${encodeURIComponent(sessionId)}/queue`),
  enqueue: (
    sessionId: string,
    holder: string,
    message: { text: string; attachmentIds: readonly string[]; mode: "queue" | "steer" },
  ) =>
    call<QueuedMessage>("POST", `/api/sessions/${encodeURIComponent(sessionId)}/queue`, message, {
      [sessionHolderHeader]: holder,
    }),
  editQueued: (sessionId: string, holder: string, id: string, edit: QueueEdit) =>
    call<QueuedMessage | null>(
      "POST",
      `/api/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(id)}`,
      edit,
      { [sessionHolderHeader]: holder },
    ),
  /** The saved conversation, as the page hydrates it (used to catch up after queued deliveries). */
  transcript: (sessionId: string) =>
    call<{ messages: UIMessage[] }>(
      "GET",
      `/api/chat?session=${encodeURIComponent(sessionId)}&threadId=${encodeURIComponent(sessionId)}`,
    ),

  kagi: () => call<KagiStatus>("GET", "/api/settings/kagi"),
  kagiAction: (
    command: { action: "register"; key: string } | { action: "remove" | "enable" | "disable" },
  ) => call<KagiStatus>("POST", "/api/settings/kagi", command),

  imports: () => call<ImportOverview>("GET", "/api/settings/imports"),
  importAction: (
    command: { action: "run" | "enable" | "disable" } | { action: "interpret"; interpret: boolean },
  ) => call<ImportOverview>("POST", "/api/settings/imports", command),

  embedding: () => call<EmbeddingOverview>("GET", "/api/settings/embedding"),
  embeddingAction: (command: { action: "choose"; choice: EmbeddingChoice } | { action: "check" }) =>
    call<EmbeddingOverview>("POST", "/api/settings/embedding", command),

  mcpServers: (projectId: string) =>
    call<McpOverview>("GET", `/api/projects/${encodeURIComponent(projectId)}/mcp`),
  setMcpTrusted: (projectId: string, scope: McpScope, name: string, trusted: boolean) =>
    call<McpOverview>("POST", `/api/projects/${encodeURIComponent(projectId)}/mcp`, {
      scope,
      name,
      trusted,
    }),

  externalAgents: (projectId: string) =>
    call<ExternalAgentsOverview>("GET", `/api/projects/${encodeURIComponent(projectId)}/agents`),
  trustExternalAgent: (
    projectId: string,
    scope: ExternalAgentView["scope"],
    name: string,
    trusted: boolean,
  ) =>
    call<ExternalAgentsOverview>("POST", `/api/projects/${encodeURIComponent(projectId)}/agents`, {
      action: "trust",
      scope,
      name,
      trusted,
    }),
  /** Names of external agents a new conversation in this project can talk to directly. */
  usableExternalAgents: async (projectId: string) =>
    (await api.externalAgents(projectId)).agents
      .filter((agent) => !agent.shadowed && agent.state.status === "trusted")
      .map((agent) => agent.name),
  reconnectExternalAgent: (projectId: string, name: string) =>
    call<ExternalAgentsOverview>("POST", `/api/projects/${encodeURIComponent(projectId)}/agents`, {
      action: "reconnect",
      name,
    }),

  skills: (projectId: string) =>
    call<SkillCatalog>("GET", `/api/projects/${encodeURIComponent(projectId)}/skills`),

  subagents: (sessionId: string) =>
    call<SubagentView[]>("GET", `/api/sessions/${encodeURIComponent(sessionId)}/subagents`),
  relayedApprovals: (sessionId: string) =>
    call<RelayedApprovalView[]>("GET", `/api/sessions/${encodeURIComponent(sessionId)}/approvals`),
  subagentTranscript: (sessionId: string, subagentId: string) =>
    call<{ subagent: SubagentView; messages: ModelMessage[] }>(
      "GET",
      `/api/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(subagentId)}`,
    ),
  answerApproval: (sessionId: string, holder: string, approvalId: string, approved: boolean) =>
    call<RelayedApprovalView[]>(
      "POST",
      `/api/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}`,
      { approved },
      { [sessionHolderHeader]: holder },
    ),

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

const AttachmentRejection = Schema.Literal("too_large", "unsupported_type", "empty");
const attachmentRejections = {
  too_large: "20MB보다 큰 이미지는 올릴 수 없어요.",
  unsupported_type: "PNG, JPEG, GIF, WebP 이미지만 올릴 수 있어요.",
  empty: "빈 파일이에요.",
} satisfies Record<typeof AttachmentRejection.Type, string>;

export function attachmentErrorMessage(error: Error) {
  if (!(error instanceof ApiError) || !error.reason) return "이미지를 올리지 못했어요.";
  return Schema.is(AttachmentRejection)(error.reason)
    ? attachmentRejections[error.reason]
    : error.reason;
}

const ProjectRejection = Schema.Literal(
  "not_found",
  "not_directory",
  "overlaps_storage",
  "already_registered",
);
const projectRejections = {
  not_found: "경로를 찾을 수 없어요.",
  not_directory: "폴더 경로가 아니에요.",
  overlaps_storage: "앱 저장소 폴더와 겹치는 경로는 등록할 수 없어요.",
  already_registered: "이미 등록된 프로젝트예요.",
} satisfies Record<typeof ProjectRejection.Type, string>;

export function projectErrorMessage(error: Error) {
  if (!(error instanceof ApiError) || !error.reason) return "프로젝트를 추가하지 못했어요.";
  return Schema.is(ProjectRejection)(error.reason) ? projectRejections[error.reason] : error.reason;
}

const ArchiveRejection = Schema.Literal("run_in_progress", "session_in_use", "session_not_found");
const archiveRejections = {
  run_in_progress: "답변 중인 대화는 보관할 수 없어요. 끝나거나 멈춘 뒤 다시 시도하세요.",
  session_in_use: "다른 탭에서 쓰고 있는 대화예요. 그 탭을 닫은 뒤 다시 시도하세요.",
  session_not_found: "대화를 찾을 수 없어요.",
} satisfies Record<typeof ArchiveRejection.Type, string>;

export function archiveErrorMessage(error: Error) {
  return error instanceof ApiError && Schema.is(ArchiveRejection)(error.code)
    ? archiveRejections[error.code]
    : "대화를 바꾸지 못했어요.";
}

/** A context update a run sends while it answers. */
export const decodeContextEvent = Schema.decodeUnknownOption(
  Schema.Struct({
    usedTokens: Schema.NullOr(Schema.Number),
    windowTokens: Schema.Number,
    compactAtTokens: Schema.Number,
  }),
);

const CompactRejection = Schema.Literal("run_in_progress", "session_in_use", "session_not_found");
const compactRejections = {
  run_in_progress: "답변이 끝난 뒤에 비울 수 있어요.",
  session_in_use: "다른 탭에서 쓰고 있는 대화예요. 그 탭에서 다시 시도하세요.",
  session_not_found: "대화를 찾을 수 없어요.",
} satisfies Record<typeof CompactRejection.Type, string>;

export function compactErrorMessage(error: Error) {
  return error instanceof ApiError && Schema.is(CompactRejection)(error.code)
    ? compactRejections[error.code]
    : "도구 출력을 비우지 못했어요.";
}
