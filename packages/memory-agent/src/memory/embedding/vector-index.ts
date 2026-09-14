import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { Context, Data, Effect, Layer, Option, Schema } from "effect";
import { loadTurbovec } from "turbovec";
import { StorageRoot } from "../../config/storage-root.ts";
import { Database } from "../../db/database.ts";
import { Embedder } from "./embedder.ts";

export class VectorIndexError extends Data.TaggedError("VectorIndexError")<{
  readonly operation: "open" | "add" | "search" | "save";
  readonly cause: unknown;
}> {
  override get message() {
    const cause = Schema.decodeUnknownOption(Schema.Struct({ message: Schema.String }))(this.cause);
    // turbovec's writer lease: only one process may hold an index, so a second app server on the
    // same storage root cannot start.
    if (
      this.operation === "open" &&
      Option.exists(cause, ({ message }) => message.includes("locked"))
    )
      return "The vector index is held by another process using the same storage root (is another app server running?). Stop it, then start this one again.";
    return Option.match(cause, {
      onNone: () => `Vector index ${this.operation} failed.`,
      onSome: ({ message }) => `Vector index ${this.operation} failed: ${message}`,
    });
  }
}

export interface VectorHit {
  /** `nodes.seq` of the matched node. */
  readonly seq: number;
  /** Inner product of normalized vectors, i.e. cosine similarity. */
  readonly score: number;
}

/** 4-bit quantization: turbovec's best recall setting at a quarter of float32 size. */
const quantizationBits = 4;

const Count = Schema.Struct({ count: Schema.Number });

const make = Effect.gen(function* () {
  const storage = yield* StorageRoot;
  const { sqlite } = yield* Database;
  const embedder = yield* Embedder;

  const directory = join(
    storage.path,
    "vectors",
    createHash("sha256").update(embedder.identity).digest("hex").slice(0, 16),
  );
  const file = join(directory, "index.tvim");

  const { index } = yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const { CacheLease, VectorIndex } = loadTurbovec();
        const lease = new CacheLease(join(directory, "writer.lock"));
        try {
          const indexed = Schema.decodeUnknownSync(Count)(
            sqlite
              .prepare("SELECT count(*) AS count FROM node_vectors WHERE embedder = ?")
              .get(embedder.identity),
          ).count;
          const saved = existsSync(file) ? VectorIndex.load(file) : null;
          if (saved && saved.size() === indexed && saved.dimensions() === embedder.dimensions)
            return { index: saved, lease };
          // Missing or out of step with the database (e.g. crash between save and commit): rebuild.
          sqlite.prepare("DELETE FROM node_vectors WHERE embedder = ?").run(embedder.identity);
          return { index: new VectorIndex(embedder.dimensions, quantizationBits), lease };
        } catch (error) {
          lease.close();
          throw error;
        }
      },
      catch: (cause) => new VectorIndexError({ operation: "open", cause }),
    }),
    ({ lease }) => Effect.sync(() => lease.close()),
  );

  return {
    size: () => index.size(),

    add: (seqs: readonly number[], vectors: readonly Float32Array[]) =>
      Effect.try({
        try: () => {
          const batch = new Float32Array(vectors.length * embedder.dimensions);
          vectors.forEach((vector, row) => batch.set(vector, row * embedder.dimensions));
          index.add(batch, seqs.map(String));
        },
        catch: (cause) => new VectorIndexError({ operation: "add", cause }),
      }),

    /** Whole-index search; callers filter by project because node ownership lives in SQLite. */
    search: (query: Float32Array, k: number) =>
      Effect.try({
        try: (): VectorHit[] => {
          if (index.size() === 0) return [];
          const result = index.search(query, Math.min(k, index.size()));
          return result.ids.map((id, rank) => ({ seq: Number(id), score: result.scores[rank]! }));
        },
        catch: (cause) => new VectorIndexError({ operation: "search", cause }),
      }),

    /** Writes a new file then swaps it in, so a crash never leaves a half-written index. */
    save: () =>
      Effect.try({
        try: () => {
          const temporary = `${file}.tmp`;
          index.save(temporary);
          renameSync(temporary, file);
        },
        catch: (cause) => new VectorIndexError({ operation: "save", cause }),
      }),
  };
});

/** turbovec index of node embeddings for the active embedder. One writer process at a time. */
export class VectorIndex extends Context.Tag("memory-agent/VectorIndex")<
  VectorIndex,
  Effect.Effect.Success<typeof make>
>() {
  static readonly layer = Layer.scoped(VectorIndex, make);
}
