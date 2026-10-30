import { NodeWorker } from "@effect/platform-node";
import { ignoreLogged } from "../runtime/logged-failures.ts";
import {
  healthyLoop,
  LoopStep,
  sameLoopHealth,
  superviseLoopStep,
  type LoopHealth,
} from "../runtime/loop-health.ts";
import { isTruthy } from "../truthy.ts";
import { DateTime, Clock, Semaphore } from "effect";
// NodeWorker spawns the thread this constructor makes.
import { Worker } from "node:worker_threads";
import {
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  FiberHandle,
  Layer,
  Option,
  Ref,
  Schedule,
  Schema,
  ScopedRef,
  Stream,
  SynchronizedRef,
} from "effect";
import { RpcClient } from "effect/rpc";
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
  ImportRpcs,
  ImportWorkerFailed,
  type ImportWorkerSetup,
  PassEvent,
} from "./worker-protocol.ts";

export { ImportWorkerFailed } from "./worker-protocol.ts";

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
export type ImportActivity = Data.TaggedEnum<{
  running: PassProgress & { readonly startedAt: string };
  finished: PassProgress & { readonly startedAt: string; readonly finishedAt: string };
  /** The worker itself failed (not one transcript): nothing after that point was read. */
  crashed: {
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly reason: ImportWorkerFailed["reason"];
  };
}>;
export const ImportActivity = Data.taggedEnum<ImportActivity>();

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
  /** How the watcher that runs a pass every few minutes stands; null when this server has none. */
  readonly watch: LoopHealth | null;
}

const progressOf = (reply: PassProgress): PassProgress => ({
  checked: reply.checked,
  total: reply.total,
  written: reply.written,
  failed: reply.failed,
});

/** The import worker as the importer uses it. Transport failures mean the worker is gone. */
interface WorkerSession {
  readonly count: Effect.Effect<TranscriptCounts, ImportWorkerFailed>;
  readonly run: Stream.Stream<PassEvent, ImportWorkerFailed>;
  /** Keeps the process alive while `work` runs; an idle worker must not. */
  readonly busy: <A, E, R>(work: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

/** The worker thread behind a session, over Effect RPC. Its Scope stops the worker. */
const rpcSession = (setup: ImportWorkerSetup) =>
  Effect.gen(function* () {
    const spawned = yield* Deferred.make<Worker, ImportWorkerFailed>();
    const file = yield* runtimeWorker("import-worker").pipe(
      Effect.mapError(() => ImportWorkerFailed.make({ reason: "start" })),
    );
    const options = yield* runtimeWorkerOptions(setup);
    const workers = NodeWorker.layer(() => {
      // A spawn that throws is only retried by the protocol; settle the wait below with it.
      try {
        const worker = new Worker(file, options);
        worker.unref();
        Deferred.doneUnsafe(spawned, Exit.succeed(worker));
        return worker;
      } catch (cause) {
        Deferred.doneUnsafe(spawned, Exit.fail(ImportWorkerFailed.make({ reason: "start" })));
        throw cause;
      }
    });
    // A count may be asked for while a pass streams; each holds a slot until it is answered. The
    // pass's write turns hold two more, and a turn must not wait for a slot while it holds the
    // server's connection.
    const protocol = yield* Layer.build(
      RpcClient.layerProtocolWorker({ size: 1, concurrency: 8 }).pipe(Layer.provide(workers)),
    );
    const client = yield* RpcClient.make(ImportRpcs).pipe(Effect.provideContext(protocol));
    const worker = yield* Deferred.await(spawned);
    // Each piece of a pass is written while the server's connection is held for it, in line with
    // the server's own statements (`write-turns.ts`).
    const sql = yield* SqlClient.SqlClient;
    yield* client.WriteTurns().pipe(
      Stream.runForEach(() =>
        Effect.scoped(Effect.andThen(sql.reserve, client.Turn())).pipe(
          // A turn not given only makes that piece wait out its timeout.
          Effect.ignore,
        ),
      ),
      // The worker is gone; the next request finds that out and replaces it.
      Effect.ignore,
      Effect.forkScoped,
    );
    const lost = () => ImportWorkerFailed.make({ reason: "lost" });
    const inFlight = yield* Ref.make(0);
    return {
      count: client.Count().pipe(Effect.catchTag("RpcClientError", () => Effect.fail(lost()))),
      run: client.Run().pipe(Stream.catchTag("RpcClientError", () => Stream.fail(lost()))),
      busy: (work) =>
        Effect.acquireUseRelease(
          Ref.update(inFlight, (count) => count + 1).pipe(
            Effect.andThen(Effect.sync(() => worker.ref())),
          ),
          () => work,
          () =>
            Effect.sync(() => worker.unref()).pipe(
              Effect.when(
                Ref.updateAndGet(inFlight, (count) => count - 1).pipe(
                  Effect.map((count) => count === 0),
                ),
              ),
            ),
        ),
    } satisfies WorkerSession;
  }).pipe(
    Effect.catchTag("WorkerError", () => Effect.fail(ImportWorkerFailed.make({ reason: "start" }))),
  );

const make = (watching: boolean, home: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const storage = yield* StorageRoot;
    const config = yield* GlobalConfig;
    const events = yield* AppEvents;
    const indexer = yield* Indexer;
    const projects = yield* Projects;
    const oneDrainAtATime = yield* Semaphore.make(1);

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

    // The worker: started on first use and kept. It is replaced when it is lost, and this layer's
    // Scope stops it.
    const setup: ImportWorkerSetup = { storageRoot: storage.path, home };
    const session = yield* ScopedRef.make(() => Option.none<WorkerSession>());
    // Starting and replacing the worker happen one at a time; requests to a live one do not wait.
    const lifecycle = yield* Semaphore.make(1);
    const live = Effect.flatMap(
      ScopedRef.get(session),
      Option.match({
        onSome: Effect.succeed,
        onNone: () =>
          // `set` acquires uninterruptibly; starting a worker must still stop when the Scope closes.
          ScopedRef.set(
            session,
            Effect.interruptible(rpcSession(setup)).pipe(Effect.map(Option.some)),
          ).pipe(
            Effect.andThen(ScopedRef.get(session)),
            // `set` just stored the session it acquired.
            Effect.map(Option.getOrThrow),
          ),
      }),
    ).pipe(lifecycle.withPermits(1));
    /** Drops a lost worker, unless another request already replaced it. */
    const discard = (lost: WorkerSession) =>
      ScopedRef.set(session, Effect.succeed(Option.none<WorkerSession>())).pipe(
        Effect.when(
          Effect.map(
            ScopedRef.get(session),
            Option.exists((current) => current === lost),
          ),
        ),
        lifecycle.withPermits(1),
      );
    const request = <A>(call: (current: WorkerSession) => Effect.Effect<A, ImportWorkerFailed>) =>
      Effect.flatMap(live, (current) =>
        current
          .busy(call(current))
          .pipe(
            Effect.tapError((error) =>
              discard(current).pipe(Effect.when(Effect.succeed(error.reason === "lost"))),
            ),
          ),
      );

    /** Transcripts on disk per source, counted by the worker so the folders are walked there. */
    const latestCounts = yield* Ref.make<TranscriptCounts | null>(null);
    const countTranscripts = request((current) => current.count).pipe(
      Effect.tap((counts) => Ref.set(latestCounts, counts)),
    );

    const activity = yield* Ref.make<ImportActivity | null>(null);
    /** Shows the pass as it is now in settings. */
    const showActivity = (next: ImportActivity) =>
      Effect.andThen(Ref.set(activity, next), events.publishGlobal("imports"));
    const running = yield* SynchronizedRef.make(
      Option.none<Deferred.Deferred<number, ImportWorkerFailed>>(),
    );

    const pass = (startedAt: string) =>
      request((current) =>
        current.run.pipe(
          Stream.runFoldEffect(
            () => Option.none<PassProgress>(),
            (outcome, event) =>
              PassEvent.match(event, {
                Progress: (progress) =>
                  Effect.as(
                    showActivity(ImportActivity.running({ startedAt, ...progressOf(progress) })),
                    outcome,
                  ),
                Finished: (finished) =>
                  Effect.as(
                    Ref.set(latestCounts, finished.counts),
                    Option.some(progressOf(finished)),
                  ),
              }),
          ),
          // The worker ends every pass it answers with `Finished`; a stream without one was cut off.
          Effect.flatMap(
            Option.match({
              onSome: Effect.succeed,
              onNone: () => Effect.fail(ImportWorkerFailed.make({ reason: "lost" })),
            }),
          ),
        ),
      ).pipe(
        Effect.tap(() =>
          Effect.andThen(events.publishGlobal("imports"), events.publishGlobal("projects")),
        ),
      );

    // Passes and the backlog after them run in this layer's scope, not a request's: a request that
    // starts a pass is answered at once, and the pass outlives it.
    const layerScope = yield* Effect.scope;

    const crashed = (startedAt: string, reason: ImportWorkerFailed["reason"]) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        showActivity(
          ImportActivity.crashed({
            startedAt,
            finishedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
            reason,
          }),
        ),
      );

    /**
     * The running pass, or a new one. Two passes would import a line twice before either marks it,
     * so the check and the start hold the ref together.
     */
    const begin = SynchronizedRef.modifyEffect(running, (current) =>
      Option.match(current, {
        onSome: (done) => Effect.succeed([done, current] as const),
        onNone: () =>
          Effect.gen(function* () {
            const done = yield* Deferred.make<number, ImportWorkerFailed>();
            const startedAt = DateTime.formatIso(
              DateTime.makeUnsafe(yield* Clock.currentTimeMillis),
            );
            yield* showActivity(
              ImportActivity.running({
                startedAt,
                checked: 0,
                total: 0,
                written: 0,
                failed: 0,
              }),
            );
            yield* pass(startedAt).pipe(
              Effect.tap((progress) =>
                Effect.flatMap(Clock.currentTimeMillis, (now) =>
                  showActivity(
                    ImportActivity.finished({
                      startedAt,
                      finishedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
                      ...progress,
                    }),
                  ),
                ),
              ),
              Effect.tap(() =>
                Effect.tap(projects.listAll, (list) =>
                  Effect.forEach(list, (project) => events.publishProject(project.id, "sessions"), {
                    discard: true,
                  }),
                ).pipe(
                  // The pass is done either way; pages only miss the hint to reload their lists.
                  Effect.catch((error) =>
                    Effect.logWarning("Imported sessions were not announced", error),
                  ),
                ),
              ),
              Effect.tapError((failure) => crashed(startedAt, failure.reason)),
              // A defect in the worker's pass stops it; the watcher reports it.
              Effect.tapDefect(() => crashed(startedAt, "pass")),
              Effect.map((progress) => progress.written),
              Effect.onExit((exit) =>
                Effect.andThen(
                  SynchronizedRef.set(running, Option.none()),
                  Deferred.done(done, exit),
                ),
              ),
              Effect.forkIn(layerScope),
            );
            return [done, Option.some(done)] as const;
          }),
      }),
    );

    /** One pass, waited for. Returns how many nodes it wrote; embedding them is left to the caller. */
    const runOnce = Effect.flatMap(begin, Deferred.await);

    /**
     * Embeds and analyses what a migration added, taking as long as it takes. The indexer gives up
     * its permit between batches, so a conversation held meanwhile is still indexed first: its
     * nodes are the newest by time, and that is the order pending nodes come out in.
     */
    const backfill = Effect.andThen(indexer.indexAll(), indexer.analyzeAll()).pipe(
      // Pending nodes stay pending; the next pass or start indexes them.
      ignoreLogged("import_backfill_failed"),
      oneDrainAtATime.withPermits(1),
    );

    /** Starts a pass (or joins the running one) and returns at once; its backlog follows it. */
    const startPass = Effect.flatMap(begin, (done) =>
      Effect.forkIn(
        Deferred.await(done).pipe(
          Effect.flatMap((written) => (written > 0 ? backfill : Effect.void)),
          // The pass already recorded its outcome; settings shows it.
          ignoreLogged("import_pass_failed"),
        ),
        layerScope,
      ),
    ).pipe(Effect.asVoid);

    const watchHealth = yield* Ref.make<LoopHealth>(healthyLoop);
    const setWatchHealth = (next: LoopHealth) =>
      Effect.asVoid(
        Effect.when(
          events.publishGlobal("imports"),
          Ref.modify(watchHealth, (current) => [!sameLoopHealth(current, next), next]),
        ),
      );
    /**
     * Runs a pass every few minutes while migration is on. A failed round is retried with backoff;
     * when the retries run out, or a defect happens, the watcher stops and settings shows why
     * until the user restarts it (decided 2026-10-18).
     */
    const watchLoop = Effect.gen(function* () {
      const settings = yield* config.read;
      const pass = Effect.flatMap(runOnce, (written) =>
        Effect.when(backfill, Effect.succeed(written > 0)),
      );
      yield* Effect.when(pass, Effect.succeed(settings.importsEnabled === true));
    }).pipe(
      superviseLoopStep({ message: "import_watch_failed", setHealth: setWatchHealth }),
      Effect.repeat({
        schedule: Schedule.spaced(pollEvery),
        while: LoopStep.$is("Continued"),
      }),
    );
    const watcher = yield* FiberHandle.make();
    const startWatch = FiberHandle.run(watcher, watchLoop, { onlyIfMissing: true });
    yield* Effect.when(startWatch, Effect.succeed(watching));

    const overview = Effect.gen(function* () {
      // As it was when asked; counting below may take long enough for a short pass to end.
      const current = yield* Ref.get(activity);
      const settings = yield* config.read;
      const known = yield* Ref.get(latestCounts);
      // While a pass runs, the counts it started from are good enough and spare the worker a walk.
      const counts =
        ImportActivity.$is("running")(current) && isTruthy(known)
          ? known
          : yield* countTranscripts.pipe(
              // The worker could not count: the last counts, or none, until it can.
              Effect.catchTag("ImportWorkerFailed", (error) =>
                Effect.andThen(
                  Effect.logDebug("import_count_failed", { reason: error.reason }),
                  Effect.map(Ref.get(latestCounts), (last) => last ?? []),
                ),
              ),
            );
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
        watch: watching ? yield* Ref.get(watchHealth) : null,
      } satisfies ImportOverview;
    });

    return {
      runOnce,
      start: startPass,
      overview,
      /** The watch loop's health without counting transcripts; `null` when not watching. */
      watchHealth: Effect.map(Ref.get(watchHealth), (health) => (watching ? health : null)),
      /** Turns migration on or off and, when turning it on, starts reading what is there now. */
      setEnabled: (enabled: boolean) =>
        Effect.andThen(
          config.update({ importsEnabled: enabled }),
          enabled ? startPass : Effect.void,
        ),
      /** Starts the watcher again after it stopped on exhausted retries or a defect. */
      restartWatch: Effect.andThen(setWatchHealth(healthyLoop), startWatch).pipe(
        Effect.when(Effect.succeed(watching)),
        Effect.asVoid,
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
