import { homedir } from "node:os";
import { Worker } from "node:worker_threads";
import { Context, Data, Deferred, Effect, Layer, Schedule, Schema } from "effect";
import { GlobalConfig } from "../config/global-config.ts";
import { StorageRoot } from "../config/storage-root.ts";
import { Database } from "../db/database.ts";
import { Indexer } from "../memory/embedding/indexer.ts";
import { runtimeWorker } from "../runtime/resources.ts";
import { ImportSourceName } from "./items.ts";
import type { PassProgress, TranscriptCounts } from "./pass.ts";
import { importSources } from "./sources.ts";
import {
  ImportWorkerReply,
  type ImportWorkerRequest,
  type ImportWorkerSetup,
} from "./worker-protocol.ts";

/** Transcripts only grow, and a stat of every file is cheap, so looking often costs nothing. */
const pollEvery = "5 minutes";
/** How many unreadable transcripts settings lists by name. */
const listedFailures = 20;

/**
 * A working directory whose transcripts could not be migrated. Folders are registered as projects
 * on their own, so what is left here is what registering could not do: `not_found` (the folder is
 * gone), `not_directory`, `overlaps_storage` (inside this app's own storage).
 */
export interface UnplacedFolder {
  readonly cwd: string;
  readonly reason: string;
  readonly transcripts: number;
}

/** A transcript whose latest pass failed. It is tried again on the next pass. */
export interface ImportFailure {
  readonly source: ImportSourceName;
  readonly path: string;
  readonly reason: string;
}

/** The pass running now, or the latest one this server ran. */
export type ImportActivity =
  | (PassProgress & { readonly status: "running"; readonly startedAt: string })
  | (PassProgress & {
      readonly status: "finished";
      readonly startedAt: string;
      readonly finishedAt: string;
    })
  | {
      /** The worker itself failed (not one transcript): nothing after that point was read. */
      readonly status: "crashed";
      readonly startedAt: string;
      readonly finishedAt: string;
      readonly reason: string;
    };

export interface ImportOverview {
  readonly enabled: boolean;
  readonly interpret: boolean;
  readonly sources: readonly {
    readonly name: ImportSourceName;
    readonly root: string;
    readonly transcripts: number;
    readonly migrated: number;
    readonly nodes: number;
    /** Transcripts whose latest pass failed. */
    readonly failed: number;
  }[];
  /** Folders whose transcripts could not be placed, with why. */
  readonly unplaced: readonly UnplacedFolder[];
  /** Some of the transcripts that could not be read, with why. */
  readonly failures: readonly ImportFailure[];
  /** Nodes still waiting for the embedding backlog; migrated ones join the queue like any other. */
  readonly unindexed: number;
  /** Null until this server has started a pass. */
  readonly activity: ImportActivity | null;
}

/** The import worker could not run a pass or a count at all. */
export class ImportWorkerFailed extends Data.TaggedError("ImportWorkerFailed")<{
  readonly reason: string;
}> {}

const decodeReply = Schema.decodeUnknownSync(ImportWorkerReply);
const decodeSourceTotals = Schema.decodeUnknownSync(
  Schema.Struct({ migrated: Schema.Number, nodes: Schema.Number, failed: Schema.Number }),
);
const decodeFailure = Schema.decodeUnknownSync(
  Schema.Struct({ source: ImportSourceName, path: Schema.String, reason: Schema.String }),
);
const decodeSkipped = Schema.decodeUnknownSync(
  Schema.Struct({ cwd: Schema.String, reason: Schema.String, transcripts: Schema.Number }),
);

const progressOf = (reply: PassProgress): PassProgress => ({
  checked: reply.checked,
  total: reply.total,
  written: reply.written,
  failed: reply.failed,
});

const make = (watching: boolean, home: string) =>
  Effect.gen(function* () {
    const { sqlite } = yield* Database;
    const storage = yield* StorageRoot;
    const config = yield* GlobalConfig;
    const indexer = yield* Indexer;
    const oneDrainAtATime = yield* Effect.makeSemaphore(1);

    const sourceTotals = sqlite.prepare(`
      SELECT
        coalesce(sum(skipped IS NULL AND failure IS NULL), 0) AS migrated,
        coalesce(sum(CASE WHEN skipped IS NULL AND failure IS NULL THEN imported END), 0) AS nodes,
        coalesce(sum(failure IS NOT NULL), 0) AS failed
      FROM import_cursors WHERE source = ?`);
    const skippedFolders = sqlite.prepare(`
      SELECT cwd, skipped AS reason, count(*) AS transcripts FROM import_cursors
      WHERE skipped IS NOT NULL AND cwd IS NOT NULL
      GROUP BY cwd, skipped ORDER BY transcripts DESC, cwd`);
    const failedTranscripts = sqlite.prepare(`
      SELECT source, path, failure AS reason FROM import_cursors
      WHERE failure IS NOT NULL ORDER BY source, path LIMIT ?`);

    // The worker: started on first use and kept. It answers each request with any number of
    // `progress` replies and then one final reply.
    const setup: ImportWorkerSetup = { storageRoot: storage.path, home };
    let worker: Worker | null = null;
    let nextId = 1;
    const listeners = new Map<number, (reply: ImportWorkerReply) => void>();

    const stop = (reason: string) => {
      const current = worker;
      worker = null;
      for (const [id, listen] of listeners) listen({ id, kind: "failed", reason });
      listeners.clear();
      return current?.terminate();
    };

    const start = () => {
      const created = new Worker(runtimeWorker("import-worker"), { workerData: setup });
      const lost = () => {
        if (worker === created) void stop("the import worker stopped");
      };
      created.on("message", (message) => {
        const reply = decodeReply(message);
        const listen = listeners.get(reply.id);
        switch (reply.kind) {
          case "progress":
            listen?.(reply);
            return;
          case "counts":
          case "finished":
          case "failed":
            listeners.delete(reply.id);
            listen?.(reply);
            // An idle worker must not keep the process alive; one with requests in flight must.
            if (listeners.size === 0) created.unref();
        }
      });
      created.on("error", lost);
      created.on("exit", lost);
      created.unref();
      return created;
    };

    const ask = (kind: ImportWorkerRequest["kind"], listen: (reply: ImportWorkerReply) => void) => {
      const current = (worker ??= start());
      const id = nextId++;
      listeners.set(id, listen);
      current.ref();
      current.postMessage({ id, kind } satisfies ImportWorkerRequest);
    };

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => void (await stop("the importer stopped"))),
    );

    /** Transcripts on disk per source, counted by the worker so the folders are walked there. */
    let latestCounts: TranscriptCounts | null = null;
    const countTranscripts = Effect.async<TranscriptCounts, ImportWorkerFailed>((resume) =>
      ask("count", (reply) => {
        switch (reply.kind) {
          case "counts":
            latestCounts = reply.counts;
            return resume(Effect.succeed(reply.counts));
          case "failed":
            return resume(Effect.fail(new ImportWorkerFailed({ reason: reply.reason })));
          case "progress":
          case "finished":
            return;
        }
      }),
    );

    let activity: ImportActivity | null = null;
    let running: Deferred.Deferred<number, ImportWorkerFailed> | null = null;

    const pass = (startedAt: string) =>
      Effect.async<PassProgress, ImportWorkerFailed>((resume) =>
        ask("run", (reply) => {
          switch (reply.kind) {
            case "progress":
              activity = { status: "running", startedAt, ...progressOf(reply) };
              return;
            case "finished":
              latestCounts = reply.counts;
              return resume(Effect.succeed(progressOf(reply)));
            case "failed":
              return resume(Effect.fail(new ImportWorkerFailed({ reason: reply.reason })));
            case "counts":
              return;
          }
        }),
      );

    // Passes and the backlog after them run in this layer's scope, not a request's: a request that
    // starts a pass is answered at once, and the pass outlives it.
    const layerScope = yield* Effect.scope;

    /** The running pass, or a new one. Two passes would import a line twice before either marks it. */
    const begin = Effect.suspend(() => {
      if (running) return Effect.succeed(running);
      return Effect.gen(function* () {
        const done = yield* Deferred.make<number, ImportWorkerFailed>();
        running = done;
        const startedAt = new Date().toISOString();
        activity = { status: "running", startedAt, checked: 0, total: 0, written: 0, failed: 0 };
        yield* pass(startedAt).pipe(
          Effect.tap((progress) =>
            Effect.sync(() => {
              activity = {
                status: "finished",
                startedAt,
                finishedAt: new Date().toISOString(),
                ...progress,
              };
            }),
          ),
          Effect.tapError((failure) =>
            Effect.sync(() => {
              activity = {
                status: "crashed",
                startedAt,
                finishedAt: new Date().toISOString(),
                reason: failure.reason,
              };
            }),
          ),
          Effect.map((progress) => progress.written),
          Effect.onExit((exit) =>
            Effect.zipRight(
              Effect.sync(() => {
                running = null;
              }),
              Deferred.done(done, exit),
            ),
          ),
          Effect.forkIn(layerScope),
        );
        return done;
      });
    });

    /** One pass, waited for. Returns how many nodes it wrote; embedding them is left to the caller. */
    const runOnce = Effect.flatMap(begin, Deferred.await);

    /**
     * Embeds and analyses what a migration added, taking as long as it takes. The indexer gives up
     * its permit between batches, so a conversation held meanwhile is still indexed first: its
     * nodes are the newest by time, and that is the order pending nodes come out in.
     */
    const backfill = Effect.zipRight(indexer.indexAll(), indexer.analyzeAll()).pipe(
      Effect.catchAllCause(() => Effect.void),
      oneDrainAtATime.withPermits(1),
    );

    /** Starts a pass (or joins the running one) and returns at once; its backlog follows it. */
    const startPass = Effect.flatMap(begin, (done) =>
      Effect.forkIn(
        Deferred.await(done).pipe(
          Effect.flatMap((written) => (written > 0 ? backfill : Effect.void)),
          Effect.catchAllCause(() => Effect.void),
        ),
        layerScope,
      ),
    ).pipe(Effect.asVoid);

    if (watching)
      yield* Effect.forkScoped(
        Effect.repeat(
          Effect.gen(function* () {
            const settings = yield* config.read;
            if (settings.importsEnabled !== true) return;
            if ((yield* runOnce) > 0) yield* backfill;
          }).pipe(Effect.catchAllCause(() => Effect.void)),
          Schedule.spaced(pollEvery),
        ),
      );

    const overview = Effect.gen(function* () {
      // As it was when asked; counting below may take long enough for a short pass to end.
      const current = activity;
      const settings = yield* config.read;
      // While a pass runs, the counts it started from are good enough and spare the worker a walk.
      const counts =
        current?.status === "running" && latestCounts
          ? latestCounts
          : yield* countTranscripts.pipe(Effect.orElseSucceed(() => latestCounts ?? []));
      return {
        enabled: settings.importsEnabled ?? false,
        interpret: settings.importsInterpret ?? true,
        sources: importSources.map((source) => {
          const totals = decodeSourceTotals(sourceTotals.get(source.name));
          return {
            name: source.name,
            root: source.root(home),
            transcripts: counts.find((entry) => entry.source === source.name)?.transcripts ?? 0,
            migrated: totals.migrated,
            nodes: totals.nodes,
            failed: totals.failed,
          };
        }),
        unplaced: skippedFolders.all().map((row) => decodeSkipped(row)),
        failures: failedTranscripts.all(listedFailures).map((row) => decodeFailure(row)),
        unindexed: yield* indexer.pending,
        activity: current,
      } satisfies ImportOverview;
    });

    return {
      runOnce,
      start: startPass,
      overview,
      /** Turns migration on or off and, when turning it on, starts reading what is there now. */
      setEnabled: (enabled: boolean) =>
        Effect.zipRight(
          config.update({ importsEnabled: enabled }),
          enabled ? startPass : Effect.void,
        ),
      setInterpret: (interpret: boolean) =>
        Effect.asVoid(config.update({ importsInterpret: interpret })),
    };
  });

/**
 * Migrates other coding agents' local transcripts into this app's memory, and keeps following them
 * as they grow. Reads only; the transcripts stay where their tool wrote them. The reading runs in a
 * worker thread; this service starts passes, reports on them and embeds what they wrote.
 */
export class Importer extends Context.Tag("memory-agent/Importer")<
  Importer,
  Effect.Effect.Success<ReturnType<typeof make>>
>() {
  static readonly layer = (watching: boolean = true, home: string = homedir()) =>
    Layer.scoped(Importer, make(watching, home));
}
