import { join } from "node:path";
import { Layer } from "effect";
import { AgentChat } from "./agent/chat.ts";
import { CodexAccount } from "./codex/account.ts";
import { CodexAppServer } from "./codex/app-server.ts";
import { CodexChat } from "./codex/chat.ts";
import { CodexModels } from "./codex/models.ts";
import { GlobalConfig } from "./config/global-config.ts";
import { StorageRoot } from "./config/storage-root.ts";
import { Database } from "./db/database.ts";
import { Embedder } from "./memory/embedding/embedder.ts";
import { Indexer } from "./memory/embedding/indexer.ts";
import { VectorIndex } from "./memory/embedding/vector-index.ts";
import { Graph } from "./memory/graph.ts";
import { Nodes } from "./memory/nodes.ts";
import { Recorder } from "./memory/record.ts";
import { MemorySearch } from "./memory/search.ts";
import { PermissionClassifier } from "./permissions/classifier.ts";
import { PermissionGate } from "./permissions/gate.ts";
import { PermissionReviews } from "./permissions/reviews.ts";
import { Projects } from "./projects/projects.ts";
import { Sessions } from "./sessions/sessions.ts";
import { ApprovedTools } from "./tools/approved.ts";
import { FileTools } from "./tools/files.ts";
import { MemoryTools } from "./tools/memory.ts";
import { OutsideTools } from "./tools/outside.ts";

export interface MemoryAgentLayerOptions {
  /** Defaults to the local embedding model; tests pass a deterministic one. */
  readonly embedder?: Layer.Layer<Embedder, never, StorageRoot>;
  /** Defaults to `codex` from PATH; tests pass a fake app server. Starts only when first used. */
  readonly codex?: Layer.Layer<CodexAppServer, never, StorageRoot>;
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
    options.embedder ?? Embedder.local,
    options.codex ?? CodexAppServer.layer,
  );
  const memory = Layer.mergeAll(
    Sessions.layer,
    Recorder.layer,
    Graph.layer,
    VectorIndex.layer,
    CodexAccount.layer,
    CodexModels.layer,
    CodexChat.layer,
  );
  const retrieval = Layer.mergeAll(Indexer.layer, MemorySearch.layer, PermissionClassifier.layer);
  return AgentChat.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        MemoryTools.layer,
        FileTools.layer,
        OutsideTools.layer,
        ApprovedTools.layer,
        PermissionGate.layer,
      ),
    ),
    Layer.provideMerge(retrieval),
    Layer.provideMerge(memory),
    Layer.provideMerge(stores),
    Layer.provideMerge(foundation),
  );
}
