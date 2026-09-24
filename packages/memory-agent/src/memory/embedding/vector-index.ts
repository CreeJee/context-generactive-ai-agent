import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { Context, Data, Effect, Layer, Option, Schema } from "effect";
import { StorageRoot } from "../../config/storage-root.ts";
import { Database } from "../../db/database.ts";
import { requireRuntime } from "../../runtime/resources.ts";
import { Embedder } from "./embedder.ts";

export class VectorIndexError extends Data.TaggedError("VectorIndexError")<{
  readonly operation: "open" | "add" | "remove" | "search" | "save";
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

const Count = Schema.Struct({ count: Schema.Finite });
const decodeSeq = Schema.decodeUnknownSync(Schema.Struct({ seq: Schema.Finite }));

/** Writes a new file then swaps it in, so a crash never leaves a half-written index. */
function write(index: { save(path: string): void }, file: string) {
  const temporary = `${file}.tmp`;
  index.save(temporary);
  renameSync(temporary, file);
}

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
        const { CacheLease, VectorIndex } = requireRuntime("turbovec").loadTurbovec();
        const lease = new CacheLease(join(directory, "writer.lock"));
        try {
          const indexed = Schema.decodeUnknownSync(Count)(
            sqlite
              .prepare("SELECT count(*) AS count FROM node_vectors WHERE embedder = ?")
              .get(embedder.identity),
          ).count;
          const saved = existsSync(file) ? VectorIndex.load(file) : null;
          if (saved && saved.dimensions() === embedder.dimensions) {
            // Ahead of the database: vectors whose record never landed (a crash between save and
            // commit) or was dropped on purpose (tool nodes, since only statements are embedded).
            // Dropping those is cheaper than embedding everything again.
            if (saved.size() > indexed) {
              const unrecorded = sqlite
                .prepare(`
                  SELECT n.seq FROM nodes n
                  LEFT JOIN node_vectors v ON v.node_seq = n.seq AND v.embedder = ?
                  WHERE v.node_seq IS NULL`)
                .all(embedder.identity);
              for (const row of unrecorded) saved.remove(String(decodeSeq(row).seq));
              if (saved.size() === indexed) write(saved, file);
            }
            if (saved.size() === indexed) return { index: saved, lease };
          }
          // Missing, behind the database or otherwise out of step with it: rebuild.
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

    /**
     * Drops the vectors of nodes whose text changed, so the indexer embeds the new text. Callers
     * delete the matching `node_vectors` rows in the same step, keeping the count the open check
     * compares.
     */
    remove: (seqs: readonly number[]) =>
      Effect.try({
        try: () => {
          for (const seq of seqs) index.remove(String(seq));
        },
        catch: (cause) => new VectorIndexError({ operation: "remove", cause }),
      }),

    /** Restrict candidates before ranking when callers supply indexed node sequences. */
    search: (query: Float32Array, k: number, allowedSeqs?: readonly number[]) =>
      Effect.try({
        try: (): VectorHit[] => {
          if (index.size() === 0) return [];
          const result = index.search(query, Math.min(k, index.size()), allowedSeqs?.map(String));
          return result.ids.map((id, rank) => ({ seq: Number(id), score: result.scores[rank]! }));
        },
        catch: (cause) => new VectorIndexError({ operation: "search", cause }),
      }),

    save: Effect.try({
      try: () => write(index, file),
      catch: (cause) => new VectorIndexError({ operation: "save", cause }),
    }),
  };
});

/** turbovec index of node embeddings for the active embedder. One writer process at a time. */
export class VectorIndex extends Context.Service<VectorIndex, Effect.Success<typeof make>>()(
  "memory-agent/VectorIndex",
) {
  static readonly layer = Layer.effect(VectorIndex, make);
}
