import { NodeCrypto, NodePath } from "@effect/platform-node";
import { Context, Effect, Layer, Schema } from "effect";
import { NativeOwnerFailed } from "../native-search/worker-protocol.ts";
// Composition root: the sole backend acquires resources in this Layer's Scope.
// eslint-disable-next-line anti-slop-effect/no-service-constructor-imports
import { makeNativeVectorIndex } from "./native-vector-index.ts";
import type { NativeReadInput, NativeReadOutput } from "../native-search/read-protocol.ts";

export interface VectorBackend {
  readonly kind: "native";
  readonly read: (input: NativeReadInput) => Effect.Effect<
    {
      readonly publication: { readonly epoch: string; readonly generation: number };
      readonly result: NativeReadOutput;
    },
    VectorIndexError
  >;
}

export interface VectorIndexApi {
  readonly backend: VectorBackend;
  readonly size: () => number;
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

export class VectorIndexError extends Schema.TaggedError<VectorIndexError>()("VectorIndexError", {
  operation: Schema.Literals(["open", "add", "remove", "search", "save"]),
  cause: Schema.Defect(),
}) {
  /**
   * Startup prints this when the index cannot open. It names the operation, and the writer lease
   * held by another process, by tag; the native exception text stays in `cause`.
   */
  override get message() {
    return this.operation === "open" &&
      Schema.is(NativeOwnerFailed)(this.cause) &&
      this.cause.reason === "lease-unavailable"
      ? "The vector index is held by another process using the same storage root (is another app server running?). Stop it, then start this one again."
      : `Vector index ${this.operation} failed.`;
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
 * production backend; `layer` remains the public composition API.
 */
export class VectorIndex extends Context.Service<
  VectorIndex,
  Effect.Success<typeof makeNativeVectorIndex>
>()("memory-agent/memory/embedding/vector-index/VectorIndex") {
  static readonly layer = Layer.effect(
    VectorIndex,
    Effect.suspend(() => makeNativeVectorIndex),
  ).pipe(Layer.provide(Layer.merge(NodeCrypto.layer, NodePath.layer)));
}
