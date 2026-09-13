export interface SearchResult {
  ids: string[];
  scores: number[];
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
  remove(id: string): boolean;
  save(path: string): void;
  dimensions(): number;
  bits(): number;
  size(): number;
  validateIds(ids: string[]): void;
}

export interface TurbovecAddon {
  VectorIndex: typeof VectorIndex;
  CacheLease: typeof CacheLease;
}

export declare const addonPath: string;
export declare function loadTurbovec(): TurbovecAddon;
