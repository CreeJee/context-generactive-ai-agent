export { memoryAgentLayer, type MemoryAgentLayerOptions } from "./layers.ts";

export { StorageRoot, defaultStorageRoot } from "./config/storage-root.ts";
export { Database, DatabaseOpenError } from "./db/database.ts";
export {
  Project,
  ProjectNotFound,
  ProjectRootRejected,
  Projects,
  pathsOverlap,
} from "./projects/projects.ts";
export { Session, Sessions } from "./sessions/sessions.ts";

export { Edge, EdgeKind, edgeWeights, type NodeLink } from "./memory/edges.ts";
export {
  Node,
  NodeDetail,
  NodeKind,
  Nodes,
  evidencePageLength,
  type EvidencePage,
  type NewNode,
} from "./memory/nodes.ts";
export { Recorder, type RunBinding } from "./memory/record.ts";
export {
  Graph,
  type Hop,
  type Provenance,
  type TraverseOptions,
  type TraverseResult,
  type Visit,
} from "./memory/graph.ts";
export { MemorySearch, type FindInput, type FindResult, type Match } from "./memory/search.ts";
export {
  Embedder,
  EmbeddingError,
  localModel,
  type EmbedderApi,
} from "./memory/embedding/embedder.ts";
export { Indexer } from "./memory/embedding/indexer.ts";
export { VectorIndex, VectorIndexError, type VectorHit } from "./memory/embedding/vector-index.ts";

export { MemoryTools, memoryToolNames } from "./tools/memory.ts";
export { toToolSchema, type ToolSchema } from "./tools/schema.ts";
