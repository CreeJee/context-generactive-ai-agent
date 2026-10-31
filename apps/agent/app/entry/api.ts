import { browserCrypto } from "./shared/browser-crypto";
import { runUiEffect, uiPromise } from "./shared/ui-effect";
import { isTruthy } from "../truthy.ts";
import { Cause, Context, Data, Effect, Layer, ManagedRuntime, Match } from "effect";
import { FetchHttpClient, HttpClientError } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import {
  AppApi,
  appRefusalStatus,
  type ConversationSettings,
  type EmbeddingCommand as EmbeddingCommandCase,
  type ExternalAgentCommand as ExternalAgentCommandCase,
  FolderPick,
  type ImageSettings,
  type ImageSettingsCommand as ImageSettingsCommandCase,
  type ImportCommand as ImportCommandCase,
  type ImprovementStatus,
  type KagiCommand as KagiCommandCase,
  type KanbanCommand as KanbanCommandCase,
  type KanbanSettings,
  type KanbanSettingsCommand as KanbanSettingsCommandCase,
  type KanbanView,
  type McpCommand as McpCommandCase,
  type ProjectKanbanCommand as ProjectKanbanCommandCase,
  type ProjectKanbanSettings,
  type ProjectSettings,
  type ProviderAuthState as ProviderAuthStateCase,
  type RecallSettings,
  type ScanCommand as ScanCommandCase,
  type SubscriptionAccountCommand,
  SubscriptionAccountsView,
} from "memory-agent/app-api";
import { ProviderId } from "memory-agent/provider-contracts";
import type {
  AgentLinkState as AgentLinkStateCase,
  AgentTrustState as AgentTrustStateCase,
  Attachment,
  BoardEdit as BoardEditCase,
  BoardEditResult,
  BoardIntent as BoardIntentCase,
  BoardView,
  BtwThread,
  CardStatus,
  DecisionAnswer as DecisionAnswerCase,
  DecisionInboxItem,
  DecisionKind,
  HumanDecisionRequest,
  KanbanScheduleView,
  GoalMergeState,
  ProviderModel,
  EmbeddingChoice,
  EmbeddingOverview,
  ExternalAgentsOverview,
  ExternalAgentView,
  GpuState as GpuStateCase,
  ImportActivity as ImportActivityCase,
  ImportOverview,
  ImageFeatureStatus,
  ImageMediaAsset,
  KagiStatus,
  McpOverview,
  McpScope,
  CrossProviderMediaConsentMode,
  CrossProviderMediaConsentSettings,
  CrossProviderMediaRunApproval,
  McpServerState as McpServerStateCase,
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
  AccountLoginState as AccountLoginStateCase,
  OAuthProfile,
  SubscriptionAccountProvider,
  SubscriptionQuotaReport,
} from "memory-agent";
import { Option, Schema } from "effect";
import { appFetch } from "./shared/backend-restart";
import {
  sessionHolderHeader,
  type CancelResult,
  type CompactResult,
  type ContextView,
  type LeaseView,
  NextDelivery,
  QueueEdit,
  QueueItemState,
  type QueuedMessage,
  type QueueSnapshot,
  type SessionRunState,
  ApprovalRequester,
  type RelayedApprovalView,
  type SubagentView,
  type UncertainContinue,
  type UncertainRun,
  type UncertainTool,
} from "memory-agent/definitions";

/** The session route's bodies, as `/api/sessions/:session` reads them. */
export type SessionChange = Data.TaggedEnum<{
  Archive: { readonly archived: boolean; readonly idempotencyKey: string };
  Delete: { readonly idempotencyKey: string };
  Phase: { readonly phase: WorkflowPhase };
  Control: { readonly workflowAction: WorkflowAction };
}>;
export const SessionChange = Data.taggedEnum<SessionChange>();

/** The kanban commands besides a `BoardIntent`, as `/api/sessions/:session/kanban` reads them. */
type KanbanCommand = KanbanCommandCase;
const KanbanCommand = Data.taggedEnum<KanbanCommand>();

/*
 * Constructors and matchers for the server's unions that pages send. The browser loads only
 * memory-agent's types, so they are built from the types; the routes decode what arrives.
 */
export type BoardEdit = BoardEditCase;
export const BoardEdit = Data.taggedEnum<BoardEdit>();
export type BoardIntent = BoardIntentCase;
export const BoardIntent = Data.taggedEnum<BoardIntent>();
export type DecisionAnswer = DecisionAnswerCase;
export const DecisionAnswer = Data.taggedEnum<DecisionAnswer>();

/** The commands `/api/settings/kagi` reads. */
export type KagiCommand = KagiCommandCase;
export const KagiCommand = Data.taggedEnum<KagiCommand>();
/** The commands `/api/settings/imports` reads. */
export type ImportCommand = ImportCommandCase;
export const ImportCommand = Data.taggedEnum<ImportCommand>();
/** The commands `/api/settings/embedding` reads. */
export type EmbeddingCommand = EmbeddingCommandCase;
export const EmbeddingCommand = Data.taggedEnum<EmbeddingCommand>();
/** The commands `/api/settings/image` reads. */
type ImageSettingsCommand = ImageSettingsCommandCase;
const ImageSettingsCommand = Data.taggedEnum<ImageSettingsCommand>();
/** The commands `/api/settings/improvements` reads. */
export type ScanCommand = ScanCommandCase;
export const ScanCommand = Data.taggedEnum<ScanCommand>();
/** The commands `/api/projects/:project/agents` reads. */
type ExternalAgentCommand = ExternalAgentCommandCase;
const ExternalAgentCommand = Data.taggedEnum<ExternalAgentCommand>();
/** The commands `/api/projects/:project/mcp` reads. */
export type McpCommand = McpCommandCase;
export const McpCommand = Data.taggedEnum<McpCommand>();

export { ApprovalRequester, NextDelivery, QueueEdit, QueueItemState };

/** How the embedding model runs in the server process, as the settings page shows it. */
export type EmbedderRuntime = EmbeddingOverview["running"];
export const EmbedderRuntime = Data.taggedEnum<EmbedderRuntime>();
export type GpuState = GpuStateCase;
export const GpuState = Data.taggedEnum<GpuState>();
export type AgentTrustState = AgentTrustStateCase;
export const AgentTrustState = Data.taggedEnum<AgentTrustState>();
export type AgentLinkState = AgentLinkStateCase;
export const AgentLinkState = Data.taggedEnum<AgentLinkState>();
export type McpServerState = McpServerStateCase;
export const McpServerState = Data.taggedEnum<McpServerState>();
export type AccountLoginState = AccountLoginStateCase;
export const AccountLoginState = Data.taggedEnum<AccountLoginState>();
export type ImportActivity = ImportActivityCase;
export const ImportActivity = Data.taggedEnum<ImportActivity>();
/** Where the session's Plan execution stands, as its run state carries it. */
export type WorkflowExecutionState = NonNullable<SessionRunState["execution"]>;
export const WorkflowExecutionState = Data.taggedEnum<WorkflowExecutionState>();

export type GeneratedImageAsset = ImageMediaAsset & { readonly url: string };
export type ImageSettingsView = ImageSettings;

/** A provider's connection as `/api/auth` sends it; a pending login's URL arrives as `authUrl`. */
export type ProviderAuthState = ProviderAuthStateCase;
export const ProviderAuthState = Data.taggedEnum<ProviderAuthState>();

/** Local OAuth profiles of one provider and its pending account login, without secrets. */
export type AccountsView = SubscriptionAccountsView;
type WithoutProvider<Command> = Command extends unknown ? Omit<Command, "provider"> : never;
/** A `/api/accounts` change of the provider the call names. */
export type AccountAction = WithoutProvider<SubscriptionAccountCommand>;

export type {
  BoardEditResult,
  BoardView,
  CardStatus,
  KanbanView,
  KanbanScheduleView,
  GoalMergeState,
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
  QueuedMessage,
  QueueSnapshot,
  Session,
  SessionRunState,
  SkillCatalog,
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
  "account_login_failed",
  "account_not_found",
  "account_store_unavailable",
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
  "card_has_dependents",
  "card_held",
  "card_missing",
  "card_not_blocked",
  "card_not_held",
  "card_not_running",
  "card_not_waiting",
  "card_running",
  "card_status_changed",
  "card_transition_invalid",
  "card_waiting",
  "transfer_target_invalid",
  "cross_site_request",
  "empty_message",
  "endpoint_unavailable",
  "external_agent_unavailable",
  "facts_changed",
  "goal_missing",
  "goal_not_active",
  "goal_not_paused",
  "goal_superseded",
  "goal_terminal",
  "images_not_supported",
  "improvement_failed",
  "image_approval_required",
  "image_direct_workflow_required",
  "image_execution_failed",
  "image_feature_unavailable",
  "image_route_unavailable",
  "internal_error",
  "invalid_account_action",
  "invalid_account_id",
  "invalid_account_label",
  "invalid_agent_change",
  "invalid_answer",
  "invalid_board_edit",
  "invalid_command",
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
  "no_goal_change",
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
  "login_in_progress",
  "login_required",
  "model_list_failed",
  "model_selection_required",
  "model_unavailable",
  "no_running_run",
  "no_user_turn",
  "not_running",
  "oauth_profile_conflicting_credential",
  "oauth_profile_copy_unverified",
  "oauth_profile_in_use",
  "oauth_profile_missing_credential",
  "oauth_profile_not_found",
  "oauth_profile_removing",
  "invalid_oauth_profile",
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
  "reassign_needs_edit",
  "queue_not_found",
  "queue_not_held",
  "queue_reserved",
  "queued_message_not_next",
  "quota_status_unavailable",
  "request_closed",
  "request_failed",
  "request_mismatch",
  "request_missing",
  "request_settled",
  "run_in_progress",
  "run_not_found",
  "session_in_use",
  "session_not_found",
  "session_required",
  "schedule_storage_failed",
  "settings_failed",
  "settings_partially_saved",
  "settings_unavailable",
  "storage_failed",
  "subagent_not_found",
  "uncertain_runs_changed",
  "unknown_attachment",
  "upload_failed",
  "user_turn_required",
]);
export type ApiErrorCode = typeof ApiErrorCode.Type;

export type { ConversationSettings, ImprovementStatus, KanbanSettings, RecallSettings };
/** The commands `/api/settings/kanban` reads. */
export type KanbanSettingsCommand = KanbanSettingsCommandCase;
export const KanbanSettingsCommand = Data.taggedEnum<KanbanSettingsCommand>();
export type { ProjectKanbanSettings };
/** The commands `/api/projects/:project/kanban` reads. */
export type ProjectKanbanCommand = ProjectKanbanCommandCase;
export const ProjectKanbanCommand = Data.taggedEnum<ProjectKanbanCommand>();

const CrossProviderMediaRunApproval = Schema.Struct({
  runId: Schema.String,
  initiatorChatRouteId: Schema.TemplateLiteral(["chat:", ProviderId, ":", Schema.String]),
  executorMediaRouteId: Schema.String,
  capability: Schema.Literal("media.image.generate"),
});
export class ApiError extends Schema.TaggedError<ApiError, { readonly brand: unique symbol }>()(
  "ApiError",
  {
    status: Schema.Int,
    code: ApiErrorCode,
    reason: Schema.NullOr(Schema.String),
    approval: Schema.optional(CrossProviderMediaRunApproval),
  },
) {
  override get message() {
    return this.code;
  }
}
export const isApiError = Schema.is(ApiError);
/** The server's refusal behind a failed call, or null when the call failed some other way. */
export const refusalOf = <F>(failure: F): ApiError | null => (isApiError(failure) ? failure : null);
const ErrorBody = Schema.Struct({
  error: Schema.optional(ApiErrorCode),
  reason: Schema.optional(Schema.String),
  approval: Schema.optional(CrossProviderMediaRunApproval),
});
const decodeErrorBody = Schema.decodeUnknownOption(ErrorBody);
type ErrorBody = typeof ErrorBody.Type;
export const ResumeTaskResult = Schema.TaggedUnion({
  queued: { jobId: Schema.String, taskId: Schema.String, expectedAttemptId: Schema.String },
  blocked: { reason: Schema.String },
});
const decodeResumeTaskResult = Schema.decodeUnknownOption(ResumeTaskResult);
export type ResumeTaskResult = typeof ResumeTaskResult.Type;
export const ArchiveTaskResult = Schema.TaggedUnion({
  completed: {
    operationId: Schema.optional(Schema.String),
    targetId: Schema.String,
    intent: Schema.optional(Schema.Literals(["archive", "restore", "delete"])),
    receiptId: Schema.optional(Schema.NullOr(Schema.String)),
  },
  blocked: { blocker: Schema.String },
  waiting_for_stop: { operationId: Schema.String, targetId: Schema.String },
});
const decodeArchiveTaskResult = Schema.decodeUnknownOption(ArchiveTaskResult);
export type ArchiveTaskResult = typeof ArchiveTaskResult.Type;

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
/** A lifecycle change the server has not finished: why it is blocked, or the stop it waits for. */
export type PendingLifecycle = Exclude<
  ArchiveTaskResult,
  typeof ArchiveTaskResult.cases.completed.Type
>;
/** Archiving or restoring a conversation: done, with the session as it now is, or pending. */
export type SessionArchiveResult = Data.TaggedEnum<{
  completed: { readonly session: Session };
  blocked: { readonly blocker: string };
  waiting_for_stop: { readonly operationId: string; readonly targetId: string };
}>;
export const SessionArchiveResult = Data.taggedEnum<SessionArchiveResult>();

export function makeSessionLifecycleClient(appFetch: typeof fetch) {
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  function changeSessionLifecycle(
    sessionId: string,
    holder: string,
    change: (idempotencyKey: string) => SessionChange,
  ) {
    return runUiEffect(
      Effect.gen(function* () {
        const idempotencyKey = yield* browserCrypto.randomUUIDv4();
        const response = yield* uiPromise(() =>
          appFetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
            method: "POST",
            headers: { [sessionHolderHeader]: holder, "Content-Type": "application/json" },
            // Browser/native SDK boundary requires a cryptographic correlation or idempotency token.
            body: JSON.stringify(change(idempotencyKey)),
          }),
        );
        const body: unknown = yield* uiPromise(() => response.json());
        const result = Option.getOrUndefined(decodeArchiveTaskResult(body));
        if (response.status === 409 && ArchiveTaskResult.guards.blocked(result))
          return { response, body, result };
        if (!response.ok)
          return yield* apiError(response.status, Option.getOrUndefined(decodeErrorBody(body)));
        // Accepted is not completed, even if a malformed response claims otherwise.
        if (
          response.status === 202 &&
          (!isTruthy(result) || ArchiveTaskResult.guards.completed(result))
        )
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
            changeSessionLifecycle(sessionId, holder, (idempotencyKey) =>
              SessionChange.Archive({ archived, idempotencyKey }),
            ),
          );
          if (isTruthy(result) && !ArchiveTaskResult.guards.completed(result)) return result;
          const session = Option.getOrUndefined(decodeSessionSnapshot(body));
          if (response.status !== 200 || !isTruthy(session) || session.id !== sessionId)
            return yield* apiError(502, undefined);
          return SessionArchiveResult.completed({ session });
        }),
      ),
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    deleteSession: (sessionId: string, holder: string): Promise<ArchiveTaskResult> =>
      runUiEffect(
        Effect.gen(function* () {
          const { response, result } = yield* uiPromise(() =>
            changeSessionLifecycle(sessionId, holder, (idempotencyKey) =>
              SessionChange.Delete({ idempotencyKey }),
            ),
          );
          if (
            !isTruthy(result) ||
            (ArchiveTaskResult.guards.completed(result) && response.status !== 200)
          )
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

const makeAppApiClient = HttpApiClient.make(AppApi);

/** The app API (`memory-agent/app-api`), called over `appFetch` like the chat API. */
class AppApiClient extends Context.Service<AppApiClient, Effect.Success<typeof makeAppApiClient>>()(
  "agent/app/entry/api/AppApiClient",
) {
  static readonly layer = Layer.effect(AppApiClient, makeAppApiClient);
}

const appApiRuntime = ManagedRuntime.make(
  Layer.mergeAll(
    AppApiClient.layer.pipe(Layer.provide(FetchHttpClient.layer)),
    Layer.succeed(FetchHttpClient.Fetch, appFetch),
  ),
);

/** What an app API call fails with: a refusal the endpoint declares, or the call itself failing. */
type AppApiFailure =
  | { readonly error: ApiErrorCode; readonly reason?: string }
  | HttpClientError.HttpClientError
  | Schema.SchemaError;

/**
 * A call that failed outside the endpoint's refusals. A transport failure keeps its cause, as
 * `appFetch` rejected with it; a status the endpoint does not declare is read like `call` reads it.
 */
const clientFailure = (failure: HttpClientError.HttpClientError) =>
  failure.reason._tag === "TransportError"
    ? Effect.fail(new Cause.UnknownError(failure.reason.cause))
    : Effect.option(
        Effect.flatMap(Effect.fromNullishOr(failure.response), (response) => response.json),
      ).pipe(
        Effect.flatMap((body) =>
          Effect.fail(
            apiError(
              failure.response?.status ?? 502,
              Option.getOrUndefined(Option.flatMap(body, decodeErrorBody)),
            ),
          ),
        ),
      );

/** The page's `ApiError` for a failed app API call; a value the page's schema refuses is `invalid`. */
const appApiFailure = (invalid: ApiErrorCode) =>
  Match.type<AppApiFailure>().pipe(
    Match.when(Schema.isSchemaError, () => Effect.fail(apiError(400, { error: invalid }))),
    Match.when(HttpClientError.isHttpClientError, clientFailure),
    Match.orElse((refusal) => Effect.fail(apiError(appRefusalStatus(refusal), refusal))),
  );

/** Calls the app API through the page's client; a failure is an `ApiError` as `call` gives. */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
const appCall = <A, E extends AppApiFailure>(
  request: (client: AppApiClient["Service"]) => Effect.Effect<A, E>,
  invalid: ApiErrorCode = "request_failed",
): Promise<A> =>
  runUiEffect(
    Effect.flatMap(appApiRuntime.contextEffect, (context) =>
      Effect.flatMap(AppApiClient, request).pipe(
        Effect.catch(appApiFailure(invalid)),
        Effect.provideContext(context),
      ),
    ),
  );

/** Changes the project's settings that `payload` names; the others stay as they are. */
const updateProject = (project: string, payload: ProjectSettings) =>
  appCall((client) => client.projects.update({ params: { project }, payload }), "invalid_settings");

/**
 * `/api/accounts` answers a subscription provider with its profiles; another view would be the
 * server's fault.
 */
const subscriptionView = Effect.filterOrFail(
  Schema.is(SubscriptionAccountsView),
  () => ({ error: "request_failed" }) as const,
);

export const api = {
  auth: (provider: ProviderId) =>
    appCall((client) => client.auth.status({ query: { provider } }), "invalid_provider"),
  authAction: (intent: "login" | "cancel" | "logout", provider: SubscriptionAccountProvider) =>
    appCall((client) => client.auth.action({ payload: { intent, provider } }), "invalid_provider"),

  accounts: (provider: SubscriptionAccountProvider) =>
    appCall(
      (client) => client.accounts.list({ query: { provider } }).pipe(subscriptionView),
      "invalid_provider",
    ),
  accountAction: (provider: SubscriptionAccountProvider, action: AccountAction) =>
    appCall(
      (client) =>
        Match.value(action).pipe(
          Match.discriminatorsExhaustive("intent")({
            add: (add) => client.accounts.action({ payload: { ...add, provider } }),
            cancel: (cancel) => client.accounts.action({ payload: { ...cancel, provider } }),
            select: (select) => client.accounts.action({ payload: { ...select, provider } }),
            remove: (remove) => client.accounts.action({ payload: { ...remove, provider } }),
            rename: (rename) => client.accounts.action({ payload: { ...rename, provider } }),
          }),
          subscriptionView,
        ),
      "invalid_account_action",
    ),
  accountQuota: (provider: SubscriptionAccountProvider) =>
    appCall((client) => client.accounts.quota({ query: { provider } }), "invalid_provider"),

  models: (provider: ProviderId) =>
    appCall((client) => client.models.list({ query: { provider } }), "invalid_provider"),
  selectModel: (model: string, reasoningEffort: string | undefined, provider: ProviderId) =>
    appCall(
      (client) =>
        client.models.select({ params: { model }, payload: { provider, reasoningEffort } }),
      "invalid_selection",
    ),

  projects: () => appCall((client) => client.projects.list({ query: {} })),
  addProject: (root: string) =>
    appCall((client) => client.projects.add({ payload: { root } }), "invalid_project"),
  setCrossRecallExcluded: (projectId: string, crossRecallExcluded: boolean) =>
    updateProject(projectId, { crossRecallExcluded }),
  setPermissionMode: (projectId: string, permissionMode: PermissionMode) =>
    updateProject(projectId, { permissionMode }),
  /** Archives a project: out of the sidebar list. Its conversations and memory stay. */
  hideProject: (projectId: string) => updateProject(projectId, { hidden: true }),
  /** Puts an archived project back in the sidebar list. */
  restoreProject: (projectId: string) => updateProject(projectId, { hidden: false }),
  hiddenProjects: () => appCall((client) => client.projects.list({ query: { hidden: "1" } })),
  /** Opens the folder dialog of the machine running the app; nothing is registered yet. */
  pickFolder: () => appCall((client) => client.projects.pick()),

  sessions: (project: string) =>
    appCall((client) => client.sessions.list({ query: { project } }), "project_required"),
  archivedSessions: (project: string) =>
    appCall(
      (client) => client.sessions.list({ query: { project, archived: "1" } }),
      "project_required",
    ),
  ...makeSessionLifecycleClient(appFetch),
  /** Refused while a run is active; execute requires a current Plan that is ready or executing. */
  setWorkflowPhase: (sessionId: string, holder: string, phase: WorkflowPhase) =>
    call<WorkflowState>(
      "POST",
      `/api/sessions/${encodeURIComponent(sessionId)}`,
      SessionChange.Phase({ phase }),
      { [sessionHolderHeader]: holder },
    ),
  board: (session: string) => appCall((client) => client.sessions.board({ params: { session } })),
  /** The user's board change; one to an executing card comes back as a stored request. */
  editBoard: (session: string, holder: string, edit: BoardEdit) =>
    appCall((client) => {
      const request = { params: { session }, headers: { "x-session-holder": holder } };
      // The client takes a union payload one case at a time.
      return BoardEdit.$match(edit, {
        AddCard: (payload) => client.sessions.editBoard({ ...request, payload }),
        EditCard: (payload) => client.sessions.editBoard({ ...request, payload }),
        MoveCard: (payload) => client.sessions.editBoard({ ...request, payload }),
        CancelCard: (payload) => client.sessions.editBoard({ ...request, payload }),
        ClosePlan: (payload) => client.sessions.editBoard({ ...request, payload }),
      });
    }, "invalid_board_edit"),
  /** The board's cards waiting for a person's decision. */
  decisions: (session: string) =>
    appCall((client) => client.sessions.decisions({ params: { session } })),
  /** Every unanswered card decision of the project, across conversations and Goals. */
  decisionInbox: (project: string) =>
    appCall((client) => client.projects.decisions({ params: { project } })),
  /** Every conversation's Plan as a board, across the project; running boards first. */
  projectBoards: (project: string) =>
    appCall((client) => client.projects.boards({ params: { project } })),
  answerDecision: (
    holder: string,
    request: Pick<
      HumanDecisionRequest,
      "requestId" | "sessionId" | "goalInstanceId" | "cardId" | "factsSeq"
    >,
    answer: DecisionAnswer,
  ) =>
    appCall(
      (client) =>
        client.sessions.answerDecision({
          params: { session: request.sessionId, decision: request.requestId },
          headers: { "x-session-holder": holder },
          payload: {
            goalInstanceId: request.goalInstanceId,
            cardId: request.cardId,
            factsSeq: request.factsSeq,
            answer,
          },
        }),
      "invalid_decision_answer",
    ),
  kanban: (session: string): Promise<KanbanView> =>
    appCall((client) => client.sessions.kanban({ params: { session } })),
  /** Runs the executing Plan as a kanban board. */
  startKanban: (session: string, holder: string) =>
    appCall(
      (client) =>
        client.sessions.kanbanAction({
          params: { session },
          headers: { "x-session-holder": holder },
          payload: KanbanCommand.Start(),
        }),
      "invalid_kanban_action",
    ),
  /** What a person meant by dragging a card; the server decides the card's status. */
  boardIntent: (session: string, holder: string, intent: BoardIntent) =>
    appCall((client) => {
      const request = { params: { session }, headers: { "x-session-holder": holder } };
      // The client takes a union payload one case at a time.
      return BoardIntent.$match(intent, {
        Reorder: (payload) => client.sessions.kanbanAction({ ...request, payload }),
        Requeue: (payload) => client.sessions.kanbanAction({ ...request, payload }),
        Hold: (payload) => client.sessions.kanbanAction({ ...request, payload }),
        Release: (payload) => client.sessions.kanbanAction({ ...request, payload }),
        ChangeRequest: (payload) => client.sessions.kanbanAction({ ...request, payload }),
        Cancel: (payload) => client.sessions.kanbanAction({ ...request, payload }),
        Transfer: (payload) => client.sessions.kanbanAction({ ...request, payload }),
      });
    }, "invalid_kanban_action"),
  /** Runs the board's loop again after it stopped on exhausted retries or a defect. */
  restartKanbanLoop: (session: string, holder: string) =>
    appCall(
      (client) =>
        client.sessions.kanbanAction({
          params: { session },
          headers: { "x-session-holder": holder },
          payload: KanbanCommand.RestartLoop(),
        }),
      "invalid_kanban_action",
    ),
  /** The Goals this Goal waits for; an empty list lifts the wait. */
  setGoalDependencies: (session: string, holder: string, dependsOn: readonly string[]) =>
    appCall(
      (client) =>
        client.sessions.kanbanAction({
          params: { session },
          headers: { "x-session-holder": holder },
          payload: KanbanCommand.SetDependencies({ dependsOn }),
        }),
      "invalid_kanban_action",
    ),
  controlWorkflow: (sessionId: string, holder: string, workflowAction: WorkflowAction) =>
    call<WorkflowState>(
      "POST",
      `/api/sessions/${encodeURIComponent(sessionId)}`,
      SessionChange.Control({ workflowAction }),
      { [sessionHolderHeader]: holder },
    ),
  /** `agent`: talk directly to that trusted external ACP agent instead of the app's model. */
  createSession: (projectId: string, agent?: string) =>
    appCall(
      (client) => client.sessions.create({ payload: { projectId, agent } }),
      "invalid_session",
    ),
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
    call<Data.TaggedEnum.Value<UncertainContinue, "acknowledged">>(
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

  queue: (session: string) => appCall((client) => client.sessions.queue({ params: { session } })),
  enqueue: (
    session: string,
    holder: string,
    payload: { text: string; attachmentIds: readonly string[]; mode: "queue" | "steer" },
  ) =>
    appCall(
      (client) =>
        client.sessions.enqueue({
          params: { session },
          headers: { "x-session-holder": holder },
          payload,
        }),
      "invalid_queue_request",
    ),
  editQueued: (session: string, holder: string, message: string, edit: QueueEdit) =>
    appCall((client) => {
      const request = { params: { session, message }, headers: { "x-session-holder": holder } };
      // The client takes a union payload one case at a time.
      return QueueEdit.$match(edit, {
        edit: (payload) => client.sessions.editQueued({ ...request, payload }),
        save: (payload) => client.sessions.editQueued({ ...request, payload }),
        remove: (payload) => client.sessions.editQueued({ ...request, payload }),
        confirm: (payload) => client.sessions.editQueued({ ...request, payload }),
      });
    }, "invalid_queue_edit"),
  imageSettings: () => appCall((client) => client.settings.image()),
  setImageGenerationEnabled: (enabled: boolean) =>
    appCall(
      (client) =>
        client.settings.imageAction({
          payload: ImageSettingsCommand.image_generation({ enabled }),
        }),
      "invalid_image_settings_action",
    ),
  setCrossProviderMediaConsent: (mode: CrossProviderMediaConsentMode) =>
    appCall(
      (client) =>
        client.settings.imageAction({
          payload: ImageSettingsCommand.cross_provider_media({ mode }),
        }),
      "invalid_image_settings_action",
    ),
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

  kagi: () => appCall((client) => client.settings.kagi()),
  // The client takes a union payload one case at a time.
  kagiAction: (command: KagiCommand) =>
    appCall(
      (client) =>
        KagiCommand.$match(command, {
          register: (payload) => client.settings.kagiAction({ payload }),
          remove: (payload) => client.settings.kagiAction({ payload }),
          enable: (payload) => client.settings.kagiAction({ payload }),
          disable: (payload) => client.settings.kagiAction({ payload }),
        }),
      "invalid_kagi_action",
    ),

  conversationSettings: () => appCall((client) => client.settings.conversation()),
  recallSettings: () => appCall((client) => client.settings.recall()),
  setRecallSettings: (settings: Partial<RecallSettings>) =>
    appCall(
      (client) => client.settings.setRecall({ payload: settings }),
      "invalid_recall_settings",
    ),
  setConversationSettings: (settings: ConversationSettings) =>
    appCall(
      (client) => client.settings.setConversation({ payload: settings }),
      "invalid_conversation_settings",
    ),
  kanbanSettings: () => appCall((client) => client.settings.kanban()),
  /** null goes back to the machine default. */
  setKanbanConcurrency: (concurrency: number | null) =>
    appCall(
      (client) =>
        client.settings.setKanban({
          payload: KanbanSettingsCommand.SetConcurrency({ concurrency }),
        }),
      "invalid_kanban_settings",
    ),
  /** Puts the project in front of `before` (or last) in the scheduler's order of projects. */
  moveProject: (projectId: string, before: string | null) =>
    appCall(
      (client) =>
        client.settings.setKanban({
          payload: KanbanSettingsCommand.MoveProject({ projectId, before }),
        }),
      "invalid_kanban_settings",
    ),
  projectKanban: (project: string) =>
    appCall((client) => client.projects.kanban({ params: { project } })),
  setProtectedBranches: (project: string, protectedBranches: readonly string[]) =>
    appCall(
      (client) =>
        client.projects.kanbanAction({
          params: { project },
          payload: ProjectKanbanCommand.SetProtectedBranches({ protectedBranches }),
        }),
      "invalid_kanban_settings",
    ),
  /** Puts the conversation's Goal in front of `before` (or last) among the project's Goals. */
  moveGoal: (project: string, sessionId: string, before: string | null) =>
    appCall(
      (client) =>
        client.projects.kanbanAction({
          params: { project },
          payload: ProjectKanbanCommand.MoveGoal({ sessionId, before }),
        }),
      "invalid_kanban_settings",
    ),

  imports: () => appCall((client) => client.settings.imports()),
  importAction: (command: ImportCommand) =>
    appCall(
      (client) =>
        ImportCommand.$match(command, {
          run: (payload) => client.settings.importAction({ payload }),
          restart_watch: (payload) => client.settings.importAction({ payload }),
          enable: (payload) => client.settings.importAction({ payload }),
          disable: (payload) => client.settings.importAction({ payload }),
          interpret: (payload) => client.settings.importAction({ payload }),
        }),
      "invalid_import_action",
    ),

  embedding: () => appCall((client) => client.settings.embedding()),
  embeddingAction: (command: EmbeddingCommand) =>
    appCall(
      (client) =>
        EmbeddingCommand.$match(command, {
          choose: (payload) => client.settings.embeddingAction({ payload }),
          check: (payload) => client.settings.embeddingAction({ payload }),
        }),
      "invalid_embedding_action",
    ),

  improvements: () => appCall((client) => client.settings.improvements()),
  improvementScan: (command: ScanCommand) =>
    appCall(
      (client) =>
        ScanCommand.$match(command, {
          start: (payload) => client.settings.improvementScan({ payload }),
          stop: (payload) => client.settings.improvementScan({ payload }),
        }),
      "invalid_command",
    ),

  mcpServers: (project: string) =>
    appCall((client) => client.projects.mcp({ params: { project } })),
  mcpAction: (project: string, command: McpCommand) =>
    appCall(
      (client) =>
        McpCommand.$match(command, {
          trust: (payload) => client.projects.mcpAction({ params: { project }, payload }),
          login: (payload) => client.projects.mcpAction({ params: { project }, payload }),
          cancelLogin: (payload) => client.projects.mcpAction({ params: { project }, payload }),
          logout: (payload) => client.projects.mcpAction({ params: { project }, payload }),
        }),
      "invalid_mcp_change",
    ),

  externalAgents: (project: string) =>
    appCall((client) => client.projects.agents({ params: { project } })),
  trustExternalAgent: (
    project: string,
    scope: ExternalAgentView["scope"],
    name: string,
    trusted: boolean,
  ) =>
    appCall(
      (client) =>
        client.projects.agentAction({
          params: { project },
          payload: ExternalAgentCommand.trust({ scope, name, trusted }),
        }),
      "invalid_agent_change",
    ),
  reconnectExternalAgent: (project: string, name: string) =>
    appCall(
      (client) =>
        client.projects.agentAction({
          params: { project },
          payload: ExternalAgentCommand.reconnect({ name }),
        }),
      "invalid_agent_change",
    ),

  skills: (project: string) => appCall((client) => client.projects.skills({ params: { project } })),

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
        if (response.status === 409 && ResumeTaskResult.guards.blocked(result)) return result;
        if (!response.ok)
          return yield* apiError(response.status, Option.getOrUndefined(decodeErrorBody(body)));
        if (!ResumeTaskResult.guards.queued(result)) return yield* apiError(502, undefined);
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
        if (response.status === 409 && ArchiveTaskResult.guards.blocked(result)) return result;
        if (!response.ok)
          return yield* apiError(response.status, Option.getOrUndefined(decodeErrorBody(body)));
        if (
          !isTruthy(result) ||
          !ArchiveTaskResult.isAnyOf(["completed", "waiting_for_stop"])(result)
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
        if (response.status === 409 && ArchiveTaskResult.guards.blocked(result)) return result;
        if (!response.ok)
          return yield* apiError(response.status, Option.getOrUndefined(decodeErrorBody(body)));
        if (
          !isTruthy(result) ||
          !ArchiveTaskResult.isAnyOf(["completed", "waiting_for_stop"])(result)
        )
          return yield* apiError(502, undefined);
        window.dispatchEvent(new CustomEvent("work-trace:changed"));
        return result;
      }),
    ),
  workTraceStreamUrl: (sessionId: string, after = 0) =>
    `/api/sessions/${encodeURIComponent(sessionId)}/trace/stream?after=${after}`,
  subagents: (session: string) =>
    appCall((client) => client.sessions.subagents({ params: { session } })),
  relayedApprovals: (session: string) =>
    appCall((client) => client.sessions.approvals({ params: { session } })),
  subagentTranscript: (session: string, subagent: string) =>
    appCall((client) => client.sessions.subagentTranscript({ params: { session, subagent } })),
  answerApproval: (session: string, holder: string, approval: string, approved: boolean) =>
    appCall(
      (client) =>
        client.sessions.answerApproval({
          params: { session, approval },
          headers: { "x-session-holder": holder },
          payload: { approved },
        }),
      "invalid_answer",
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

export function attachmentErrorMessage(error: ApiError | null) {
  if (error === null || !isTruthy(error.reason)) return "이미지를 올리지 못했어요.";
  return Schema.is(AttachmentRejection)(error.reason)
    ? attachmentRejections[error.reason]
    : error.reason;
}

/** The folder dialog's answer (POST /api/projects/pick). */
export { FolderPick };

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

export function projectErrorMessage(error: ApiError | null) {
  if (error === null || !isTruthy(error.reason)) return "프로젝트를 추가하지 못했어요.";
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

export function archiveErrorMessage(error: ApiError | null) {
  return error !== null && Schema.is(ArchiveRejection)(error.code)
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

export function compactErrorMessage(error: ApiError | null) {
  return error !== null && Schema.is(CompactRejection)(error.code)
    ? compactRejections[error.code]
    : "도구 출력을 비우지 못했어요.";
}

export const eventDecoders = {
  delivered: Schema.decodeUnknownOption(DeliveredEvent),
  context: Schema.decodeUnknownOption(ContextEvent),
};
