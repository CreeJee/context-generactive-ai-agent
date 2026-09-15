import { join } from "node:path";
import { Layer } from "effect";
import { AgentChat } from "./agent/chat.ts";
import { ChatState } from "./chat-state/chat-state.ts";
import { Attachments } from "./attachments/attachments.ts";
import { CodexAccount } from "./codex/account.ts";
import { CodexAppServer } from "./codex/app-server.ts";
import { CodexChat } from "./codex/chat.ts";
import { CodexModels } from "./codex/models.ts";
import { GlobalConfig } from "./config/global-config.ts";
import { SecretStore } from "./config/secrets.ts";
import { StorageRoot } from "./config/storage-root.ts";
import { Database } from "./db/database.ts";
import { Kagi } from "./kagi/kagi.ts";
import { McpServers } from "./mcp/servers.ts";
import { Skills } from "./skills/skills.ts";
import { Embedder } from "./memory/embedding/embedder.ts";
import { Indexer } from "./memory/embedding/indexer.ts";
import { VectorIndex } from "./memory/embedding/vector-index.ts";
import { Graph } from "./memory/graph.ts";
import { Interpreter } from "./memory/interpret.ts";
import { Interpretations } from "./memory/interpretations.ts";
import { Nodes } from "./memory/nodes.ts";
import { Recorder } from "./memory/record.ts";
import { MemorySearch } from "./memory/search.ts";
import { PermissionClassifier } from "./permissions/classifier.ts";
import { PermissionGate } from "./permissions/gate.ts";
import { PermissionReviews } from "./permissions/reviews.ts";
import { Projects } from "./projects/projects.ts";
import { QueueDelivery } from "./queue/delivery.ts";
import { MessageQueue } from "./queue/queue.ts";
import { SessionLeases } from "./sessions/leases.ts";
import { Sessions } from "./sessions/sessions.ts";
import { ApprovedTools } from "./tools/approved.ts";
import { FileTools } from "./tools/files.ts";
import { KagiTools } from "./tools/kagi.ts";
import { SkillTools } from "./tools/skills.ts";
import { MemoryTools } from "./tools/memory.ts";
import { OutsideTools } from "./tools/outside.ts";

export interface MemoryAgentLayerOptions {
  /** Defaults to the local embedding model; tests pass a deterministic one. */
  readonly embedder?: Layer.Layer<Embedder, never, StorageRoot>;
  /** Defaults to `codex` from PATH; tests pass a fake app server. Starts only when first used. */
  readonly codex?: Layer.Layer<CodexAppServer, never, StorageRoot>;
  /** How long a page keeps a session without renewing; tests shorten it. */
  readonly leaseTtlMs?: number;
  /** Interpret statements in the background after each run. Default true; tests turn it off. */
  readonly interpretAutomatically?: boolean;
  /** Defaults to the OS keychain; tests keep secrets in memory. */
  readonly secrets?: Layer.Layer<SecretStore>;
  /** Defaults to Kagi's API server; tests point it at a local one. */
  readonly kagiBaseUrl?: string;
  /** Home directory whose `.agents/skills` holds global skills; tests use a temporary one. */
  readonly skillsHome?: string;
}

/** Composition root: every memory-agent service backed by one storage directory. */
export function memoryAgentLayer(storageRoot: string, options: MemoryAgentLayerOptions = {}) {
  // Each tier only depends on the tiers below it.
  const foundation = Layer.merge(
    StorageRoot.layer(storageRoot),
    Database.layer(join(storageRoot, "agent.db")),
  );
  const stores = Layer.mergeAll(
    Projects.layer,
    Nodes.layer,
    GlobalConfig.layer,
    PermissionReviews.layer,
    Attachments.layer,
    SessionLeases.layer(options.leaseTtlMs),
    MessageQueue.layer,
    Interpretations.layer,
    options.embedder ?? Embedder.local,
    options.codex ?? CodexAppServer.layer,
    options.secrets ?? SecretStore.keychain,
  );
  const memory = Layer.mergeAll(
    Sessions.layer,
    Recorder.layer,
    Graph.layer,
    VectorIndex.layer,
    CodexAccount.layer,
    CodexModels.layer,
    CodexChat.layer,
    ChatState.layer,
    Kagi.layer({ baseUrl: options.kagiBaseUrl }),
    McpServers.layer,
    Skills.layer({ home: options.skillsHome }),
  );
  const retrieval = Layer.mergeAll(
    Indexer.layer,
    MemorySearch.layer,
    PermissionClassifier.layer,
    QueueDelivery.layer,
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
        PermissionGate.layer,
        Interpreter.layer(options.interpretAutomatically),
      ),
    ),
    Layer.provideMerge(retrieval),
    Layer.provideMerge(memory),
    Layer.provideMerge(stores),
    Layer.provideMerge(foundation),
  );
}
