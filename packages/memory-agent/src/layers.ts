import { join } from "node:path";
import { Layer } from "effect";
import { AgentChat } from "./agent/chat.ts";
import { TurnSummaries } from "./agent/turn-summaries.ts";
import { ChatState } from "./chat-state/chat-state.ts";
import { RelayedApprovals } from "./approvals/relayed.ts";
import { Attachments } from "./attachments/attachments.ts";
import { DrawingPreviews } from "./attachments/previews.ts";
import { CodexAccount } from "./codex/account.ts";
import { CodexAppServer } from "./codex/app-server.ts";
import { CodexChat } from "./codex/chat.ts";
import { CodexModels } from "./codex/models.ts";
import { CodexSkills } from "./codex/skills.ts";
import { GlobalConfig } from "./config/global-config.ts";
import { SecretStore } from "./config/secrets.ts";
import { StorageRoot } from "./config/storage-root.ts";
import { Database } from "./db/database.ts";
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
import { Nodes } from "./memory/nodes.ts";
import { Recorder } from "./memory/record.ts";
import { MemorySearch } from "./memory/search.ts";
import { PermissionClassifier } from "./permissions/classifier.ts";
import { SecretRedactor } from "./secrets/redactor.ts";
import { SecretSweep } from "./secrets/sweep.ts";
import { PermissionGate } from "./permissions/gate.ts";
import { PermissionReviews } from "./permissions/reviews.ts";
import { Projects } from "./projects/projects.ts";
import { QueueDelivery } from "./queue/delivery.ts";
import { MessageQueue } from "./queue/queue.ts";
import { SessionLeases } from "./sessions/leases.ts";
import { Sessions } from "./sessions/sessions.ts";
import { ApprovedTools } from "./tools/approved.ts";
import { FileTools } from "./tools/files.ts";
import { DelegateTools } from "./tools/delegate.ts";
import { KagiTools } from "./tools/kagi.ts";
import { SkillTools } from "./tools/skills.ts";
import { MemoryTools } from "./tools/memory.ts";
import { OutsideTools } from "./tools/outside.ts";
import { Workflows } from "./workflow/workflow.ts";
import { WorkflowTools } from "./workflow/tools.ts";
import { WorkflowRules } from "./workflow/rules.ts";

export interface MemoryAgentLayerOptions {
  /** Defaults to the local embedding model; tests pass a deterministic one. */
  readonly embedder?: Layer.Layer<Embedder, never, StorageRoot | GlobalConfig>;
  /** Defaults to Kiwi (model downloaded on first use); tests pass a deterministic one. */
  readonly morphAnalyzer?: Layer.Layer<MorphAnalyzer, never, StorageRoot>;
  /** Defaults to `codex` from PATH; tests pass a fake app server. Starts only when first used. */
  readonly codex?: Layer.Layer<CodexAppServer, never, StorageRoot>;
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
}

/** Composition root: every memory-agent service backed by one storage directory. */
export function memoryAgentLayer(storageRoot: string, options: MemoryAgentLayerOptions = {}) {
  // Each tier only depends on the tiers below it.
  // The settings are read by services in every tier above, the embedder among them.
  const foundation = GlobalConfig.layer.pipe(
    Layer.provideMerge(
      Layer.merge(StorageRoot.layer(storageRoot), Database.layer(join(storageRoot, "agent.db"))),
    ),
  );
  const stores = Layer.mergeAll(
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
    options.embedder ?? Embedder.local,
    options.morphAnalyzer ?? MorphAnalyzer.kiwi,
    options.codex ?? CodexAppServer.layer,
    options.secrets ?? SecretStore.keychain,
  );
  const memory = Layer.mergeAll(
    Sessions.layer,
    Recorder.layer,
    DrawingPreviews.layer,
    Graph.layer,
    VectorIndex.layer,
    CodexAccount.layer,
    CodexModels.layer,
    CodexChat.layer,
    CodexSkills.layer,
    ChatState.layer,
    Kagi.layer({ baseUrl: options.kagiBaseUrl }),
    McpServers.layer,
    ExternalAgents.layer,
    Skills.layer({ home: options.skillsHome, builtin: options.skillsBuiltin }),
  );
  const retrieval = Layer.mergeAll(
    Indexer.layer,
    MemorySearch.layer,
    PermissionClassifier.layer,
    WorkflowRules.layer,
    QueueDelivery.layer,
    TurnSummaries.layer(options.summarizeAutomatically),
  );
  return AgentChat.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        MemoryTools.layer,
        FileTools.layer,
        OutsideTools.layer,
        ApprovedTools.layer,
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
    Layer.provideMerge(memory),
    Layer.provideMerge(stores),
    Layer.provideMerge(foundation),
  );
}
