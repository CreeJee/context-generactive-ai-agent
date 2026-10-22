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
  morphTerms: readonly string[];
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
  textIds: string[];
  morphIds: string[];
  unindexed: number;
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
  inputLogicalBytes: number;
  outputLogicalBytes: number;
}
/** Read-only SQLite session. Must be owned by the same worker as the borrowed index. */
export declare class MemoryReadSession {
  constructor(databasePath: string);
  close(): void;
  search(
    index: VectorIndex,
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
}

export declare const addonPath: string;
export declare function loadTurbovec(): TurbovecAddon;
