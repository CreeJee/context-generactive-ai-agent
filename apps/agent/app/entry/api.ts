import { browserCrypto } from "./shared/browser-crypto";
import { runUiEffect, uiPromise } from "./shared/ui-effect";
import { isTruthy } from "../truthy.ts";
import { Effect, Function as EffectFunction } from "effect";
import { ProviderId } from "memory-agent/provider-contracts";
import type {
  Attachment,
  BoardEdit,
  BoardEditResult,
  BoardIntent,
  BoardView,
  BtwThread,
  CardStatus,
  DecisionAnswer,
  DecisionInboxItem,
  DecisionKind,
  HumanDecisionRequest,
  KanbanBoardView,
  KanbanScheduleView,
  GoalMergeState,
  GoalPriority,
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
  Session,
  SkillCatalog,
  TraceTaskDetail,
  TraceTreeSnapshot,
  WorkflowAction,
  WorkflowPhase,
  WorkflowState,
  AccountLoginState,
  OAuthProfile,
  SubscriptionAccountProvider,
  SubscriptionQuotaReport,
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
  type UncertainRun,
  type UncertainTool,
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
      readonly code?: string;
      readonly operation?: string;
      readonly httpStatus?: number;
      readonly providerCode?: string;
      readonly credentialStage?: string;
      readonly transportCode?: string;
      readonly proxyRoute?: "direct" | "unavailable" | "attempted";
    };

/** Local OAuth profiles of one provider and its pending account login, without secrets. */
export type AccountsView = {
  readonly profiles: readonly OAuthProfile[];
  readonly login: AccountLoginState;
};
export type AccountAction =
  | { readonly intent: "add"; readonly label: string }
  | { readonly intent: "cancel" }
  | { readonly intent: "select"; readonly accountId: string }
  | { readonly intent: "remove"; readonly accountId: string }
  | { readonly intent: "rename"; readonly accountId: string; readonly label: string };

/** Whether the session's Goal runs as a kanban board, and what its loop knows about the cards. */
export type KanbanView = { readonly active: false } | ({ readonly active: true } & KanbanBoardView);

export type {
  BoardEdit,
  BoardEditResult,
  BoardIntent,
  BoardView,
  CardStatus,
  KanbanScheduleView,
  GoalMergeState,
  GoalPriority,
  DecisionAnswer,
  DecisionInboxItem,
  DecisionKind,
  HumanDecisionRequest,
  OAuthProfile,
  SubscriptionAccountProvider,
  SubscriptionQuotaReport,
  Attachment,
  BtwThread,
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
  UncertainRun,
  UncertainTool,
  WorkflowAction,
  WorkflowPhase,
  WorkflowState,
};

/** Every error code the browser API currently understands, including local fallbacks. */
export const ApiErrorCode = Schema.Literals([
  "account_action_failed",
  "account_list_unavailable",
  "answer_conflict",
  "answer_invalid",
  "approval_not_pending",
  "attachment_not_found",
  "attachment_rejected",
  "auth_failed",
  "backend_restart_required",
  "backend_restarting",
  "btw_not_found",
  "card_finished",
  "card_held",
  "card_missing",
  "card_not_blocked",
  "card_not_held",
  "card_not_running",
  "card_not_waiting",
  "card_status_changed",
  "card_transition_invalid",
  "cross_site_request",
  "empty_message",
  "external_agent_unavailable",
  "goal_missing",
  "goal_not_active",
  "goal_not_paused",
  "goal_superseded",
  "goal_terminal",
  "images_not_supported",
  "image_approval_required",
  "image_direct_workflow_required",
  "image_execution_failed",
  "image_feature_unavailable",
  "image_route_unavailable",
  "invalid_account_action",
  "invalid_account_id",
  "invalid_account_label",
  "invalid_agent_change",
  "invalid_answer",
  "invalid_board_edit",
  "invalid_chat_request",
  "invalid_conversation_settings",
  "invalid_decision_answer",
  "invalid_recall_settings",
  "invalid_embedding_action",
  "invalid_import_action",
  "invalid_image_request",
  "invalid_image_settings_action",
  "invalid_intent",
  "invalid_json",
  "invalid_kagi_action",
  "invalid_kanban_action",
  "invalid_kanban_settings",
  "dependency_cycle",
  "self_dependency",
  "other_project",
  "goal_missing",
  "not_kanban",
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
  "invalid_uncertain_continue",
  "kagi_key_required",
  "keychain_failed",
  "login_required",
  "model_list_failed",
  "model_selection_required",
  "model_unavailable",
  "no_running_run",
  "no_user_turn",
  "not_running",
  "plan_closed",
  "plan_dependencies_rejected",
  "plan_missing",
  "plan_not_executing",
  "plan_not_ready",
  "plan_outdated",
  "plan_version_conflict",
  "platform_failed",
  "project_not_found",
  "project_rejected",
  "project_required",
  "provider_unavailable",
  "provider_auth_unavailable",
  "worktree_failed",
  "worktree_in_use",
  "worktree_unavailable",
  "workflow_storage_failed",
  "kanban_storage_failed",
  "queue_delivered",
  "queue_item_changed",
  "reorder_across_columns",
  "queue_not_found",
  "queue_not_held",
  "queued_message_not_next",
  "quota_status_unavailable",
  "request_closed",
  "request_failed",
  "request_mismatch",
  "request_missing",
  "run_in_progress",
  "run_not_found",
  "session_in_use",
  "session_not_found",
  "session_required",
  "schedule_storage_failed",
  "settings_failed",
  "storage_failed",
  "subagent_not_found",
  "uncertain_runs_changed",
  "unknown_attachment",
  "upload_failed",
  "user_turn_required",
]);
export type ApiErrorCode = typeof ApiErrorCode.Type;

/** When long conversations start being summarized, as a percent of the context window. */
export type ConversationSettings = { readonly summaryStartPercent: number };
/** Kanban cards run at once across every Goal: the user's value, if any, and the one in use. */
export type KanbanSettings = { readonly configured: number | null; readonly effective: number };
/** Branches a project's Goals never merge into on their own. */
export type ProjectKanbanSettings = { readonly protectedBranches: readonly string[] };
/** Which memory a run may reach beyond its own project; both start off. */
export type RecallSettings = {
  readonly crossProjectRecall: boolean;
  readonly externalAgentMemory: boolean;
};

const CrossProviderMediaRunApproval = Schema.Struct({
  runId: Schema.String,
  initiatorChatRouteId: Schema.TemplateLiteral(["chat:", ProviderId, ":", Schema.String]),
  executorMediaRouteId: Schema.String,
  capability: Schema.Literal("media.image.generate"),
});
export class ApiError extends Schema.TaggedError<ApiError>()("ApiError", {
  status: Schema.Int,
  code: ApiErrorCode,
  reason: Schema.NullOr(Schema.String),
  approval: Schema.optional(CrossProviderMediaRunApproval),
}) {
  override get message() {
    return this.code;
  }
}
export const isApiError = Schema.is(ApiError);
const ErrorBody = Schema.Struct({
  error: Schema.optional(ApiErrorCode),
  reason: Schema.optional(Schema.String),
  approval: Schema.optional(CrossProviderMediaRunApproval),
});
const decodeErrorBody = Schema.decodeUnknownOption(ErrorBody);
type ErrorBody = typeof ErrorBody.Type;
const ResumeTaskResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("queued"),
    jobId: Schema.String,
    taskId: Schema.String,
    expectedAttemptId: Schema.String,
  }),
  Schema.Struct({ status: Schema.Literal("blocked"), reason: Schema.String }),
]);
const decodeResumeTaskResult = Schema.decodeUnknownOption(ResumeTaskResult);
type ResumeTaskResult = typeof ResumeTaskResult.Type;
const ArchiveTaskResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("completed"),
    operationId: Schema.optional(Schema.String),
    targetId: Schema.String,
    intent: Schema.optional(Schema.Literals(["archive", "restore", "delete"])),
    receiptId: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  Schema.Struct({ status: Schema.Literal("blocked"), blocker: Schema.String }),
  Schema.Struct({
    status: Schema.Literal("waiting_for_stop"),
    operationId: Schema.String,
    targetId: Schema.String,
  }),
]);
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
  worktreePath: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
});
const decodeSessionSnapshot = Schema.decodeUnknownOption(SessionSnapshot);
type PendingSessionLifecycle = Exclude<ArchiveTaskResult, { status: "completed" }>;
type SessionArchiveResult = { status: "completed"; session: Session } | PendingSessionLifecycle;

export function makeSessionLifecycleClient(appFetch: typeof fetch) {
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  function changeSessionLifecycle(sessionId: string, holder: string, change: JsonBody) {
    return runUiEffect(
      Effect.gen(function* () {
        const idempotencyKey = yield* browserCrypto.randomUUIDv4();
        const response = yield* uiPromise(() =>
          appFetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
            method: "POST",
            headers: { [sessionHolderHeader]: holder, "Content-Type": "application/json" },
            // Browser/native SDK boundary requires a cryptographic correlation or idempotency token.
            body: JSON.stringify({
              ...change,
              idempotencyKey: idempotencyKey,
            }),
          }),
        );
        const body: unknown = yield* uiPromise(() => response.json());
        const result = Option.getOrUndefined(decodeArchiveTaskResult(body));
        if (response.status === 409 && result?.status === "blocked")
          return { response, body, result };
        if (!response.ok)
          return yield* apiError(response.status, Option.getOrUndefined(decodeErrorBody(body)));
        // Accepted is not completed, even if a malformed response claims otherwise.
        if (response.status === 202 && (!isTruthy(result) || result.status === "completed"))
          return yield* apiError(502, undefined);
        return { response, body, result };
      }),
    );
  }

  return {
    /** Active parent/child runs are checkpointed and stopped before the conversation is archived. */
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    setArchived: (
      sessionId: string,
      holder: string,
      archived: boolean,
    ): Promise<SessionArchiveResult> =>
      runUiEffect(
        Effect.gen(function* () {
          const { response, body, result } = yield* uiPromise(() =>
            changeSessionLifecycle(sessionId, holder, {
              archived,
            }),
          );
          if (isTruthy(result) && result.status !== "completed") return result;
          const session = Option.getOrUndefined(decodeSessionSnapshot(body));
          if (response.status !== 200 || !isTruthy(session) || session.id !== sessionId)
            return yield* apiError(502, undefined);
          return { status: "completed", session };
        }),
      ),
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    deleteSession: (sessionId: string, holder: string): Promise<ArchiveTaskResult> =>
      runUiEffect(
        Effect.gen(function* () {
          const { response, result } = yield* uiPromise(() =>
            changeSessionLifecycle(sessionId, holder, {
              delete: true,
            }),
          );
          if (!isTruthy(result) || (result.status === "completed" && response.status !== 200))
            return yield* apiError(502, undefined);
          return result;
        }),
      ),
  };
}

function apiError(
  status: number,
  body: ErrorBody | undefined,
  fallback: "request_failed" | "upload_failed" = "request_failed",
) {
  return ApiError.make({
    status,
    code: body?.error ?? fallback,
    reason: body?.reason ?? null,
    approval: body?.approval,
  });
}

/** Preserve the server's typed error code through the chat transport. */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
// Fixed-arity application/SDK contract; these arguments are not a data-last collection API.
export const chatFetch: {
  (init?: RequestInit): (input: RequestInfo | URL) => Promise<Response>;
} & typeof fetch = EffectFunction.dual(
  (args) =>
    args[0] instanceof URL || args[0] instanceof Request || Schema.is(Schema.String)(args[0]),
  chatFetchBody,
);
function chatFetchBody(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const arguments_: Parameters<typeof fetch> = [input, init];
  return runUiEffect(
    Effect.gen(function* () {
      const response = yield* uiPromise(() => appFetch(...arguments_));
      if (!response.ok) {
        const body: unknown = yield* uiPromise(() =>
          response
            .clone()
            .json()
            .catch(() => null),
        );
        return yield* apiError(response.status, Option.getOrUndefined(decodeErrorBody(body)));
      }
      return response;
    }),
  );
}

type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | Readonly<{ [key: string]: JsonValue | undefined }>;
type JsonBody = Readonly<{ [key: string]: JsonValue | undefined }>;

// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
function call<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: JsonBody,
  headers: Readonly<Record<string, string>> = {},
): Promise<T> {
  return runUiEffect(
    Effect.gen(function* () {
      const response = yield* uiPromise(() =>
        appFetch(
          path,
          method === "POST"
            ? {
                method,
                headers: { ...headers, "Content-Type": "application/json" },
                body: JSON.stringify(body ?? {}),
              }
            : { method, headers },
        ),
      );
      const json: T & ErrorBody = yield* uiPromise(() => response.json());
      if (!response.ok) {
        const failure = apiError(response.status, Option.getOrUndefined(decodeErrorBody(json)));
        return yield* failure;
      }
      return json;
    }),
  );
}

export const api = {
  auth: (provider: ProviderId) =>
    call<ProviderAuthState>("GET", `/api/auth?provider=${encodeURIComponent(provider)}`),
  authAction: (intent: "login" | "cancel" | "logout", provider: ProviderId) =>
    call<ProviderAuthState>("POST", "/api/auth", { intent, provider }),

  accounts: (provider: SubscriptionAccountProvider) =>
    call<AccountsView>("GET", `/api/accounts?provider=${encodeURIComponent(provider)}`),
  accountAction: (provider: SubscriptionAccountProvider, action: AccountAction) =>
    call<AccountsView>("POST", "/api/accounts", { provider, ...action }),
  accountQuota: (provider: SubscriptionAccountProvider) =>
    call<SubscriptionQuotaReport>(
      "GET",
      `/api/accounts/quota?provider=${encodeURIComponent(provider)}`,
    ),

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
  ...makeSessionLifecycleClient(appFetch),
  /** Refused while a run is active; execute requires a current Plan that is ready or executing. */
  setWorkflowPhase: (sessionId: string, holder: string, phase: WorkflowPhase) =>
    call<WorkflowState>(
      "POST",
      `/api/sessions/${encodeURIComponent(sessionId)}`,
      { phase },
      { [sessionHolderHeader]: holder },
    ),
  board: (sessionId: string) =>
    call<BoardView>("GET", `/api/sessions/${encodeURIComponent(sessionId)}/board`),
  /** The user's board change; one to an executing card comes back as a stored request. */
  editBoard: (sessionId: string, holder: string, edit: BoardEdit) =>
    call<BoardEditResult>("POST", `/api/sessions/${encodeURIComponent(sessionId)}/board`, edit, {
      [sessionHolderHeader]: holder,
    }),
  /** The board's cards waiting for a person's decision. */
  decisions: (sessionId: string) =>
    call<HumanDecisionRequest[]>("GET", `/api/sessions/${encodeURIComponent(sessionId)}/decisions`),
  /** Every unanswered card decision of the project, across conversations and Goals. */
  decisionInbox: (projectId: string) =>
    call<DecisionInboxItem[]>("GET", `/api/projects/${encodeURIComponent(projectId)}/decisions`),
  answerDecision: (
    holder: string,
    request: Pick<HumanDecisionRequest, "requestId" | "sessionId" | "goalInstanceId" | "cardId">,
    answer: DecisionAnswer,
  ) =>
    call<HumanDecisionRequest>(
      "POST",
      `/api/sessions/${encodeURIComponent(request.sessionId)}/decisions/${encodeURIComponent(request.requestId)}`,
      { goalInstanceId: request.goalInstanceId, cardId: request.cardId, answer },
      { [sessionHolderHeader]: holder },
    ),
  kanban: (sessionId: string) =>
    call<KanbanView>("GET", `/api/sessions/${encodeURIComponent(sessionId)}/kanban`),
  /** Runs the executing Plan as a kanban board. */
  startKanban: (sessionId: string, holder: string) =>
    call<unknown>(
      "POST",
      `/api/sessions/${encodeURIComponent(sessionId)}/kanban`,
      { _tag: "Start" },
      { [sessionHolderHeader]: holder },
    ),
  /** What a person meant by dragging a card; the server decides the card's status. */
  boardIntent: (sessionId: string, holder: string, intent: BoardIntent) =>
    call<BoardEditResult>("POST", `/api/sessions/${encodeURIComponent(sessionId)}/kanban`, intent, {
      [sessionHolderHeader]: holder,
    }),
  /** How the Goal shares card slots with the project's other Goals. */
  setGoalPriority: (sessionId: string, holder: string, priority: GoalPriority) =>
    call<{ readonly priority: GoalPriority }>(
      "POST",
      `/api/sessions/${encodeURIComponent(sessionId)}/kanban`,
      { _tag: "SetPriority", priority },
      { [sessionHolderHeader]: holder },
    ),
  /** The Goals this Goal waits for; an empty list lifts the wait. */
  setGoalDependencies: (sessionId: string, holder: string, dependsOn: readonly string[]) =>
    call<{ readonly dependsOn: readonly string[] }>(
      "POST",
      `/api/sessions/${encodeURIComponent(sessionId)}/kanban`,
      { _tag: "SetDependencies", dependsOn },
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
  btwThreads: (sessionId: string) =>
    call<BtwThread[]>("GET", `/api/sessions/${encodeURIComponent(sessionId)}/btw`),
  /** A new BTW thread bound for good to this conversation. */
  createBtw: (sessionId: string) =>
    call<BtwThread>("POST", `/api/sessions/${encodeURIComponent(sessionId)}/btw`),
  /** `filesPending`: the rows are gone, some unreferenced image files wait for the next cleanup. */
  deleteBtw: (threadId: string) =>
    call<{ deleted: true; filesPending: boolean }>(
      "DELETE",
      `/api/btw/${encodeURIComponent(threadId)}`,
    ),
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
  /** Refused with 409 while something runs, or when the listed runs changed since they were shown. */
  continuePastUncertain: (sessionId: string, holder: string, runIds: readonly string[]) =>
    call<{ status: "acknowledged" }>(
      "POST",
      `/api/sessions/${encodeURIComponent(sessionId)}/uncertain`,
      { runIds },
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

  conversationSettings: () => call<ConversationSettings>("GET", "/api/settings/conversation"),
  recallSettings: () => call<RecallSettings>("GET", "/api/settings/recall"),
  setRecallSettings: (settings: Partial<RecallSettings>) =>
    call<RecallSettings>("POST", "/api/settings/recall", settings),
  setConversationSettings: (settings: ConversationSettings) =>
    call<ConversationSettings>("POST", "/api/settings/conversation", settings),
  kanbanSettings: () => call<KanbanSettings>("GET", "/api/settings/kanban"),
  /** null goes back to the machine default. */
  setKanbanConcurrency: (concurrency: number | null) =>
    call<KanbanSettings>("POST", "/api/settings/kanban", { concurrency }),
  projectKanban: (projectId: string) =>
    call<ProjectKanbanSettings>("GET", `/api/projects/${encodeURIComponent(projectId)}/kanban`),
  setProtectedBranches: (projectId: string, protectedBranches: readonly string[]) =>
    call<ProjectKanbanSettings>("POST", `/api/projects/${encodeURIComponent(projectId)}/kanban`, {
      protectedBranches,
    }),

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
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  resumeWorkTraceTask: (
    sessionId: string,
    holder: string,
    taskId: string,
    expectedAttemptId: string,
    confirmUncertain = false,
  ): Promise<ResumeTaskResult> =>
    runUiEffect(
      Effect.gen(function* () {
        // Native Request/Response adapter preserves host and SDK stream semantics.
        const response = yield* uiPromise(() =>
          appFetch(
            `/api/sessions/${encodeURIComponent(sessionId)}/trace/tasks/${encodeURIComponent(taskId)}`,
            {
              method: "POST",
              headers: { [sessionHolderHeader]: holder, "Content-Type": "application/json" },
              body: JSON.stringify({ intent: "resume", expectedAttemptId, confirmUncertain }),
            },
          ),
        );
        const body: unknown = yield* uiPromise(() => response.json());
        const result = Option.getOrUndefined(decodeResumeTaskResult(body));
        // A safety refusal is an expected action result, not a transport failure.
        if (response.status === 409 && result?.status === "blocked") return result;
        if (!response.ok)
          return yield* apiError(response.status, Option.getOrUndefined(decodeErrorBody(body)));
        if (!isTruthy(result) || result.status !== "queued") return yield* apiError(502, undefined);
        return result;
      }),
    ),
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  archiveWorkTraceTask: (
    sessionId: string,
    holder: string,
    taskId: string,
  ): Promise<ArchiveTaskResult> =>
    runUiEffect(
      Effect.gen(function* () {
        const idempotencyKey = yield* browserCrypto.randomUUIDv4();
        // Native Request/Response adapter preserves host and SDK stream semantics.
        const response = yield* uiPromise(() =>
          appFetch(
            `/api/sessions/${encodeURIComponent(sessionId)}/trace/tasks/${encodeURIComponent(taskId)}`,
            {
              method: "POST",
              headers: { [sessionHolderHeader]: holder, "Content-Type": "application/json" },
              // Browser/native SDK boundary requires a cryptographic correlation or idempotency token.
              body: JSON.stringify({
                intent: "archive",
                idempotencyKey: idempotencyKey,
              }),
            },
          ),
        );
        const body: unknown = yield* uiPromise(() => response.json());
        const result = Option.getOrUndefined(decodeArchiveTaskResult(body));
        if (response.status === 409 && result?.status === "blocked") return result;
        if (!response.ok)
          return yield* apiError(response.status, Option.getOrUndefined(decodeErrorBody(body)));
        if (
          !isTruthy(result) ||
          (result.status !== "completed" && result.status !== "waiting_for_stop")
        )
          return yield* apiError(502, undefined);
        window.dispatchEvent(new CustomEvent("work-trace:changed"));
        return result;
      }),
    ),
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  deleteWorkTraceTask: (
    sessionId: string,
    holder: string,
    taskId: string,
  ): Promise<ArchiveTaskResult> =>
    runUiEffect(
      Effect.gen(function* () {
        const idempotencyKey = yield* browserCrypto.randomUUIDv4();
        // Native Request/Response adapter preserves host and SDK stream semantics.
        const response = yield* uiPromise(() =>
          appFetch(
            `/api/sessions/${encodeURIComponent(sessionId)}/trace/tasks/${encodeURIComponent(taskId)}`,
            {
              method: "POST",
              headers: { [sessionHolderHeader]: holder, "Content-Type": "application/json" },
              // Browser/native SDK boundary requires a cryptographic correlation or idempotency token.
              body: JSON.stringify({
                intent: "delete",
                idempotencyKey: idempotencyKey,
              }),
            },
          ),
        );
        const body: unknown = yield* uiPromise(() => response.json());
        const result = Option.getOrUndefined(decodeArchiveTaskResult(body));
        if (response.status === 409 && result?.status === "blocked") return result;
        if (!response.ok)
          return yield* apiError(response.status, Option.getOrUndefined(decodeErrorBody(body)));
        if (
          !isTruthy(result) ||
          (result.status !== "completed" && result.status !== "waiting_for_stop")
        )
          return yield* apiError(502, undefined);
        window.dispatchEvent(new CustomEvent("work-trace:changed"));
        return result;
      }),
    ),
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
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  uploadAttachment: (file: File) =>
    runUiEffect(
      Effect.gen(function* () {
        // Native Request/Response adapter preserves host and SDK stream semantics.
        const response = yield* uiPromise(() =>
          appFetch("/api/attachments", {
            method: "POST",
            headers: { "Content-Type": file.type || "application/octet-stream" },
            body: file,
          }),
        );
        const json: Attachment & ErrorBody = yield* uiPromise(() => response.json());
        if (!response.ok)
          return yield* apiError(
            response.status,
            Option.getOrUndefined(decodeErrorBody(json)),
            "upload_failed",
          );
        return json;
      }),
    ),
};

const AttachmentRejection = Schema.Literals(["too_large", "unsupported_type", "empty"]);
const attachmentRejections = {
  too_large: "20MB보다 큰 이미지는 올릴 수 없어요.",
  unsupported_type: "PNG, JPEG, GIF, WebP 이미지만 올릴 수 있어요.",
  empty: "빈 파일이에요.",
} satisfies Record<typeof AttachmentRejection.Type, string>;

export function attachmentErrorMessage(error: Error) {
  if (!isApiError(error) || !isTruthy(error.reason)) return "이미지를 올리지 못했어요.";
  return Schema.is(AttachmentRejection)(error.reason)
    ? attachmentRejections[error.reason]
    : error.reason;
}

const ProjectRejection = Schema.Literals([
  "not_found",
  "not_directory",
  "overlaps_storage",
  "already_registered",
]);
const projectRejections = {
  not_found: "경로를 찾을 수 없어요.",
  not_directory: "폴더 경로가 아니에요.",
  overlaps_storage: "앱 저장소 폴더와 겹치는 경로는 등록할 수 없어요.",
  already_registered: "이미 등록된 프로젝트예요.",
} satisfies Record<typeof ProjectRejection.Type, string>;

export function projectErrorMessage(error: Error) {
  if (!isApiError(error) || !isTruthy(error.reason)) return "프로젝트를 추가하지 못했어요.";
  return Schema.is(ProjectRejection)(error.reason) ? projectRejections[error.reason] : error.reason;
}

const ArchiveRejection = Schema.Literals([
  "run_in_progress",
  "session_in_use",
  "session_not_found",
]);
const archiveRejections = {
  run_in_progress: "답변 중인 대화는 보관할 수 없어요. 끝나거나 멈춘 뒤 다시 시도하세요.",
  session_in_use: "다른 탭에서 쓰고 있는 대화예요. 그 탭을 닫은 뒤 다시 시도하세요.",
  session_not_found: "대화를 찾을 수 없어요.",
} satisfies Record<typeof ArchiveRejection.Type, string>;

export function archiveErrorMessage(error: Error) {
  return isApiError(error) && Schema.is(ArchiveRejection)(error.code)
    ? archiveRejections[error.code]
    : "대화를 바꾸지 못했어요.";
}

/** Which queued messages a run just took in at a tool call. */
// Fixed-arity application/SDK contract; these arguments are not a data-last collection API.
const DeliveredEvent = Schema.Struct({ ids: Schema.Array(Schema.String) });

/** A context update a run sends while it answers. */
// Fixed-arity application/SDK contract; these arguments are not a data-last collection API.
const ContextEvent = Schema.Struct({
  usedTokens: Schema.NullOr(Schema.Finite),
  cachedTokens: Schema.NullOr(Schema.Finite).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed(null)),
  ),
  cacheRatio: Schema.NullOr(Schema.Finite).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed(null)),
  ),
  compactionStage: Schema.NullOr(
    Schema.Literals(["none", "clear-answered", "summarize", "leave-out"]),
  ).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(null))),
  windowTokens: Schema.Finite,
  windowKnown: Schema.Boolean.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(false))),
  compactAtTokens: Schema.Finite,
});

const CompactRejection = Schema.Literals([
  "run_in_progress",
  "session_in_use",
  "session_not_found",
]);
const compactRejections = {
  run_in_progress: "답변이 끝난 뒤에 비울 수 있어요.",
  session_in_use: "다른 탭에서 쓰고 있는 대화예요. 그 탭에서 다시 시도하세요.",
  session_not_found: "대화를 찾을 수 없어요.",
} satisfies Record<typeof CompactRejection.Type, string>;

export function compactErrorMessage(error: Error) {
  return isApiError(error) && Schema.is(CompactRejection)(error.code)
    ? compactRejections[error.code]
    : "도구 출력을 비우지 못했어요.";
}

export const eventDecoders = {
  delivered: Schema.decodeUnknownOption(DeliveredEvent),
  context: Schema.decodeUnknownOption(ContextEvent),
};
