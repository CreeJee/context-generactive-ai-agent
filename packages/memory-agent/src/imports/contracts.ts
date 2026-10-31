import { Schema } from "effect";
import { LoopHealth } from "../runtime/loop-health.ts";
import { ImportSourceName } from "./items.ts";

/**
 * How migrating other agents' transcripts looks on the settings page. This module imports no server
 * code, so the browser bundle can use it; `importer.ts` builds the overview.
 */

/** Where a pass stands: transcripts looked at of those found, nodes written, transcripts failed. */
export const PassProgress = Schema.Struct({
  checked: Schema.Finite,
  total: Schema.Finite,
  written: Schema.Finite,
  failed: Schema.Finite,
});
export type PassProgress = typeof PassProgress.Type;

/**
 * Why the import worker could not run a pass or a count at all. `start`: the worker could not be
 * started. `count` and `pass`: the worker could not count the transcripts or finish a pass; it
 * stays, and the cause stays in its log. `lost`: the worker or its channel is gone; the next
 * request starts a new one.
 */
export const ImportWorkerFailureReason = Schema.Literals(["start", "count", "pass", "lost"]);

/**
 * A working directory whose transcripts could not be migrated. Folders are registered as projects
 * on their own, so what is left here is what registering could not do: `not_found` (the folder is
 * gone), `not_directory`, `overlaps_storage` (inside this app's own storage).
 */
export const UnplacedFolder = Schema.Struct({
  cwd: Schema.String,
  reason: Schema.String,
  transcripts: Schema.Finite,
});
export type UnplacedFolder = typeof UnplacedFolder.Type;

/** A transcript whose latest pass failed. It is tried again on the next pass. */
export const ImportFailure = Schema.Struct({
  source: ImportSourceName,
  path: Schema.String,
  reason: Schema.String,
});
export type ImportFailure = typeof ImportFailure.Type;

/** The pass running now, or the latest one this server ran. */
const ImportActivity = Schema.TaggedUnion({
  running: { ...PassProgress.fields, startedAt: Schema.String },
  finished: { ...PassProgress.fields, startedAt: Schema.String, finishedAt: Schema.String },
  /** The worker itself failed (not one transcript): nothing after that point was read. */
  crashed: {
    startedAt: Schema.String,
    finishedAt: Schema.String,
    reason: ImportWorkerFailureReason,
  },
});

export const ImportOverview = Schema.Struct({
  enabled: Schema.Boolean,
  interpret: Schema.Boolean,
  sources: Schema.Array(
    Schema.Struct({
      name: ImportSourceName,
      root: Schema.String,
      transcripts: Schema.Finite,
      migrated: Schema.Finite,
      nodes: Schema.Finite,
      /** Transcripts whose latest pass failed. */
      failed: Schema.Finite,
    }),
  ),
  /** Folders whose transcripts could not be placed, with why. */
  unplaced: Schema.Array(UnplacedFolder),
  /** Some of the transcripts that could not be read, with why. */
  failures: Schema.Array(ImportFailure),
  /** Nodes still waiting for the embedding backlog; migrated ones join the queue like any other. */
  unindexed: Schema.Finite,
  /** Null until this server has started a pass. */
  activity: Schema.NullOr(ImportActivity),
  /** How the watcher that runs a pass every few minutes stands; null when this server has none. */
  watch: Schema.NullOr(LoopHealth),
});
export type ImportOverview = typeof ImportOverview.Type;
