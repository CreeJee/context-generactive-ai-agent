import { browserCrypto } from "./shared/browser-crypto";
import { runUiEffect, uiPromise } from "./shared/ui-effect";
import { isTruthy } from "../truthy.ts";
import { Cause, Context, Data, Effect, Layer, ManagedRuntime, Match } from "effect";
import { FetchHttpClient, HttpClientError } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import {
  AppApi,
  AppRefusalCode,
  appRefusalStatus,
  type ConversationSettings,
  type EmbeddingCommand as EmbeddingCommandCase,
  type ExternalAgentCommand as ExternalAgentCommandCase,
  CrossProviderMediaRunApproval,
  FolderPick,
  type GeneratedImage,
  type ImageSettings,
  type ImageSettingsCommand as ImageSettingsCommandCase,
  type ImportCommand as ImportCommandCase,
  type ImprovementStatus,
  type KagiCommand as KagiCommandCase,
  type KanbanCommand as KanbanCommandCase,
  type KanbanSettings,
  type KanbanSettingsCommand as KanbanSettingsCommandCase,
  type KanbanView,
  LifecycleResult,
  type McpCommand as McpCommandCase,
  type ProjectKanbanCommand as ProjectKanbanCommandCase,
  type ProjectKanbanSettings,
  type ProjectSettings,
  type ProviderAuthState as ProviderAuthStateCase,
  type RecallSettings,
  ResumeTaskResult,
  type ScanCommand as ScanCommandCase,
  Session,
  type SessionChange as SessionChangeCase,
  type SubscriptionAccountCommand,
  SubscriptionAccountsView,
  WorkflowState,
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
  McpServerState as McpServerStateCase,
  McpServerView,
  ModelSelection,
  PermissionMode,
  Project,
  SkillCatalog,
  WorkflowAction,
  WorkflowPhase,
  AccountLoginState as AccountLoginStateCase,
  OAuthProfile,
  SubscriptionAccountProvider,
  SubscriptionQuotaReport,
} from "memory-agent";
import { Option, Schema } from "effect";
import { appFetch } from "./shared/backend-restart";
import {
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
  type UncertainRun,
  type UncertainTool,
} from "memory-agent/definitions";

/** What the page asks of one conversation, as `/api/sessions/:session` reads it. */
export type SessionChange = SessionChangeCase;
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

export type GeneratedImageAsset = GeneratedImage;
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

/**
 * Codes the page gives itself: a value the contract refuses before it is sent, a call or upload
 * that failed otherwise, the development backend asking for a restart, and the attachment upload
 * route's refusal.
 */
const PageErrorCode = Schema.Literals([
  "invalid_request",
  "request_failed",
  "upload_failed",
  "backend_restart_required",
  "backend_restarting",
  "attachment_rejected",
]);

/** Every error code the browser API understands: the app API's refusals and the page's own. */
export const ApiErrorCode = Schema.Union([AppRefusalCode, PageErrorCode]);
export type ApiErrorCode = typeof ApiErrorCode.Type;

export type { ConversationSettings, ImprovementStatus, KanbanSettings, RecallSettings };
/** The commands `/api/settings/kanban` reads. */
export type KanbanSettingsCommand = KanbanSettingsCommandCase;
export const KanbanSettingsCommand = Data.taggedEnum<KanbanSettingsCommand>();
export type { ProjectKanbanSettings };
/** The commands `/api/projects/:project/kanban` reads. */
export type ProjectKanbanCommand = ProjectKanbanCommandCase;
export const ProjectKanbanCommand = Data.taggedEnum<ProjectKanbanCommand>();

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
/** A task's retry: queued for the next parent run, or why it cannot be. */
export { ResumeTaskResult };
/** A task's or conversation's archive, restore or delete: done, waiting, or blocked. */
export const ArchiveTaskResult = LifecycleResult;
export type ArchiveTaskResult = LifecycleResult;
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

/** The server answered with a value its contract does not allow: the server's fault, not the page's. */
class UnexpectedAnswer extends Data.TaggedError("UnexpectedAnswer")<{
  readonly cause?: Schema.SchemaError;
}> {}
const unexpectedAnswer = () => new UnexpectedAnswer({});

const makeAppApiClient = HttpApiClient.make(AppApi, {
  // The client fails with `SchemaError` for a request and for a response alike; a response the
  // contract refuses is the server's fault, so it is told apart here.
  transformResponse: Effect.catchIf(Schema.isSchemaError, (cause) =>
    Effect.fail(new UnexpectedAnswer({ cause })),
  ),
});

/** The app API (`memory-agent/app-api`), called over `appFetch` like the chat API. */
class AppApiClient extends Context.Service<AppApiClient, Effect.Success<typeof makeAppApiClient>>()(
  "agent/app/entry/api/AppApiClient",
) {
  static readonly layer = Layer.effect(AppApiClient, makeAppApiClient);
}

/**
 * What an app API call fails with: a refusal the endpoint declares, the call itself failing, a
 * request the contract refuses (`SchemaError`), or an answer it refuses (`UnexpectedAnswer`).
 */
type AppApiFailure =
  | {
      readonly error: ApiErrorCode;
      readonly reason?: string;
      readonly approval?: CrossProviderMediaRunApproval;
    }
  | HttpClientError.HttpClientError
  | Schema.SchemaError
  | UnexpectedAnswer;

/**
 * A call that failed outside the endpoint's refusals. A transport failure keeps its cause, as
 * `appFetch` rejected with it; a status the endpoint does not declare is read from its body's
 * `error` and `reason`, or is `request_failed`.
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

/**
 * The page's `ApiError` for a failed app API call. A value the contract refuses before it is sent
 * is 400 `invalid_request`; an answer it refuses is 502 `request_failed`.
 */
const appApiFailure = Match.type<AppApiFailure>().pipe(
  Match.when(Schema.isSchemaError, () => Effect.fail(apiError(400, { error: "invalid_request" }))),
  Match.when(HttpClientError.isHttpClientError, clientFailure),
  Match.when({ _tag: "UnexpectedAnswer" }, () =>
    Effect.fail(apiError(502, { error: "request_failed" })),
  ),
  Match.orElse((refusal) => Effect.fail(apiError(appRefusalStatus(refusal), refusal))),
);

/**
 * Calls the app API through a client over `fetch`; a failure is an `ApiError` with the refusal's
 * status and code.
 * The page's calls go over `appFetch`.
 */
const appCallOver = (fetch: typeof globalThis.fetch) => {
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      AppApiClient.layer.pipe(Layer.provide(FetchHttpClient.layer)),
      Layer.succeed(FetchHttpClient.Fetch, fetch),
    ),
  );
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  return <A, E extends AppApiFailure>(
    request: (client: AppApiClient["Service"]) => Effect.Effect<A, E>,
  ): Promise<A> =>
    runUiEffect(
      Effect.flatMap(runtime.contextEffect, (context) =>
        Effect.flatMap(AppApiClient, request).pipe(
          Effect.catch(appApiFailure),
          Effect.provideContext(context),
        ),
      ),
    );
};
const appCall = appCallOver(appFetch);

/**
 * Archives, restores and deletes conversations over `fetch`; `api` uses `appFetch`. A change that
 * cannot start (409) or is still waiting (202) comes back as the result, not as a failure.
 */
export function makeSessionLifecycleClient(fetch: typeof globalThis.fetch) {
  const call = appCallOver(fetch);
  return {
    /** Active parent/child runs are checkpointed and stopped before the conversation is archived. */
    setArchived: (session: string, holder: string, archived: boolean) =>
      call((client) =>
        Effect.flatMap(Effect.orDie(browserCrypto.randomUUIDv4()), (idempotencyKey) =>
          client.sessions.change({
            params: { session },
            headers: { "x-session-holder": holder },
            payload: SessionChange.Archive({ archived, idempotencyKey }),
          }),
        ).pipe(
          Effect.catchTag("blocked", Effect.succeed),
          Effect.flatMap(
            (result): Effect.Effect<SessionArchiveResult, ReturnType<typeof unexpectedAnswer>> =>
              Schema.is(Session)(result) && result.id === session
                ? Effect.succeed(SessionArchiveResult.completed({ session: result }))
                : ArchiveTaskResult.guards.waiting_for_stop(result) ||
                    ArchiveTaskResult.guards.blocked(result)
                  ? Effect.succeed(result)
                  : Effect.fail(unexpectedAnswer()),
          ),
        ),
      ),
    deleteSession: (session: string, holder: string) =>
      call((client) =>
        Effect.flatMap(Effect.orDie(browserCrypto.randomUUIDv4()), (idempotencyKey) =>
          client.sessions.change({
            params: { session },
            headers: { "x-session-holder": holder },
            payload: SessionChange.Delete({ idempotencyKey }),
          }),
        ).pipe(
          Effect.catchTag("blocked", Effect.succeed),
          Effect.filterOrFail(Schema.is(ArchiveTaskResult), unexpectedAnswer),
        ),
      ),
  };
}

/** Moves or pauses the workflow; it answers the workflow, and anything else is the server's fault. */
const changeWorkflow = (
  session: string,
  holder: string,
  change: Extract<SessionChange, { readonly _tag: "Phase" | "Control" }>,
) =>
  appCall((client) => {
    const request = { params: { session }, headers: { "x-session-holder": holder } };
    // The client takes a union payload one case at a time.
    return Match.valueTags(change, {
      Phase: (payload) => client.sessions.change({ ...request, payload }),
      Control: (payload) => client.sessions.change({ ...request, payload }),
    }).pipe(
      Effect.catchTag("blocked", () => Effect.fail(unexpectedAnswer())),
      Effect.filterOrFail(Schema.is(WorkflowState), unexpectedAnswer),
    );
  });

/**
 * Archives or deletes one task. A change that cannot start (409) or is still waiting (202) comes
 * back as the result; one that went ahead tells the trace views to reread.
 */
const changeTraceTask = (
  session: string,
  holder: string,
  task: string,
  intent: "archive" | "delete",
) =>
  appCall((client) =>
    Effect.flatMap(Effect.orDie(browserCrypto.randomUUIDv4()), (idempotencyKey) =>
      client.trace.changeTask({
        params: { session, task },
        headers: { "x-session-holder": holder },
        payload: { intent, idempotencyKey },
      }),
    ).pipe(
      Effect.catchTag("blocked", Effect.succeed),
      Effect.filterOrFail(Schema.is(ArchiveTaskResult), unexpectedAnswer),
      Effect.tap((result) =>
        Effect.when(
          Effect.sync(() => window.dispatchEvent(new CustomEvent("work-trace:changed"))),
          Effect.succeed(!ArchiveTaskResult.guards.blocked(result)),
        ),
      ),
    ),
  );

/** Changes the project's settings that `payload` names; the others stay as they are. */
const updateProject = (project: string, payload: ProjectSettings) =>
  appCall((client) => client.projects.update({ params: { project }, payload }));

/**
 * `/api/accounts` answers a subscription provider with its profiles; another view would be the
 * server's fault.
 */
const subscriptionView = Effect.filterOrFail(Schema.is(SubscriptionAccountsView), unexpectedAnswer);

export const api = {
  auth: (provider: ProviderId) => appCall((client) => client.auth.status({ query: { provider } })),
  authAction: (intent: "login" | "cancel" | "logout", provider: SubscriptionAccountProvider) =>
    appCall((client) => client.auth.action({ payload: { intent, provider } })),

  accounts: (provider: SubscriptionAccountProvider) =>
    appCall((client) => client.accounts.list({ query: { provider } }).pipe(subscriptionView)),
  accountAction: (provider: SubscriptionAccountProvider, action: AccountAction) =>
    appCall((client) =>
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
    ),
  accountQuota: (provider: SubscriptionAccountProvider) =>
    appCall((client) => client.accounts.quota({ query: { provider } })),

  models: (provider: ProviderId) =>
    appCall((client) => client.models.list({ query: { provider } })),
  selectModel: (model: string, reasoningEffort: string | undefined, provider: ProviderId) =>
    appCall((client) =>
      client.models.select({ params: { model }, payload: { provider, reasoningEffort } }),
    ),

  projects: () => appCall((client) => client.projects.list({ query: {} })),
  addProject: (root: string) => appCall((client) => client.projects.add({ payload: { root } })),
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

  sessions: (project: string) => appCall((client) => client.sessions.list({ query: { project } })),
  archivedSessions: (project: string) =>
    appCall((client) => client.sessions.list({ query: { project, archived: "1" } })),
  ...makeSessionLifecycleClient(appFetch),
  /** Refused while a run is active; execute requires a current Plan that is ready or executing. */
  setWorkflowPhase: (session: string, holder: string, phase: WorkflowPhase) =>
    changeWorkflow(session, holder, SessionChange.Phase({ phase })),
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
    }),
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
    appCall((client) =>
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
    ),
  kanban: (session: string): Promise<KanbanView> =>
    appCall((client) => client.sessions.kanban({ params: { session } })),
  /** Runs the executing Plan as a kanban board. */
  startKanban: (session: string, holder: string) =>
    appCall((client) =>
      client.sessions.kanbanAction({
        params: { session },
        headers: { "x-session-holder": holder },
        payload: KanbanCommand.Start(),
      }),
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
    }),
  /** Runs the board's loop again after it stopped on exhausted retries or a defect. */
  restartKanbanLoop: (session: string, holder: string) =>
    appCall((client) =>
      client.sessions.kanbanAction({
        params: { session },
        headers: { "x-session-holder": holder },
        payload: KanbanCommand.RestartLoop(),
      }),
    ),
  /** The Goals this Goal waits for; an empty list lifts the wait. */
  setGoalDependencies: (session: string, holder: string, dependsOn: readonly string[]) =>
    appCall((client) =>
      client.sessions.kanbanAction({
        params: { session },
        headers: { "x-session-holder": holder },
        payload: KanbanCommand.SetDependencies({ dependsOn }),
      }),
    ),
  controlWorkflow: (session: string, holder: string, workflowAction: WorkflowAction) =>
    changeWorkflow(session, holder, SessionChange.Control({ workflowAction })),
  /** `agent`: talk directly to that trusted external ACP agent instead of the app's model. */
  createSession: (projectId: string, agent?: string) =>
    appCall((client) => client.sessions.create({ payload: { projectId, agent } })),
  btwThreads: (session: string) => appCall((client) => client.btw.list({ params: { session } })),
  /** A new BTW thread bound for good to this conversation. */
  createBtw: (session: string) => appCall((client) => client.btw.create({ params: { session } })),
  /** `filesPending`: the rows are gone, some unreferenced image files wait for the next cleanup. */
  deleteBtw: (thread: string) => appCall((client) => client.btw.remove({ params: { thread } })),
  sessionRunState: (session: string, holder: string) =>
    appCall((client) => client.sessions.status({ params: { session }, query: { holder } })),
  cancelRun: (session: string, holder: string) =>
    appCall((client) =>
      client.sessions.cancel({ params: { session }, headers: { "x-session-holder": holder } }),
    ),
  discardInterrupts: (session: string, holder: string) =>
    appCall((client) =>
      client.sessions.discardInterrupts({
        params: { session },
        headers: { "x-session-holder": holder },
      }),
    ),
  /** Refused with 409 while something runs, or when the listed runs changed since they were shown. */
  continuePastUncertain: (session: string, holder: string, runIds: readonly string[]) =>
    appCall((client) =>
      client.sessions.continuePastUncertain({
        params: { session },
        headers: { "x-session-holder": holder },
        payload: { runIds },
      }),
    ),
  /** Refused with 409 while the session is answering. */
  compactSession: (session: string, holder: string) =>
    appCall((client) =>
      client.sessions.compact({ params: { session }, headers: { "x-session-holder": holder } }),
    ),
  leaseAction: (session: string, holder: string, action: "claim" | "release") =>
    appCall((client) =>
      client.sessions.lease({ params: { session }, payload: { holder, action } }),
    ),

  queue: (session: string) => appCall((client) => client.sessions.queue({ params: { session } })),
  enqueue: (
    session: string,
    holder: string,
    payload: { text: string; attachmentIds: readonly string[]; mode: "queue" | "steer" },
  ) =>
    appCall((client) =>
      client.sessions.enqueue({
        params: { session },
        headers: { "x-session-holder": holder },
        payload,
      }),
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
    }),
  imageSettings: () => appCall((client) => client.settings.image()),
  setImageGenerationEnabled: (enabled: boolean) =>
    appCall((client) =>
      client.settings.imageAction({
        payload: ImageSettingsCommand.image_generation({ enabled }),
      }),
    ),
  setCrossProviderMediaConsent: (mode: CrossProviderMediaConsentMode) =>
    appCall((client) =>
      client.settings.imageAction({
        payload: ImageSettingsCommand.cross_provider_media({ mode }),
      }),
    ),
  generateImage: (
    prompt: string,
    approved: boolean,
    crossProviderApproval?: CrossProviderMediaRunApproval,
  ) =>
    appCall((client) =>
      client.media.generateImage({
        payload:
          crossProviderApproval === undefined
            ? { prompt, approved }
            : { prompt, approved, runId: crossProviderApproval.runId, crossProviderApproval },
      }),
    ),

  kagi: () => appCall((client) => client.settings.kagi()),
  // The client takes a union payload one case at a time.
  kagiAction: (command: KagiCommand) =>
    appCall((client) =>
      KagiCommand.$match(command, {
        register: (payload) => client.settings.kagiAction({ payload }),
        remove: (payload) => client.settings.kagiAction({ payload }),
        enable: (payload) => client.settings.kagiAction({ payload }),
        disable: (payload) => client.settings.kagiAction({ payload }),
      }),
    ),

  conversationSettings: () => appCall((client) => client.settings.conversation()),
  recallSettings: () => appCall((client) => client.settings.recall()),
  setRecallSettings: (settings: Partial<RecallSettings>) =>
    appCall((client) => client.settings.setRecall({ payload: settings })),
  setConversationSettings: (settings: ConversationSettings) =>
    appCall((client) => client.settings.setConversation({ payload: settings })),
  kanbanSettings: () => appCall((client) => client.settings.kanban()),
  /** null goes back to the machine default. */
  setKanbanConcurrency: (concurrency: number | null) =>
    appCall((client) =>
      client.settings.setKanban({
        payload: KanbanSettingsCommand.SetConcurrency({ concurrency }),
      }),
    ),
  /** Puts the project in front of `before` (or last) in the scheduler's order of projects. */
  moveProject: (projectId: string, before: string | null) =>
    appCall((client) =>
      client.settings.setKanban({
        payload: KanbanSettingsCommand.MoveProject({ projectId, before }),
      }),
    ),
  projectKanban: (project: string) =>
    appCall((client) => client.projects.kanban({ params: { project } })),
  setProtectedBranches: (project: string, protectedBranches: readonly string[]) =>
    appCall((client) =>
      client.projects.kanbanAction({
        params: { project },
        payload: ProjectKanbanCommand.SetProtectedBranches({ protectedBranches }),
      }),
    ),
  /** Puts the conversation's Goal in front of `before` (or last) among the project's Goals. */
  moveGoal: (project: string, sessionId: string, before: string | null) =>
    appCall((client) =>
      client.projects.kanbanAction({
        params: { project },
        payload: ProjectKanbanCommand.MoveGoal({ sessionId, before }),
      }),
    ),

  imports: () => appCall((client) => client.settings.imports()),
  importAction: (command: ImportCommand) =>
    appCall((client) =>
      ImportCommand.$match(command, {
        run: (payload) => client.settings.importAction({ payload }),
        restart_watch: (payload) => client.settings.importAction({ payload }),
        enable: (payload) => client.settings.importAction({ payload }),
        disable: (payload) => client.settings.importAction({ payload }),
        interpret: (payload) => client.settings.importAction({ payload }),
      }),
    ),

  embedding: () => appCall((client) => client.settings.embedding()),
  embeddingAction: (command: EmbeddingCommand) =>
    appCall((client) =>
      EmbeddingCommand.$match(command, {
        choose: (payload) => client.settings.embeddingAction({ payload }),
        check: (payload) => client.settings.embeddingAction({ payload }),
      }),
    ),

  improvements: () => appCall((client) => client.settings.improvements()),
  improvementScan: (command: ScanCommand) =>
    appCall((client) =>
      ScanCommand.$match(command, {
        start: (payload) => client.settings.improvementScan({ payload }),
        stop: (payload) => client.settings.improvementScan({ payload }),
      }),
    ),

  mcpServers: (project: string) =>
    appCall((client) => client.projects.mcp({ params: { project } })),
  mcpAction: (project: string, command: McpCommand) =>
    appCall((client) =>
      McpCommand.$match(command, {
        trust: (payload) => client.projects.mcpAction({ params: { project }, payload }),
        login: (payload) => client.projects.mcpAction({ params: { project }, payload }),
        cancelLogin: (payload) => client.projects.mcpAction({ params: { project }, payload }),
        logout: (payload) => client.projects.mcpAction({ params: { project }, payload }),
      }),
    ),

  externalAgents: (project: string) =>
    appCall((client) => client.projects.agents({ params: { project } })),
  trustExternalAgent: (
    project: string,
    scope: ExternalAgentView["scope"],
    name: string,
    trusted: boolean,
  ) =>
    appCall((client) =>
      client.projects.agentAction({
        params: { project },
        payload: ExternalAgentCommand.trust({ scope, name, trusted }),
      }),
    ),
  reconnectExternalAgent: (project: string, name: string) =>
    appCall((client) =>
      client.projects.agentAction({
        params: { project },
        payload: ExternalAgentCommand.reconnect({ name }),
      }),
    ),

  skills: (project: string) => appCall((client) => client.projects.skills({ params: { project } })),

  projectWorkTrace: (project: string) =>
    appCall((client) => client.trace.projectTree({ params: { project } })),
  projectWorkTraceTask: (project: string, task: string) =>
    appCall((client) => client.trace.projectTask({ params: { project, task } })),
  workTrace: (session: string) =>
    appCall((client) => client.trace.sessionTree({ params: { session } })),
  workTraceTask: (session: string, task: string) =>
    appCall((client) => client.trace.sessionTask({ params: { session, task } })),
  resumeWorkTraceTask: (
    session: string,
    holder: string,
    task: string,
    expectedAttemptId: string,
    confirmUncertain = false,
  ) =>
    appCall((client) =>
      client.trace
        .changeTask({
          params: { session, task },
          headers: { "x-session-holder": holder },
          payload: { intent: "resume", expectedAttemptId, confirmUncertain },
        })
        .pipe(
          // A safety refusal is an expected action result, not a transport failure.
          Effect.catchTag("blocked", Effect.succeed),
          Effect.filterOrFail(Schema.is(ResumeTaskResult), unexpectedAnswer),
        ),
    ),
  archiveWorkTraceTask: (session: string, holder: string, task: string) =>
    changeTraceTask(session, holder, task, "archive"),
  deleteWorkTraceTask: (session: string, holder: string, task: string) =>
    changeTraceTask(session, holder, task, "delete"),
  workTraceStreamUrl: (sessionId: string, after = 0) =>
    `/api/sessions/${encodeURIComponent(sessionId)}/trace/stream?after=${after}`,
  subagents: (session: string) =>
    appCall((client) => client.sessions.subagents({ params: { session } })),
  relayedApprovals: (session: string) =>
    appCall((client) => client.sessions.approvals({ params: { session } })),
  subagentTranscript: (session: string, subagent: string) =>
    appCall((client) => client.sessions.subagentTranscript({ params: { session, subagent } })),
  answerApproval: (session: string, holder: string, approval: string, approved: boolean) =>
    appCall((client) =>
      client.sessions.answerApproval({
        params: { session, approval },
        headers: { "x-session-holder": holder },
        payload: { approved },
      }),
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
