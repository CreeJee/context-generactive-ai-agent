import { Context, Effect, Match, Option, Schema } from "effect";
import { NativeOwnerFailed } from "../native-search/worker-protocol.ts";
import type {
  NativeCoverage,
  NativeCoverageInput,
  NativeReadInput,
  NativeReadOutput,
} from "../native-search/read-protocol.ts";
import type { LexicalDocument } from "../native-search/worker-protocol.ts";

export interface VectorBackend {
  readonly kind: "native";
  readonly read: (input: NativeReadInput) => Effect.Effect<
    {
      readonly publication: { readonly epoch: string; readonly generation: number };
      readonly result: NativeReadOutput;
    },
    VectorIndexError
  >;
  /** What a search has not covered yet, counted apart from its reads. */
  readonly coverage: (
    input: NativeCoverageInput,
  ) => Effect.Effect<NativeCoverage, VectorIndexError>;
}

export interface VectorIndexApi {
  readonly backend: VectorBackend;
  readonly size: () => number;
  /**
   * Replaces the lexical documents of `removed` and of every document's seq, in one commit the
   * next read sees.
   */
  readonly applyLexical: (
    documents: readonly LexicalDocument[],
    removed: readonly number[],
  ) => Effect.Effect<void, VectorIndexError>;
  readonly flushRemovals: Effect.Effect<void, VectorIndexError>;
  readonly add: (
    seqs: readonly number[],
    vectors: readonly Float32Array[],
  ) => Effect.Effect<void, VectorIndexError>;
  readonly remove: (seqs: readonly number[]) => Effect.Effect<void, VectorIndexError>;
  readonly search: (
    query: Float32Array,
    k: number,
    allowedSeqs?: readonly number[],
  ) => Effect.Effect<VectorHit[], VectorIndexError>;
  readonly save: Effect.Effect<void, VectorIndexError>;
  /** Prepare/revalidate and publish one short mutation; embedding/network work stays outside. */
  readonly publish: <A, E, R, E2, R2>(
    prepare: Effect.Effect<
      {
        readonly seqs: readonly number[];
        readonly vectors: readonly Float32Array[];
        readonly commit: Effect.Effect<A, E, R>;
      },
      E2,
      R2
    >,
  ) => Effect.Effect<A, E | E2 | VectorIndexError, R | R2>;
}

/**
 * Reasons that leave the index as it was: the worker was only busy. Without this the model read
 * "Vector index search failed." as a broken index and searched in circles (2026-11-23).
 */
const retryHint = (reason: NativeOwnerFailed["reason"]) =>
  Match.value(reason).pipe(
    Match.when(
      "request-timeout",
      () =>
        " The search worker did not answer in time, usually because the machine was busy; the same call can run again.",
    ),
    Match.when(
      "queue-full",
      () => " Too many index requests were waiting; the same call can run again.",
    ),
    Match.orElse(() => ""),
  );

export class VectorIndexError extends Schema.TaggedError<
  VectorIndexError,
  { readonly brand: unique symbol }
>()("VectorIndexError", {
  operation: Schema.Literals(["open", "add", "remove", "search", "save", "lexical"]),
  cause: Schema.Defect(),
}) {
  /**
   * Startup prints this when the index cannot open, and a tool the model called reads it as its
   * failure. It names the operation and the native owner's reason, and says when the same call can
   * simply run again; the native exception text stays in `cause`.
   */
  override get message() {
    const reason = Option.map(
      Option.liftPredicate(this.cause, Schema.is(NativeOwnerFailed)),
      (owner) => owner.reason,
    );
    return this.operation === "open" && Option.contains(reason, "lease-unavailable")
      ? "The vector index is held by another process using the same storage root (is another app server running?). Stop it, then start this one again."
      : Option.match(reason, {
          onNone: () => `Vector index ${this.operation} failed.`,
          onSome: (reason) =>
            `Vector index ${this.operation} failed (${reason}).${retryHint(reason)}`,
        });
  }
}

export interface VectorHit {
  /** `nodes.seq` of the matched node. */
  readonly seq: number;
  /** Inner product of normalized vectors, i.e. cosine similarity. */
  readonly score: number;
}

/**
 * turbovec index and read worker for the active embedder. The native owner is the only
 * production backend; `nativeVectorIndexLayer` in `native-vector-index.ts` provides it.
 */
export class VectorIndex extends Context.Service<VectorIndex, VectorIndexApi>()(
  "memory-agent/memory/embedding/vector-index/VectorIndex",
) {}
