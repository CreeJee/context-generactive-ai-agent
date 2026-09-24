import type {
  Attachment,
  ProviderModel,
  EmbeddingChoice,
  EmbeddingOverview,
  ExternalAgentsOverview,
  ExternalAgentView,
  GpuState,
  ImportActivity,
  ImportOverview,
  ImageFeatureStatus,
  ImageMediaAsset,
  KagiStatus,
  McpOverview,
  McpScope,
  CrossProviderMediaConsentMode,
  CrossProviderMediaConsentSettings,
  CrossProviderMediaRunApproval,
  McpServerView,
  ModelSelection,
  PermissionMode,
  Project,
  ProviderId,
  Session,
  SkillCatalog,
  TraceTaskDetail,
  TraceTreeSnapshot,
  WorkflowAction,
  WorkflowPhase,
  WorkflowState,
} from "memory-agent";
import type { ModelMessage } from "@tanstack/ai";
import type { UIMessage } from "@tanstack/ai-react";
import { Option, Schema } from "effect";
import { appFetch } from "./shared/backend-restart";
import {
  sessionHolderHeader,
  type CancelResult,
  type CompactResult,
  type ContextView,
  type LeaseView,
  type QueueEdit,
  type QueuedMessage,
  type QueueSnapshot,
  type SessionRunState,
  type ApprovalRequester,
  type RelayedApprovalView,
  type SubagentView,
} from "memory-agent/definitions";

export type GeneratedImageAsset = ImageMediaAsset & { readonly url: string };
export type ImageSettingsView = ImageFeatureStatus & {
  readonly crossProviderMediaConsent: CrossProviderMediaConsentSettings;
};

export type ProviderAuthState =
  | { readonly provider: ProviderId; readonly status: "signed-out" }
  | {
      readonly provider: ProviderId;
      readonly status: "pending";
      readonly authUrl: string;
    }
  | {
      readonly provider: ProviderId;
      readonly status: "signed-in";
      readonly planType?: string;
    }
  | {
      readonly provider: ProviderId;
      readonly status: "error";
      readonly message: string;
    };

export type {
  Attachment,
  CancelResult,
  ProviderModel,
  CompactResult,
  ContextView,
  EmbeddingChoice,
  EmbeddingOverview,
  ExternalAgentsOverview,
  ExternalAgentView,
  GpuState,
  ImportActivity,
  ImportOverview,
  ImageFeatureStatus,
  ImageMediaAsset,
  KagiStatus,
  LeaseView,
  McpOverview,
  McpScope,
  CrossProviderMediaConsentMode,
  CrossProviderMediaConsentSettings,
  CrossProviderMediaRunApproval,
  McpServerView,
  ModelSelection,
  PermissionMode,
  Project,
  ProviderId,
  QueueEdit,
  QueuedMessage,
  QueueSnapshot,
  Session,
  SessionRunState,
  SkillCatalog,
  ApprovalRequester,
  RelayedApprovalView,
  SubagentView,
  WorkflowAction,
  WorkflowPhase,
  WorkflowState,
};

/** Every error code the browser API currently understands, including local fallbacks. */
export const ApiErrorCode = Schema.Literal(
  "approval_not_pending",
  "attachment_not_found",
  "attachment_rejected",
  "auth_failed",
  "backend_restart_required",
  "backend_restarting",
  "cross_site_request",
  "empty_message",
  "external_agent_unavailable",
  "goal_missing",
  "goal_not_active",
  "goal_not_paused",
  "goal_terminal",
  "images_not_supported",
  "image_approval_required",
  "image_direct_workflow_required",
  "image_execution_failed",
  "image_feature_unavailable",
  "image_route_unavailable",
  "invalid_agent_change",
  "invalid_answer",
  "invalid_chat_request",
  "invalid_embedding_action",
  "invalid_import_action",
  "invalid_image_request",
  "invalid_image_settings_action",
  "invalid_intent",
  "invalid_json",
  "invalid_kagi_action",
  "invalid_lease_request",
  "invalid_mcp_change",
  "invalid_origin",
  "invalid_project",
  "invalid_provider",
  "invalid_queue_edit",
  "invalid_queue_request",
  "invalid_selection",
  "invalid_session",
  "invalid_session_change",
  "invalid_settings",
  "invalid_stream_offset",
  "kagi_key_required",
  "keychain_failed",
  "login_required",
  "model_list_failed",
  "model_selection_required",
  "model_unavailable",
  "no_running_run",
  "no_user_turn",
  "not_running",
  "plan_not_ready",
  "plan_outdated",
  "project_not_found",
  "project_rejected",
  "project_required",
  "provider_unavailable",
  "queue_delivered",
  "queue_not_found",
  "queue_not_held",
  "queued_message_not_next",
  "request_failed",
  "run_in_progress",
  "run_not_found",
  "session_in_use",
  "session_not_found",
  "session_required",
  "steer_failed",
  "steer_unavailable",
  "subagent_not_found",
  "unknown_attachment",
  "upload_failed",
);
export type ApiErrorCode = typeof ApiErrorCode.Type;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    readonly reason: string | null,
    readonly approval?: CrossProviderMediaRunApproval,
  ) {
    super(code);
  }
}

const CrossProviderMediaRunApproval = Schema.Struct({
  runId: Schema.String,
  initiatorChatRouteId: Schema.TemplateLiteral(
    "chat:",
    Schema.Literal("openai", "anthropic"),
    ":",
    Schema.String,
  ),
  executorMediaRouteId: Schema.String,
  capability: Schema.Literal("media.image.generate"),
});
const ErrorBody = Schema.Struct({
  error: Schema.optional(ApiErrorCode),
  reason: Schema.optional(Schema.String),
  approval: Schema.optional(CrossProviderMediaRunApproval),
});
const decodeErrorBody = Schema.decodeUnknownOption(ErrorBody);
type ErrorBody = typeof ErrorBody.Type;
const ResumeTaskResult = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("queued"),
    jobId: Schema.String,
    taskId: Schema.String,
    expectedAttemptId: Schema.String,
  }),
  Schema.Struct({ status: Schema.Literal("blocked"), reason: Schema.String }),
);
const decodeResumeTaskResult = Schema.decodeUnknownOption(ResumeTaskResult);
type ResumeTaskResult = typeof ResumeTaskResult.Type;
const ArchiveTaskResult = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("completed"),
    operationId: Schema.optional(Schema.String),
    targetId: Schema.String,
    intent: Schema.optional(Schema.Literal("archive", "restore", "delete")),
    receiptId: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  Schema.Struct({ status: Schema.Literal("blocked"), blocker: Schema.String }),
  Schema.Struct({
    status: Schema.Literal("waiting_for_stop"),
    operationId: Schema.String,
    targetId: Schema.String,
  }),
);
const decodeArchiveTaskResult = Schema.decodeUnknownOption(ArchiveTaskResult);
type ArchiveTaskResult = typeof ArchiveTaskResult.Type;

const SessionSnapshot = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  title: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  agent: Schema.NullOr(Schema.String),
  archivedAt: Schema.NullOr(Schema.String),
  importedFrom: Schema.NullOr(Schema.String),
});
const decodeSessionSnapshot = Schema.decodeUnknownOption(SessionSnapshot);
type PendingSessionLifecycle = Exclude<ArchiveTaskResult, { status: "completed" }>;
type SessionArchiveResult = { status: "completed"; session: Session } | PendingSessionLifecycle;

async function changeSessionLifecycle(sessionId: string, holder: string, change: JsonBody) {
  const response = await appFetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { [sessionHolderHeader]: holder, "Content-Type": "application/json" },
    body: JSON.stringify({ ...change, idempotencyKey: crypto.randomUUID() }),
  });
  const body: unknown = await response.json();
  const result = Option.getOrUndefined(decodeArchiveTaskResult(body));
  if (response.status === 409 && result?.status === "blocked") return { response, body, result };
  if (!response.ok) throw apiError(response.status, Option.getOrUndefined(decodeErrorBody(body)));
  // Accepted is not completed, even if a malformed response claims otherwise.
  if (response.status === 202 && (!result || result.status === "completed"))
    throw apiError(502, undefined);
  return { response, body, result };
}

function apiError(
  status: number,
  body: ErrorBody | undefined,
  fallback: "request_failed" | "upload_failed" = "request_failed",
) {
  return new ApiError(status, body?.error ?? fallback, body?.reason ?? null, body?.approval);
}

type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | Readonly<{ [key: string]: JsonValue | undefined }>;
type JsonBody = Readonly<{ [key: string]: JsonValue | undefined }>;

async function call<T>(
  method: "GET" | "POST",
  path: string,
  body?: JsonBody,
  headers: Readonly<Record<string, string>> = {},
): Promise<T> {
  const response = await appFetch(
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
  if (!response.ok) {
    const failure = apiError(response.status, Option.getOrUndefined(decodeErrorBody(json)));
    throw failure;
  }
  return json;
}

export const api = {
  auth: (provider: ProviderId) =>
    call<ProviderAuthState>("GET", `/api/auth?provider=${encodeURIComponent(provider)}`),
  authAction: (intent: "login" | "cancel" | "logout", provider: ProviderId) =>
    call<ProviderAuthState>("POST", "/api/auth", { intent, provider }),

  models: (provider: ProviderId) =>
    call<{ models: ProviderModel[]; selected: ModelSelection | null }>(
      "GET",
      `/api/models?provider=${encodeURIComponent(provider)}`,
    ),
  selectModel: (model: string, reasoningEffort: string | undefined, provider: ProviderId) =>
    call<ModelSelection>("POST", `/api/models/${encodeURIComponent(model)}`, {
      provider,
      reasoningEffort,
    }),

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
  /** Active parent/child runs are checkpointed and stopped before the conversation is archived. */
  setArchived: async (
    sessionId: string,
    holder: string,
    archived: boolean,
  ): Promise<SessionArchiveResult> => {
    const { response, body, result } = await changeSessionLifecycle(sessionId, holder, {
      archived,
    });
    if (result && result.status !== "completed") return result;
    const session = Option.getOrUndefined(decodeSessionSnapshot(body));
    if (response.status !== 200 || !session || session.id !== sessionId)
      throw apiError(502, undefined);
    return { status: "completed", session };
  },
  deleteSession: async (sessionId: string, holder: string): Promise<ArchiveTaskResult> => {
    const { response, result } = await changeSessionLifecycle(sessionId, holder, { delete: true });
    if (!result || (result.status === "completed" && response.status !== 200))
      throw apiError(502, undefined);
    return result;
  },
  /** Refused while a run is active; execute requires a current Plan that is ready or executing. */
  setWorkflowPhase: (sessionId: string, holder: string, phase: WorkflowPhase) =>
    call<WorkflowState>(
      "POST",
      `/api/sessions/${encodeURIComponent(sessionId)}`,
      { phase },
      { [sessionHolderHeader]: holder },
    ),
  controlWorkflow: (sessionId: string, holder: string, workflowAction: WorkflowAction) =>
    call<WorkflowState>(
      "POST",
      `/api/sessions/${encodeURIComponent(sessionId)}`,
      { workflowAction },
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
  discardInterrupts: (sessionId: string, holder: string) =>
    call<{ discarded: number }>(
      "POST",
      `/api/sessions/${encodeURIComponent(sessionId)}/interrupts/discard`,
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
    call<QueueSnapshot>("GET", `/api/sessions/${encodeURIComponent(sessionId)}/queue`),
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

  imageSettings: () => call<ImageSettingsView>("GET", "/api/settings/image"),
  setImageGenerationEnabled: (enabled: boolean) =>
    call<ImageSettingsView>("POST", "/api/settings/image", {
      action: "image_generation",
      enabled,
    }),
  setCrossProviderMediaConsent: (mode: CrossProviderMediaConsentMode) =>
    call<ImageSettingsView>("POST", "/api/settings/image", {
      action: "cross_provider_media",
      mode,
    }),
  generateImage: (
    prompt: string,
    approved: boolean,
    crossProviderApproval?: CrossProviderMediaRunApproval,
  ) => {
    if (crossProviderApproval === undefined)
      return call<GeneratedImageAsset>("POST", "/api/media/image", { prompt, approved });
    return call<GeneratedImageAsset>("POST", "/api/media/image", {
      prompt,
      approved,
      runId: crossProviderApproval.runId,
      crossProviderApproval: {
        runId: crossProviderApproval.runId,
        initiatorChatRouteId: crossProviderApproval.initiatorChatRouteId,
        executorMediaRouteId: crossProviderApproval.executorMediaRouteId,
        capability: crossProviderApproval.capability,
      },
    });
  },

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
  reconnectExternalAgent: (projectId: string, name: string) =>
    call<ExternalAgentsOverview>("POST", `/api/projects/${encodeURIComponent(projectId)}/agents`, {
      action: "reconnect",
      name,
    }),

  skills: (projectId: string) =>
    call<SkillCatalog>("GET", `/api/projects/${encodeURIComponent(projectId)}/skills`),

  projectWorkTrace: (projectId: string) =>
    call<TraceTreeSnapshot>("GET", `/api/projects/${encodeURIComponent(projectId)}/trace`),
  projectWorkTraceTask: (projectId: string, taskId: string) =>
    call<TraceTaskDetail>(
      "GET",
      `/api/projects/${encodeURIComponent(projectId)}/trace/tasks/${encodeURIComponent(taskId)}`,
    ),
  workTrace: (sessionId: string) =>
    call<TraceTreeSnapshot>("GET", `/api/sessions/${encodeURIComponent(sessionId)}/trace`),
  workTraceTask: (sessionId: string, taskId: string) =>
    call<TraceTaskDetail>(
      "GET",
      `/api/sessions/${encodeURIComponent(sessionId)}/trace/tasks/${encodeURIComponent(taskId)}`,
    ),
  resumeWorkTraceTask: async (
    sessionId: string,
    holder: string,
    taskId: string,
    expectedAttemptId: string,
    confirmUncertain = false,
  ): Promise<ResumeTaskResult> => {
    const response = await fetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/trace/tasks/${encodeURIComponent(taskId)}`,
      {
        method: "POST",
        headers: { [sessionHolderHeader]: holder, "Content-Type": "application/json" },
        body: JSON.stringify({ intent: "resume", expectedAttemptId, confirmUncertain }),
      },
    );
    const body: unknown = await response.json();
    const result = Option.getOrUndefined(decodeResumeTaskResult(body));
    // A safety refusal is an expected action result, not a transport failure.
    if (response.status === 409 && result?.status === "blocked") return result;
    if (!response.ok) throw apiError(response.status, Option.getOrUndefined(decodeErrorBody(body)));
    if (!result || result.status !== "queued") throw apiError(502, undefined);
    return result;
  },
  archiveWorkTraceTask: async (
    sessionId: string,
    holder: string,
    taskId: string,
  ): Promise<ArchiveTaskResult> => {
    const response = await fetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/trace/tasks/${encodeURIComponent(taskId)}`,
      {
        method: "POST",
        headers: { [sessionHolderHeader]: holder, "Content-Type": "application/json" },
        body: JSON.stringify({ intent: "archive", idempotencyKey: crypto.randomUUID() }),
      },
    );
    const body: unknown = await response.json();
    const result = Option.getOrUndefined(decodeArchiveTaskResult(body));
    if (response.status === 409 && result?.status === "blocked") return result;
    if (!response.ok) throw apiError(response.status, Option.getOrUndefined(decodeErrorBody(body)));
    if (!result || (result.status !== "completed" && result.status !== "waiting_for_stop"))
      throw apiError(502, undefined);
    window.dispatchEvent(new CustomEvent("work-trace:changed"));
    return result;
  },
  deleteWorkTraceTask: async (
    sessionId: string,
    holder: string,
    taskId: string,
  ): Promise<ArchiveTaskResult> => {
    const response = await fetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/trace/tasks/${encodeURIComponent(taskId)}`,
      {
        method: "POST",
        headers: { [sessionHolderHeader]: holder, "Content-Type": "application/json" },
        body: JSON.stringify({ intent: "delete", idempotencyKey: crypto.randomUUID() }),
      },
    );
    const body: unknown = await response.json();
    const result = Option.getOrUndefined(decodeArchiveTaskResult(body));
    if (response.status === 409 && result?.status === "blocked") return result;
    if (!response.ok) throw apiError(response.status, Option.getOrUndefined(decodeErrorBody(body)));
    if (!result || (result.status !== "completed" && result.status !== "waiting_for_stop"))
      throw apiError(502, undefined);
    window.dispatchEvent(new CustomEvent("work-trace:changed"));
    return result;
  },
  workTraceStreamUrl: (sessionId: string, after = 0) =>
    `/api/sessions/${encodeURIComponent(sessionId)}/trace/stream?after=${after}`,
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
      throw apiError(
        response.status,
        Option.getOrUndefined(decodeErrorBody(json)),
        "upload_failed",
      );
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

/** Which queued messages a run just took in at a tool call. */
export const decodeDeliveredEvent = Schema.decodeUnknownOption(
  Schema.Struct({ ids: Schema.Array(Schema.String) }),
);

/** A context update a run sends while it answers. */
export const decodeContextEvent = Schema.decodeUnknownOption(
  Schema.Struct({
    usedTokens: Schema.NullOr(Schema.Number),
    cachedTokens: Schema.optionalWith(Schema.NullOr(Schema.Number), { default: () => null }),
    cacheRatio: Schema.optionalWith(Schema.NullOr(Schema.Number), { default: () => null }),
    compactionStage: Schema.optionalWith(
      Schema.NullOr(Schema.Literal("none", "clear-answered", "summarize", "leave-out")),
      { default: () => null },
    ),
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
