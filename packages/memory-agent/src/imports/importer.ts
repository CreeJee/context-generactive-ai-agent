import { isTruthy } from "../truthy.ts";
import { DateTime, Clock, Semaphore } from "effect";
import { Worker } from "node:worker_threads";
import {
  Context,
  Data,
  Deferred,
  HashMap,
  Ref,
  Effect,
  Layer,
  Option,
  Schedule,
  Schema,
} from "effect";
import { GlobalConfig } from "../config/global-config.ts";
import { StorageRoot } from "../config/storage-root.ts";
import { homeDirectory } from "../runtime/host-system.ts";
import { SqlClient, SqlSchema } from "effect/sql";
import { AppEvents } from "../events/app-events.ts";
import { Indexer } from "../memory/embedding/indexer.ts";
import { Projects } from "../projects/projects.ts";
import { runtimeWorker, runtimeWorkerOptions } from "../runtime/resources.ts";
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

const decodeReply = Schema.decodeUnknownOption(ImportWorkerReply);

const progressOf = (reply: PassProgress): PassProgress => ({
  checked: reply.checked,
  total: reply.total,
  written: reply.written,
  failed: reply.failed,
});

const make = (watching: boolean, home: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const storage = yield* StorageRoot;
    const config = yield* GlobalConfig;
    const events = yield* AppEvents;
    const indexer = yield* Indexer;
    const projects = yield* Projects;
    const oneDrainAtATime = yield* Semaphore.make(1);
    const context = yield* Effect.context<never>();
    const runSync = Effect.runSyncWith(context);

    const sourceTotals = SqlSchema.findOne({
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
      Result: Schema.Struct({
        source: ImportSourceName,
        path: Schema.String,
        reason: Schema.String,
      }),
      execute: () => sql`
        SELECT source, path, failure AS reason FROM import_cursors
        WHERE failure IS NOT NULL ORDER BY source, path LIMIT ${listedFailures}`,
    });

    // The worker: started on first use and kept. It answers each request with any number of
    // `progress` replies and then one final reply.
    const setup: ImportWorkerSetup = { storageRoot: storage.path, home };
    let worker: Worker | null = null;
    let nextId = 1;
    const listeners = yield* Ref.make(
      HashMap.empty<
        number,
        {
          readonly done: Deferred.Deferred<ImportWorkerReply>;
          readonly progress: (reply: PassProgress) => void;
        }
      >(),
    );

    const stop = (reason: string) => {
      const current = worker;
      worker = null;
      const waiting = runSync(Ref.getAndSet(listeners, HashMap.empty()));
      for (const [id, entry] of waiting)
        Deferred.doneUnsafe(entry.done, Effect.succeed({ id, kind: "failed", reason }));
      return current?.terminate();
    };

    const start = () => {
      const created = new Worker(runtimeWorker("import-worker"), runtimeWorkerOptions(setup));
      const lost = () => {
        if (worker === created) void stop("the import worker stopped");
      };
      created.on("message", (message) => {
        const decoded = decodeReply(message);
        if (Option.isNone(decoded)) return lost();
        const reply = decoded.value;
        const listen = Option.getOrUndefined(HashMap.get(runSync(Ref.get(listeners)), reply.id));
        switch (reply.kind) {
          case "progress":
            listen?.progress(reply);
            return;
          case "counts":
          case "finished":
          case "failed":
            runSync(Ref.update(listeners, HashMap.remove(reply.id)));
            if (isTruthy(listen)) Deferred.doneUnsafe(listen.done, Effect.succeed(reply));
            // An idle worker must not keep the process alive; one with requests in flight must.
            if (HashMap.isEmpty(runSync(Ref.get(listeners)))) created.unref();
        }
      });
      created.on("error", lost);
      created.on("exit", lost);
      created.unref();
      return created;
    };

    const ask = Effect.fnUntraced(function* (
      kind: ImportWorkerRequest["kind"],
      progress: (reply: PassProgress) => void = () => undefined,
    ) {
      const current = yield* Effect.try({
        try: () => (worker ??= start()),
        catch: () => new ImportWorkerFailed({ reason: "the import worker could not start" }),
      });
      const id = nextId++;
      const done = yield* Deferred.make<ImportWorkerReply>();
      return yield* Ref.update(listeners, HashMap.set(id, { done, progress })).pipe(
        Effect.andThen(
          Effect.try({
            try: () => {
              current.ref();
              current.postMessage({ id, kind } satisfies ImportWorkerRequest);
            },
            catch: () => new ImportWorkerFailed({ reason: "the import worker request failed" }),
          }),
        ),
        Effect.andThen(Deferred.await(done)),
        Effect.ensuring(
          Ref.updateAndGet(listeners, HashMap.remove(id)).pipe(
            Effect.map((remaining) => {
              if (HashMap.isEmpty(remaining)) current.unref();
            }),
          ),
        ),
      );
    });

    yield* Effect.addFinalizer(() =>
      // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
      Effect.promise(
        () => stop("the importer stopped")?.then(() => undefined) ?? Promise.resolve(),
      ).pipe(Effect.asVoid),
    );

    /** Transcripts on disk per source, counted by the worker so the folders are walked there. */
    let latestCounts: TranscriptCounts | null = null;
    const countTranscripts = Effect.gen(function* () {
      const reply = yield* ask("count");
      switch (reply.kind) {
        case "counts":
          latestCounts = reply.counts;
          return reply.counts;
        case "failed":
          return yield* new ImportWorkerFailed({ reason: reply.reason });
        case "progress":
        case "finished":
          return yield* new ImportWorkerFailed({ reason: "unexpected import count reply" });
      }
    });

    let activity: ImportActivity | null = null;
    let running: Deferred.Deferred<number, ImportWorkerFailed> | null = null;

    const pass = Effect.fnUntraced(function* (startedAt: string) {
      const reply = yield* ask("run", (progress) => {
        activity = { status: "running", startedAt, ...progressOf(progress) };
        events.publishGlobal("imports");
      });
      events.publishGlobal("imports");
      switch (reply.kind) {
        case "finished":
          latestCounts = reply.counts;
          events.publishGlobal("projects");
          return progressOf(reply);
        case "failed":
          return yield* new ImportWorkerFailed({ reason: reply.reason });
        case "counts":
        case "progress":
          return yield* new ImportWorkerFailed({ reason: "unexpected import pass reply" });
      }
    });

    // Passes and the backlog after them run in this layer's scope, not a request's: a request that
    // starts a pass is answered at once, and the pass outlives it.
    const layerScope = yield* Effect.scope;

    /** The running pass, or a new one. Two passes would import a line twice before either marks it. */
    const begin = Effect.suspend(() => {
      if (running !== null) return Effect.succeed(running);
      return Effect.gen(function* () {
        const effectClock = yield* Clock.Clock;

        const done = yield* Deferred.make<number, ImportWorkerFailed>();
        running = done;
        const startedAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
        activity = { status: "running", startedAt, checked: 0, total: 0, written: 0, failed: 0 };
        events.publishGlobal("imports");
        yield* pass(startedAt).pipe(
          Effect.tap((progress) =>
            Effect.sync(() => {
              activity = {
                status: "finished",
                startedAt,
                finishedAt: DateTime.formatIso(
                  DateTime.makeUnsafe(effectClock.currentTimeMillisUnsafe()),
                ),
                ...progress,
              };
              events.publishGlobal("imports");
            }),
          ),
          Effect.tap(() =>
            Effect.tap(projects.listAll, (list) =>
              Effect.sync(() => {
                for (const project of list) events.publishProject(project.id, "sessions");
              }),
            ).pipe(
              // The pass is done either way; pages only miss the hint to reload their lists.
              Effect.catch((error) =>
                Effect.logWarning("Imported sessions were not announced", error),
              ),
            ),
          ),
          Effect.tapError((failure) =>
            Effect.sync(() => {
              activity = {
                status: "crashed",
                startedAt,
                finishedAt: DateTime.formatIso(
                  DateTime.makeUnsafe(effectClock.currentTimeMillisUnsafe()),
                ),
                reason: failure.reason,
              };
              events.publishGlobal("imports");
            }),
          ),
          Effect.map((progress) => progress.written),
          Effect.onExit((exit) =>
            Effect.andThen(
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
    const backfill = Effect.andThen(indexer.indexAll(), indexer.analyzeAll()).pipe(
      Effect.ignoreCause,
      oneDrainAtATime.withPermits(1),
    );

    /** Starts a pass (or joins the running one) and returns at once; its backlog follows it. */
    const startPass = Effect.flatMap(begin, (done) =>
      Effect.forkIn(
        Deferred.await(done).pipe(
          Effect.flatMap((written) => (written > 0 ? backfill : Effect.void)),
          Effect.ignoreCause,
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
          }).pipe(Effect.ignoreCause),
          Schedule.spaced(pollEvery),
        ),
      );

    const overview = Effect.gen(function* () {
      // As it was when asked; counting below may take long enough for a short pass to end.
      const current = activity;
      const settings = yield* config.read;
      // While a pass runs, the counts it started from are good enough and spare the worker a walk.
      const counts =
        current?.status === "running" && isTruthy(latestCounts)
          ? latestCounts
          : yield* countTranscripts.pipe(Effect.orElseSucceed(() => latestCounts ?? []));
      return {
        enabled: settings.importsEnabled ?? false,
        interpret: settings.importsInterpret ?? true,
        sources: yield* Effect.forEach(importSources, (source) =>
          Effect.map(sourceTotals(source.name), (totals) => ({
            name: source.name,
            root: source.root(home),
            transcripts: counts.find((entry) => entry.source === source.name)?.transcripts ?? 0,
            migrated: totals.migrated,
            nodes: totals.nodes,
            failed: totals.failed,
          })),
        ),
        unplaced: yield* skippedFolders(),
        failures: yield* failedTranscripts(),
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
        Effect.andThen(
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
export class Importer extends Context.Service<Importer, Effect.Success<ReturnType<typeof make>>>()(
  "memory-agent/imports/importer",
) {
  static readonly layer = (watching: boolean = true, home?: string) =>
    Layer.effect(
      Importer,
      Effect.flatMap(home === undefined ? homeDirectory : Effect.succeed(home), (home) =>
        make(watching, home),
      ),
    );
}
