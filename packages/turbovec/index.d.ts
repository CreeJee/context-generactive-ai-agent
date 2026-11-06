/** Rust-owned one-shot request control. Close on every exit; cancellation survives worker claims. */
export declare class SearchControl {
  constructor(
    token: string,
    ownerKey: string,
    epoch: string,
    requestId: string,
    remainingMs: number,
  );
  /** Fresh issued capability, not the constructor's entropy seed; never reused. */
  token(): string;
  /** Monotonic actual SQLite pin event, NOT an ongoing lease; track completion separately. */
  snapshotWasPinned(): boolean;
  cancel(): void;
  close(): void;
  static count(): number;
}

export interface SearchResult {
  ids: string[];
  scores: number[];
}

export interface ControlledSearchResult {
  kind: "success" | "cancelled" | "budget-exceeded" | "invalid-input" | "index-failed";
  ids: string[];
  scores: number[];
  nativeWindow: "whole-call";
  nativeMs: number;
}

/** Holds an OS file lock so only one process writes a vector cache directory. */
export declare class CacheLease {
  constructor(path: string);
  close(): void;
}

/**
 * Quantized inner-product index keyed by canonical u64 decimal strings.
 * Vectors must be L2-normalized by the caller.
 */
export declare class VectorIndex {
  constructor(dimensions: number, bits: number);
  static load(path: string): VectorIndex;
  add(vectors: Float32Array, ids: string[]): void;
  /** Omit `allowedIds` to search the whole index; an empty allowlist returns no results. */
  search(query: Float32Array, k: number, allowedIds?: string[]): SearchResult;
  /** Measured-envelope admission and cooperative pre/post checks; not mid-scan preemption.
   * Control must be registered before input validation/copy/queueing.
   */
  searchControlled(
    query: Float32Array,
    k: number,
    token: string,
    ownerKey: string,
    epoch: string,
    requestId: string,
    allowedIds?: string[],
  ): ControlledSearchResult;
  remove(id: string): boolean;
  save(path: string): void;
  dimensions(): number;
  bits(): number;
  size(): number;
  validateIds(ids: string[]): void;
  /** Releases the index now rather than at GC; later calls throw. Idempotent. */
  close(): void;
}

export interface NativeReadInput {
  allowedProjects: readonly string[];
  embedder: string;
  query?: Float32Array | null | undefined;
  trigramTerms: readonly string[];
  shortTerms: readonly string[];
  /** The question; the lexical index splits it into morph terms itself. */
  morphQuery: string;
  vectorK: number;
  textK: number;
  morphK: number;
  textEnabled: boolean;
  morphEnabled: boolean;
  /** Compatibility DTO only; registered SearchControl deadline is authoritative. */
  remainingMs: number;
  inputBudgetBytes: number;
  outputBudgetBytes: number;
}
export interface NativeReadOutput {
  kind:
    | "success"
    | "cancelled"
    | "budget-exceeded"
    | "invalid-input"
    | "read-failed"
    | "index-failed";
  vectorIds: string[];
  vectorSeqs: string[];
  vectorScores: number[];
  /** Vector engine alone failed; text/morph/coverage remain from the same clean snapshot. */
  vectorUnavailable: boolean;
  /** Text stage results were dropped mid-read to keep the read alive; vector/morph/coverage remain. */
  textUnavailable: boolean;
  textIds: string[];
  morphIds: string[];
  unindexed: number;
  /** Journaled node changes the lexical index has not applied yet, over every project. */
  lexicalPending: number;
  uninterpreted: number;
  candidateCount: number;
  sqliteExecutions: number;
  candidateMs: number;
  vectorMs: number;
  textMs: number;
  morphMs: number;
  mappingMs: number;
  /** The unindexed and uninterpreted counts. */
  coverageMs: number;
  /** From the host registering the request (which starts its deadline) to the worker claiming it. */
  queueMs: number;
  /** The trigram query inside the text stage; none when it did not run or did not finish. */
  trigramMs?: number | null;
  /** The finished short-term queries inside the text stage: total, slowest and count. */
  shortTermMs: number;
  shortTermMaxMs: number;
  shortTermsDone: number;
  /** The stage a failed read stopped in; none when it succeeded or failed before reading. */
  failedStage?: "candidate" | "vector" | "mapping" | "text" | "morph" | "coverage" | null;
  inputLogicalBytes: number;
  outputLogicalBytes: number;
}
/** A node as the lexical index holds it. */
export interface LexicalDocument {
  seq: number;
  project: string;
  text: string;
}
/**
 * Tantivy index of node text (trigram phrases and Lindera morph terms), derived from SQLite.
 * Holds the folder's writer lock while open. Synchronous: call it only inside its owning worker.
 */
export declare class LexicalIndex {
  /** Opens or creates the index; `recover` replaces one that cannot be opened with an empty one. */
  static open(dir: string, recover: boolean): LexicalIndex;
  /** The build its last reset named; null for a new or replaced index. */
  instance(): string | null;
  /** Empties the index and names the new build. */
  reset(instance: string): void;
  /** Replaces the documents of `removed` and of each document's seq, in one commit; returns the size. */
  apply(documents: LexicalDocument[], removed: number[]): number;
  size(): number;
  /** The morph terms of a text, for tests and evaluations. */
  morphTerms(text: string): string[];
  /** Releases the index and its writer lock now, after any running merge; later calls throw. Idempotent. */
  close(): void;
}

/** Read-only SQLite session. Must be owned by the same worker as the borrowed index. */
export declare class MemoryReadSession {
  constructor(databasePath: string);
  close(): void;
  /** `lexical` is required while the text or morph channel is on. */
  search(
    index: VectorIndex,
    lexical: LexicalIndex | null,
    input: NativeReadInput,
    token: string,
    ownerKey: string,
    epoch: string,
    requestId: string,
  ): NativeReadOutput;
}

export interface TurbovecAddon {
  VectorIndex: typeof VectorIndex;
  CacheLease: typeof CacheLease;
  MemoryReadSession: typeof MemoryReadSession;
  SearchControl: typeof SearchControl;
  LexicalIndex: typeof LexicalIndex;
}

export declare const addonPath: string;
export declare function loadTurbovec(): TurbovecAddon;
