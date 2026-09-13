import { join } from "node:path";
import { Layer } from "effect";
import { StorageRoot } from "./config/storage-root.ts";
import { Database } from "./db/database.ts";
import { Embedder } from "./memory/embedding/embedder.ts";
import { Indexer } from "./memory/embedding/indexer.ts";
import { VectorIndex } from "./memory/embedding/vector-index.ts";
import { Graph } from "./memory/graph.ts";
import { Nodes } from "./memory/nodes.ts";
import { Recorder } from "./memory/record.ts";
import { MemorySearch } from "./memory/search.ts";
import { Projects } from "./projects/projects.ts";
import { Sessions } from "./sessions/sessions.ts";
import { MemoryTools } from "./tools/memory.ts";

export interface MemoryAgentLayerOptions {
  /** Defaults to the local embedding model; tests pass a deterministic one. */
  readonly embedder?: Layer.Layer<Embedder, never, StorageRoot>;
}

/** Composition root: every memory-agent service backed by one storage directory. */
export function memoryAgentLayer(storageRoot: string, options: MemoryAgentLayerOptions = {}) {
  // Each tier only depends on the tiers below it.
  const foundation = Layer.merge(
    StorageRoot.layer(storageRoot),
    Database.layer(join(storageRoot, "agent.db")),
  );
  const stores = Layer.mergeAll(Projects.layer, Nodes.layer, options.embedder ?? Embedder.local);
  const memory = Layer.mergeAll(Sessions.layer, Recorder.layer, Graph.layer, VectorIndex.layer);
  const retrieval = Layer.merge(Indexer.layer, MemorySearch.layer);
  return MemoryTools.layer.pipe(
    Layer.provideMerge(retrieval),
    Layer.provideMerge(memory),
    Layer.provideMerge(stores),
    Layer.provideMerge(foundation),
  );
}
