/**
 * What the import has done so far, read without writing anything.
 *
 * `memory import` needs the storage lock; this does not, so it answers while the app is running.
 * The counts come from the import cursors the pass keeps, the transcripts are counted by walking
 * the other agents' folders, and the backlog is the same pending-node query the indexer runs.
 */
import { Effect, FileSystem, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { embedderIdentity } from "../memory/embedding/embedder.ts";
import { storageEmbeddingMode } from "./read-only-storage.ts";
import { embeddedKindFilter, meaningfulNodeFilter } from "../memory/quality.ts";
import { importSources } from "../imports/sources.ts";
import { ImportSourceName } from "../imports/items.ts";
import { homeDirectory } from "../runtime/host-system.ts";

/** Failures are listed, not counted only, so the caller can see which transcripts did not land. */
const listedFailures = 20;

export const importStatus = Effect.fnUntraced(function* (options: {
  readonly storage: string;
  readonly importsHome?: string | undefined;
}) {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const home = options.importsHome ?? (yield* homeDirectory);
  const totals = SqlSchema.findOne({
    Request: Schema.String,
    Result: Schema.Struct({
      migrated: Schema.Finite,
      nodes: Schema.Finite,
      failed: Schema.Finite,
    }),
    execute: (source) => sql`
      SELECT
        coalesce(sum(skipped IS NULL AND failure IS NULL), 0) AS migrated,
        coalesce(sum(CASE WHEN skipped IS NULL AND failure IS NULL THEN imported END), 0) AS nodes,
        coalesce(sum(failure IS NOT NULL), 0) AS failed
      FROM import_cursors WHERE source = ${source}`,
  });
  const skippedFolders = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({
      cwd: Schema.String,
      reason: Schema.String,
      transcripts: Schema.Finite,
    }),
    execute: () => sql`
      SELECT cwd, skipped AS reason, count(*) AS transcripts FROM import_cursors
      WHERE skipped IS NOT NULL AND cwd IS NOT NULL
      GROUP BY cwd, skipped ORDER BY transcripts DESC, cwd`,
  });
  const failedTranscripts = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({ source: ImportSourceName, path: Schema.String, reason: Schema.String }),
    execute: () => sql`
      SELECT source, path, failure AS reason FROM import_cursors
      WHERE failure IS NOT NULL ORDER BY source, path LIMIT ${listedFailures}`,
  });
  // The same backlog the indexer reports, for the identity the app and `memory import` embed with.
  const pending = SqlSchema.findOne({
    Request: Schema.String,
    Result: Schema.Struct({ count: Schema.Finite }),
    execute: (identity) => sql`
      SELECT count(*) AS count FROM nodes n
      LEFT JOIN node_vectors v ON v.node_seq = n.seq AND v.embedder = ${identity}
      WHERE v.node_seq IS NULL AND ${sql.literal(meaningfulNodeFilter)}
        AND ${sql.literal(embeddedKindFilter)}`,
  });
  const sources = yield* Effect.forEach(importSources, (source) =>
    Effect.gen(function* () {
      const root = source.root(home);
      const found = yield* source.transcripts(root);
      const counted = yield* totals(source.name);
      return {
        name: source.name,
        root,
        transcripts: found.length,
        migrated: counted?.migrated ?? 0,
        nodes: counted?.nodes ?? 0,
        failed: counted?.failed ?? 0,
      };
    }),
  ).pipe(Effect.provideService(FileSystem.FileSystem, fs));
  const mode = yield* storageEmbeddingMode(options.storage);
  const backlog = yield* pending(embedderIdentity(mode));
  return {
    storage: options.storage,
    home,
    sources,
    unplaced: yield* skippedFolders(),
    failures: yield* failedTranscripts(),
    unindexed: backlog?.count ?? 0,
  };
});
