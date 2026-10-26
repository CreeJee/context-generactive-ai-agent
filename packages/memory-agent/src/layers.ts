import { Function as EffectFunction, Schema } from "effect";
import { nodePlatformLayer } from "./runtime/node-platform.ts";
import { path } from "./runtime/synchronous-path.ts";
const { join } = path;
import { optionalProperty } from "./optional-property.ts";
import { Effect, Layer } from "effect";
import { ProviderUnavailable, type ProviderId } from "./providers/contracts.ts";
import {
  AgentChat,
  ChatLoop,
  GoalWorkerConfiguration,
  type GoalWorkerOptions,
} from "./agent/chat.ts";
import { BtwChat } from "./btw/chat.ts";
import { ProjectImprovement } from "./improve/discovery.ts";
import { ApiUsage } from "./agent/api-usage.ts";
import { TurnSummaries } from "./agent/turn-summaries.ts";
import { ReportDiagnoser } from "./report/diagnosis.ts";
import { ChatState } from "./chat-state/chat-state.ts";
import { RunStore } from "./loop/store.ts";
import { RelayedApprovals } from "./approvals/relayed.ts";
import { Attachments } from "./attachments/attachments.ts";
import { DrawingPreviews } from "./attachments/previews.ts";
import { GlobalConfig } from "./config/global-config.ts";
import { KanbanSettings } from "./config/kanban-settings.ts";
import {
  persistedQueueCleanupLayer,
  persistedQueueStoreLayer,
} from "./kanban/persisted-queue-store.ts";
import { HumanDecisions } from "./kanban/human-decision.ts";
import { gitCardWorktreesLayer } from "./kanban/git-worktrees.ts";
import { KanbanBoardActions } from "./kanban/board-actions.ts";
import { CardAttempts } from "./kanban/card-attempts.ts";
import {
  cardAttemptExecutionLayer,
  cardQueueFactoryLayer,
  CardQueueGate,
  cardQueueWorkerLayer,
  CardRuns,
} from "./kanban/card-queue.ts";
import { KanbanOrchestrator } from "./kanban/orchestrator.ts";
import { subagentCardAgentsLayer } from "./kanban/subagent-card-agent.ts";
import { GoalOrder } from "./kanban/goal-order.ts";
import { GoalSchedules } from "./kanban/goal-schedules.ts";
import { BoardHealth } from "./kanban/board-health.ts";
import { GoalMerges } from "./kanban/merge-queue.ts";
import { ProjectScheduler } from "./kanban/scheduler.ts";
import { KanbanTools } from "./kanban/tools.ts";
import { ownerWorkflowEngineLayer } from "./workflow/owner-workflow-engine.ts";
import { SecretStore } from "./config/secrets.ts";
import { SubscriptionQuota, SubscriptionUsage } from "./oauth/subscription-quota.ts";
import { defectReportsLayer } from "./report/defect-reports.ts";
import { ReportDelivery } from "./report/discord-webhook.ts";
import { StorageRoot } from "./config/storage-root.ts";
import { Database } from "./db/database.ts";
import { AppEvents } from "./events/app-events.ts";
import { Kagi } from "./kagi/kagi.ts";
import { ExternalAgents } from "./external-agents/agents.ts";
import { BulkNodes } from "./imports/bulk.ts";
import { Importer } from "./imports/importer.ts";
import { McpServers } from "./mcp/servers.ts";
import { Skills } from "./skills/skills.ts";
import { Subagents } from "./subagents/subagents.ts";
import { Embedder } from "./memory/embedding/embedder.ts";
import { MorphAnalyzer } from "./memory/morph/analyzer.ts";
import { Indexer } from "./memory/embedding/indexer.ts";
import { EmbeddingSetup } from "./memory/embedding/setup.ts";
import { VectorIndex } from "./memory/embedding/vector-index.ts";
import { Graph } from "./memory/graph.ts";
import { Interpreter } from "./memory/interpret.ts";
import { Interpretations } from "./memory/interpretations.ts";
import { KnowledgePromotions } from "./memory/knowledge.ts";
import { Nodes } from "./memory/nodes.ts";
import { Recorder } from "./memory/record.ts";
import { MemorySearch } from "./memory/search.ts";
import { PermissionClassifier } from "./permissions/classifier.ts";
import { SecretRedactor } from "./secrets/redactor.ts";
import { SecretSweep } from "./secrets/sweep.ts";
import { PermissionGate } from "./permissions/gate.ts";
import { PermissionReviews } from "./permissions/reviews.ts";
import { Projects } from "./projects/projects.ts";
import { ActiveProvider } from "./providers/active-provider.ts";
import { CrossProviderMediaConsent } from "./providers/cross-provider-media-consent.ts";
import { ProviderRegistry } from "./providers/registry.ts";
import { AccountSubscriptionProviderRegistry } from "./providers/subscriptions.ts";
import { OAuthProfiles } from "./oauth/accounts.ts";
import { OAuthAccountLogins } from "./oauth/account-login.ts";
import {
  ProviderToolCapabilityRegistry,
  providerToolDescriptors,
} from "./providers/tool-capabilities.ts";
import { ModelFeatureFlags } from "./providers/model-feature-flags.ts";
import { ProviderToolPolicy, ProviderToolRuntime } from "./providers/tool-policy.ts";
import { RouteCatalog } from "./providers/route-catalog.ts";
import { ImageFeature } from "./providers/image-feature.ts";
import { DirectImageExecutor, ImageMediaWorkflow } from "./providers/image-media.ts";
import { ImageRouteFacts, ImageRouter } from "./providers/image-router.ts";
import { QueueDelivery } from "./queue/delivery.ts";
import { MessageQueue } from "./queue/queue.ts";
import { SessionLeases } from "./sessions/leases.ts";
import { Sessions } from "./sessions/sessions.ts";
import { ApprovedTools } from "./tools/approved.ts";
import { CodeSkills } from "./skills/code-skills.ts";
import { BackgroundTasks } from "./tools/background.ts";
import { CodeTools } from "./tools/code.ts";
import { FileTools } from "./tools/files.ts";
import { DelegateTools } from "./tools/delegate.ts";
import { KagiTools } from "./tools/kagi.ts";
import { SkillTools } from "./tools/skills.ts";
import { MemoryTools } from "./tools/memory.ts";
import { OutsideTools } from "./tools/outside.ts";
import { WorkTraceStore } from "./work-trace/store.ts";
import { Workflows } from "./workflow/workflow.ts";
import { Boards } from "./workflow/board.ts";
import { WorkflowExecution } from "./workflow/execution.ts";
import { goalExecutionLayer } from "./workflow/goal-execution.ts";
import { providerRetryLayer } from "./workflow/provider-retry.ts";
import { OwnerReadRecovery } from "./agent/owner-read-recovery.ts";
import { WorkflowTools } from "./workflow/tools.ts";
import { WorkflowRules } from "./workflow/rules.ts";
import { OpenAICompatibleSettings } from "./providers/openai-compatible.ts";
import {
  ExecutionAdmission,
  type ExecutionAdmissionLimits,
} from "./runtime/execution-admission.ts";

export interface MemoryAgentLayerOptions {
  readonly goalWorker?: GoalWorkerOptions;
  /** The loop of chat runs; TanStack's until step 7 of docs/effect-ai-migration.md. */
  readonly chatLoop?: typeof ChatLoop.Service;
  readonly executionAdmission?: ExecutionAdmissionLimits;
  readonly openDatabase?: Parameters<typeof Database.layer>[1];
  /** Isolated evaluation transport; production uses its endpoint-bound keyring. */
  readonly compatibleSettings?: Layer.Layer<OpenAICompatibleSettings, never, GlobalConfig>;
  /** Defaults to the local embedding model; tests pass a deterministic one. */
  readonly embedder?: Layer.Layer<Embedder, never, StorageRoot | GlobalConfig>;
  /** Defaults to Kiwi (model downloaded on first use); tests pass a deterministic one. */
  readonly morphAnalyzer?: Layer.Layer<MorphAnalyzer, never, StorageRoot>;
  /** Provider-neutral registry override for tests. Production uses subscription providers. */
  readonly providerRegistry?: Layer.Layer<ProviderRegistry, never, GlobalConfig>;
  /** Provider Tool capability metadata override; it never executes tools or enforces policy. */
  readonly providerToolRegistry?: Layer.Layer<ProviderToolCapabilityRegistry>;
  /** Persisted model-dependent feature flag service override for tests. */
  readonly modelFeatureFlags?: Layer.Layer<ModelFeatureFlags>;
  /** Explicit provider-pair media consent override for tests. */
  readonly crossProviderMediaConsent?: Layer.Layer<CrossProviderMediaConsent>;
  /** Server-authoritative Provider Tool policy override for tests. */
  readonly providerToolPolicy?: Layer.Layer<ProviderToolPolicy>;
  /** Provider Tool lifecycle runtime override; no tools are exposed without explicit inputs. */
  readonly providerToolRuntime?: Layer.Layer<ProviderToolRuntime>;
  /** Chat, media and execution route catalog override for deterministic tests. */
  readonly routeCatalog?: Layer.Layer<RouteCatalog>;
  /** Account-specific image availability, cost and performance evidence. */
  readonly imageRouteFacts?: Layer.Layer<ImageRouteFacts>;
  /** Deterministic image routing override; production uses the catalog and route facts. */
  readonly imageRouter?: Layer.Layer<ImageRouter>;
  /** Server-authoritative image feature/settings gate override. */
  readonly imageFeature?: Layer.Layer<ImageFeature>;
  /** Direct image execution override. Production remains unavailable until explicitly configured. */
  readonly directImageExecutor?: Layer.Layer<DirectImageExecutor>;
  /** Separate durable media workflow override. */
  readonly imageMediaWorkflow?: Layer.Layer<ImageMediaWorkflow>;
  /** How long a page keeps a session without renewing; tests shorten it. */
  readonly leaseTtlMs?: number;
  /** Interpret statements in the background after each run. Default true; tests turn it off. */
  readonly interpretAutomatically?: boolean;
  /** Summarize earlier turns in the background after each run. Default true; tests turn it off. */
  readonly summarizeAutomatically?: boolean;
  /** Defaults to the OS keychain; tests keep secrets in memory. */
  readonly secrets?: Layer.Layer<SecretStore>;
  /** Defaults to Kagi's API server; tests point it at a local one. */
  readonly kagiBaseUrl?: string;
  /** Home directory whose `.agents/skills` holds global skills; tests use a temporary one. */
  readonly skillsHome?: string;
  /** Directory of the app's own skills; tests use an empty one so only what they write is listed. */
  readonly skillsBuiltin?: string;
  /**
   * Home directory holding other coding agents' transcripts (`.claude`, `.codex`), and whether to
   * keep following them in the background. Default: the real home, following. Tests set both.
   */
  readonly importsHome?: string;
  readonly importsWatching?: boolean;
  /**
   * Sweep secrets out of text stored before they were hidden on the way in, in the background at
   * start. Default true; tests run the sweep themselves.
   */
  readonly sweepSecrets?: boolean;
  /** Folder holding kanban card worktrees; tests use a temporary one. */
  readonly kanbanWorktreesBase?: string;
}

/** Composition root: every memory-agent service backed by one storage directory. */
export const memoryAgentLayer: {
  (
    options: MemoryAgentLayerOptions,
  ): (storageRoot: string) => ReturnType<typeof memoryAgentLayerBody>;
  (storageRoot: string): ReturnType<typeof memoryAgentLayerBody>;
  (storageRoot: string, options: MemoryAgentLayerOptions): ReturnType<typeof memoryAgentLayerBody>;
} = EffectFunction.dual((args) => Schema.is(Schema.String)(args[0]), memoryAgentLayerBody);
function memoryAgentLayerBody(storageRoot: string, options: MemoryAgentLayerOptions = {}) {
  // Each tier only depends on the tiers below it.
  // The settings are read by services in every tier above, the embedder among them.
  // Defects anywhere above are reported through the webhook the report page uses, when one is set.
  const defectReports = defectReportsLayer.pipe(
    Layer.provide(Layer.merge(ReportDelivery.layer(), SecretRedactor.layer)),
  );
  const foundation = OAuthProfiles.layer.pipe(
    Layer.provideMerge(defectReports),
    Layer.provideMerge(
      GlobalConfig.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            StorageRoot.layer(storageRoot),
            Database.layer(join(storageRoot, "agent.db"), options.openDatabase),
            ExecutionAdmission.layer(options.executionAdmission),
          ),
        ),
        Layer.provideMerge(nodePlatformLayer),
      ),
    ),
  );
  const compatibleSettings = (options.compatibleSettings ?? OpenAICompatibleSettings.layer).pipe(
    Layer.provide(foundation),
  );
  const providerRegistry =
    options.providerRegistry ??
    Layer.effect(
      ProviderRegistry,
      Effect.gen(function* () {
        const subscriptions = yield* ProviderRegistry;
        const settings = yield* OpenAICompatibleSettings;
        const compatible = settings.services;
        return {
          ...subscriptions,
          providers: [...subscriptions.providers, compatible.provider],
          get: (provider: ProviderId) =>
            provider === compatible.provider
              ? Effect.succeed(compatible)
              : subscriptions.get(provider),
          runtime: (provider: ProviderId) =>
            provider === compatible.provider
              ? settings.runtime.pipe(Effect.mapError(() => ProviderUnavailable.make({ provider })))
              : subscriptions.runtime(provider),
        };
      }),
    ).pipe(Layer.provide(AccountSubscriptionProviderRegistry), Layer.provide(compatibleSettings));
  const providerToolRegistry = options.providerToolRegistry ?? ProviderToolCapabilityRegistry.layer;
  const modelFeatureFlags =
    options.modelFeatureFlags ??
    ModelFeatureFlags.layer(providerToolDescriptors.map((descriptor) => descriptor.id)).pipe(
      Layer.provide(foundation),
    );
  const crossProviderMediaConsent =
    options.crossProviderMediaConsent ??
    CrossProviderMediaConsent.layer.pipe(Layer.provide(foundation));
  const providerToolPolicy =
    options.providerToolPolicy ??
    ProviderToolPolicy.featureFlagLayer.pipe(
      Layer.provide(modelFeatureFlags),
      Layer.provide(providerToolRegistry),
    );
  const providerToolRuntime =
    options.providerToolRuntime ??
    ProviderToolRuntime.layer.pipe(
      Layer.provide(providerToolPolicy),
      Layer.provide(providerToolRegistry),
    );
  // One store per owner: the cleanup schedule shares it with the card queue.
  const persistedQueueStore = persistedQueueStoreLayer();
  const kanban = Layer.mergeAll(
    persistedQueueStore,
    persistedQueueCleanupLayer().pipe(Layer.provide(persistedQueueStore)),
    KanbanSettings.layer(),
    gitCardWorktreesLayer(options.kanbanWorktreesBase),
    HumanDecisions.layer,
  );
  const stores = Layer.mergeAll(
    kanban,
    AppEvents.layer,
    ApiUsage.layer,
    Projects.layer,
    Nodes.layer,
    PermissionReviews.layer,
    Attachments.layer,
    SessionLeases.layer(options.leaseTtlMs),
    MessageQueue.layer,
    Interpretations.layer,
    RelayedApprovals.layer,
    BulkNodes.layer,
    SecretRedactor.layer,
    Workflows.layer,
    Boards.layer.pipe(Layer.provide(GoalOrder.layer)),
    WorkflowExecution.layer,
    goalExecutionLayer,
    providerRetryLayer,
    OwnerReadRecovery.layer,
    WorkTraceStore.layer,
    OAuthAccountLogins.layer,
    SubscriptionQuota.layer.pipe(Layer.provide(SubscriptionUsage.layer)),
    providerToolRegistry,
    modelFeatureFlags,
    crossProviderMediaConsent,
    providerToolPolicy,
    providerToolRuntime,
    options.embedder ?? Embedder.local,
    options.morphAnalyzer ?? MorphAnalyzer.kiwi,
    options.secrets ?? SecretStore.keychain,
  );
  const memory = Layer.mergeAll(
    Sessions.layer,
    Recorder.layer,
    KnowledgePromotions.layer,
    DrawingPreviews.layer,
    Graph.layer,
    VectorIndex.layer,
    ChatState.layer,
    RunStore.layer,
    // Above the stores: the webhook URL is read from the keychain right before each send.
    ReportDelivery.layer(),
    Kagi.layer(options.kagiBaseUrl === undefined ? {} : { baseUrl: options.kagiBaseUrl }),
    McpServers.layer,
    ExternalAgents.layer,
    Skills.layer({
      ...optionalProperty("home", options.skillsHome),
      ...optionalProperty("builtin", options.skillsBuiltin),
    }),
  );
  const routeCatalog =
    options.routeCatalog ??
    RouteCatalog.layer.pipe(Layer.provide(providerRegistry), Layer.provide(providerToolRegistry));
  const imageRouteFacts = options.imageRouteFacts ?? ImageRouteFacts.authenticatedRoutesLayer;
  const imageRouter =
    options.imageRouter ??
    ImageRouter.consentLayer.pipe(
      Layer.provide(routeCatalog),
      Layer.provide(imageRouteFacts),
      Layer.provide(crossProviderMediaConsent),
    );
  const imageFeature = options.imageFeature ?? ImageFeature.layer.pipe(Layer.provide(foundation));
  const directImageExecutor =
    options.directImageExecutor ?? DirectImageExecutor.openAIEnvironmentLayer;
  const imageMediaWorkflow =
    options.imageMediaWorkflow ??
    ImageMediaWorkflow.layer.pipe(
      Layer.provide(imageFeature),
      Layer.provide(imageRouter),
      Layer.provide(routeCatalog),
      Layer.provide(directImageExecutor),
      Layer.provide(Attachments.layer),
      Layer.provide(crossProviderMediaConsent),
    );
  const providers = Layer.mergeAll(
    compatibleSettings,
    ActiveProvider.layer.pipe(Layer.provideMerge(providerRegistry)),
    routeCatalog,
    imageRouteFacts,
    imageRouter,
    imageFeature,
    directImageExecutor,
    imageMediaWorkflow,
  );
  const retrieval = Layer.mergeAll(
    Indexer.layer,
    MemorySearch.layer,
    PermissionClassifier.layer,
    WorkflowRules.layer,
    QueueDelivery.layer,
    TurnSummaries.layer(options.summarizeAutomatically),
    ReportDiagnoser.layer,
    ProjectImprovement.layer,
  ).pipe(Layer.provideMerge(providers));
  // Kanban boards run their cards as session subagents, so they sit above the tools.
  const kanbanRuntime = KanbanTools.layer.pipe(
    Layer.provideMerge(KanbanBoardActions.layer),
    Layer.provideMerge(KanbanOrchestrator.layer()),
    Layer.provideMerge(GoalMerges.layer),
    Layer.provideMerge(BoardHealth.layer),
    Layer.provideMerge(ProjectScheduler.layer),
    Layer.provideMerge(Layer.mergeAll(cardQueueWorkerLayer, cardAttemptExecutionLayer)),
    Layer.provideMerge(subagentCardAgentsLayer),
    Layer.provideMerge(cardQueueFactoryLayer),
    Layer.provideMerge(
      Layer.mergeAll(
        CardQueueGate.layer,
        CardAttempts.layer,
        CardRuns.layer,
        GoalOrder.layer,
        GoalSchedules.layer,
        ownerWorkflowEngineLayer,
      ),
    ),
  );
  return AgentChat.layer.pipe(
    Layer.provide(Layer.succeed(GoalWorkerConfiguration, options.goalWorker ?? {})),
    // Kept in the agent's services, so a client of the agent can tell which wire it speaks.
    Layer.provideMerge(Layer.succeed(ChatLoop, options.chatLoop ?? ChatLoop.defaultValue())),
    Layer.provideMerge(kanbanRuntime),
    Layer.provideMerge(
      Layer.mergeAll(
        MemoryTools.layer,
        BtwChat.layer,
        FileTools.layer,
        OutsideTools.layer,
        ApprovedTools.layer.pipe(Layer.provide(CodeSkills.layer)),
        KagiTools.layer,
        SkillTools.layer,
        WorkflowTools.layer,
        DelegateTools.layer,
        Subagents.layer,
        PermissionGate.layer,
        Interpreter.layer(options.interpretAutomatically),
        // Above retrieval: migrating a transcript hands its nodes straight to the indexer.
        Importer.layer(options.importsWatching, options.importsHome),
        EmbeddingSetup.layer,
        // Above retrieval too: a swept node's vector and terms are dropped and made again.
        SecretSweep.layer(options.sweepSecrets),
      ),
    ),
    Layer.provideMerge(retrieval),
    Layer.provideMerge(Layer.mergeAll(BackgroundTasks.layer, CodeTools.layer)),
    Layer.provideMerge(memory),
    Layer.provideMerge(stores),
    Layer.provideMerge(foundation),
  );
}
