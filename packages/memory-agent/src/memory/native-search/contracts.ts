import { Data } from "effect";

/** Internal transport contracts, not the public MemorySearch result or authorization API.
 * The host validates/copies inputs at the worker boundary. Native code never owns policy.
 */
export interface PublishedGeneration {
  readonly epoch: string;
  /** Canonical nonnegative decimal; avoids cross-runtime integer precision loss. */
  readonly generation: string;
}

export type QueryVectorChannel = Data.TaggedEnum<{
  ready: { readonly vector: Float32Array };
  empty: {};
  unavailable: {};
}>;
export const QueryVectorChannel = Data.taggedEnum<QueryVectorChannel>();

export type MorphTermsChannel = Data.TaggedEnum<{
  ready: { readonly terms: readonly string[] };
  disabled: {};
  unavailable: {};
}>;
export const MorphTermsChannel = Data.taggedEnum<MorphTermsChannel>();

export type TextTermsChannel = Data.TaggedEnum<{
  enabled: {
    readonly trigram: readonly string[];
    readonly short: readonly string[];
  };
  disabled: {};
}>;
export const TextTermsChannel = Data.taggedEnum<TextTermsChannel>();

export interface ChannelBudgets {
  readonly vectorK: number;
  readonly morphK: number;
  /** Applied to trigram AND each short-term query, not a global text-list cap. */
  readonly textK: number;
  readonly outputBytes: number;
}

export interface NativeSearchRequest {
  readonly kind: "search";
  readonly requestId: string;
  readonly expected: PublishedGeneration;
  readonly queryVector: QueryVectorChannel;
  readonly morphology: MorphTermsChannel;
  readonly text: TextTermsChannel;
  readonly allowedProjectIds: readonly string[];
  readonly embedderIdentity: string;
  readonly budgets: ChannelBudgets;
  /** Host registers a Rust Instant deadline before input copying/queueing. */
  readonly budgetMs: number;
  // Cancellation is the caller's Fiber/AbortSignal, not publicly mutable control memory.
  // Host transport creates a one-shot private owner/epoch/request-bound native capability.
}

export interface RankedVectorHit {
  readonly id: string;
  readonly seq: string;
  readonly score: number;
}

export interface RankedChannels {
  readonly vector: readonly RankedVectorHit[];
  /** Existing trigram + short-term append/dedupe order, including results beyond textK. */
  readonly text: readonly string[];
  readonly morph: readonly string[];
}

export interface SearchCoverage {
  /** Existing global meaningful embeddedKinds count, not project-scoped. */
  readonly unindexed: number;
  /** Existing allowed-project-scoped count. */
  readonly uninterpreted: number;
}

export interface NativeStageMetrics {
  readonly candidateCount: number;
  readonly candidateMs: number;
  readonly vectorMs: number;
  readonly textMs: number;
  readonly morphMs: number;
  readonly mappingMs: number;
  readonly sqliteExecutions: number;
  readonly inputLogicalBytes: number;
  readonly outputLogicalBytes: number;
}

interface Completion {
  readonly requestId: string;
  readonly observed: PublishedGeneration;
}

interface SearchData extends Completion {
  readonly channels: RankedChannels;
  readonly coverage: SearchCoverage;
  readonly metrics: NativeStageMetrics;
}

export type NativeSearchFailureCode =
  | "invalid-input"
  | "queue-full"
  | "worker-unavailable"
  | "native-incompatible"
  | "read-failed"
  | "index-failed";

export type NativeSearchOutcome = Data.TaggedEnum<{
  success: SearchData;
  degraded: SearchData & { readonly unavailable: readonly ("vector" | "morph")[] };
  cancelled: Completion & { readonly phase: "terminated" };
  "budget-exceeded": Completion & {
    readonly category: "queue" | "execution" | "input" | "output";
  };
  "stale-generation": Completion & {
    readonly reason: "epoch" | "generation" | "unpublished" | "poisoned";
  };
  error: Completion & { readonly code: NativeSearchFailureCode };
}>;
export const NativeSearchOutcome = Data.taggedEnum<NativeSearchOutcome>();

/** Framework-neutral async transport boundary; the Effect adapter submits lazily in its Scope.
 * No implementation may invoke heavy synchronous native search on the caller thread.
 */
export interface NativeSearchClient {
  readonly search: (
    request: NativeSearchRequest,
    signal: AbortSignal,
  ) => Promise<NativeSearchOutcome>;
  readonly close: () => Promise<void>;
}

export const nativeSearchBounds = {
  admittedSearches: 32,
  activeSearches: 1,
  workBudgetMs: 2_000,
  queuedAbortMs: 50,
  activeAbortAcknowledgeMs: 100,
  inputLogicalBytes: 1_048_576,
  outputLogicalBytes: 1_048_576,
} as const;
