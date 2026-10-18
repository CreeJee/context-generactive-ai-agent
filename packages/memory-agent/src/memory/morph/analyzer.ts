import { NodeFileSystem, NodePath, NodeWorker } from "@effect/platform-node";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.

import { Worker } from "node:worker_threads";
import {
  Context,
  Deferred,
  FileSystem,
  Path,
  Effect,
  Exit,
  Layer,
  Option,
  Schema,
  ScopedRef,
  Semaphore,
} from "effect";
import { RpcClient, type RpcClientError } from "effect/rpc";
import { StorageRoot } from "../../config/storage-root.ts";
import { ArchiveInstaller, archiveInstallerLayer } from "../../runtime/archive.ts";
import { runtimeWorker, runtimeWorkerOptions } from "../../runtime/resources.ts";
import { KiwiRpcs, type KiwiWorkerData, KiwiWorkerFailed } from "./kiwi-rpc.ts";

export class MorphAnalysisFailed extends Schema.TaggedError<MorphAnalysisFailed>()(
  "MorphAnalysisFailed",
  {
    /**
     * `not_ready`: the analyzer was not loaded yet and the caller did not wait. `disabled`: there is
     * no analyzer. `model_install_failed`: the model could not be downloaded or extracted.
     * `worker_failed`: the worker failed to load or answer; `cause` says which.
     */
    reason: Schema.Literals(["not_ready", "disabled", "model_install_failed", "worker_failed"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface MorphAnalyzerApi {
  /** Changes whenever terms from this analyzer are not comparable with earlier ones. */
  readonly identity: string;
  /**
   * True once the analyzer answers without first downloading or loading a model. A search should
   * not wait seconds for that; it calls {@link warm} and searches without morphemes meanwhile.
   */
  readonly ready: () => boolean;
  /** Starts loading in the background, if it is not loaded or loading already. */
  readonly warm: () => void;
  /** Search terms per text, in order: lowercased nouns, stems, roots, foreign words, numbers. */
  readonly terms: (texts: readonly string[]) => Effect.Effect<string[][], MorphAnalysisFailed>;
}

/** Pinned model release; the archive is checked before anything is extracted. */
export const kiwiModel = {
  version: "0.24.0",
  url: "https://github.com/bab2min/Kiwi/releases/download/v0.24.0/kiwi_model_v0.24.0_base.tgz",
  sha256: "33188ba932bba4717bad5244bbec0ef8b1c9cbb47e26e68394a7976d8d779083",
  directory: "models/cong/base",
} as const;

/** Texts sent to the worker per message. */
const batchSize = 64;
/** Longest text analyzed; the rest of a long tool output adds little to search terms. */
const maxCharacters = 20_000;

/** Downloads and extracts the model once, into `<storage>/models/kiwi-<version>`. */
const ensureModel = Effect.fn("MorphAnalyzer.ensureModel")(
  function* (storageRoot: string) {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const installer = yield* ArchiveInstaller;
    const root = paths.join(storageRoot, "models", `kiwi-${kiwiModel.version}`);
    const modelDirectory = paths.join(root, kiwiModel.directory);
    if (yield* fs.exists(paths.join(modelDirectory, "cong.mdl"))) return modelDirectory;
    yield* fs.makeDirectory(paths.dirname(root), { recursive: true, mode: 0o700 });
    yield* installer.install({
      archive: { url: kiwiModel.url, algorithm: "sha256", digest: kiwiModel.sha256 },
      target: root,
    });
    return modelDirectory;
  },
  Effect.mapError((cause) => MorphAnalysisFailed.make({ reason: "model_install_failed", cause })),
);

/** One running Kiwi worker, with its model built, as the host uses it. */
interface KiwiSession {
  readonly terms: (
    texts: readonly string[],
  ) => Effect.Effect<readonly (readonly string[])[], KiwiWorkerFailed>;
  /** Keeps the process alive while `work` runs; an idle worker must not. */
  readonly busy: <A, E, R>(work: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

/** The worker thread behind a session. Transport failures mean the worker is gone. */
const rpcSession = (data: KiwiWorkerData) =>
  Effect.gen(function* () {
    const spawned = yield* Deferred.make<Worker>();
    const workers = NodeWorker.layer(() => {
      const worker = new Worker(runtimeWorker("kiwi-worker"), runtimeWorkerOptions(data));
      worker.unref();
      Deferred.doneUnsafe(spawned, Exit.succeed(worker));
      return worker;
    });
    const protocol = yield* Layer.build(
      RpcClient.layerProtocolWorker({ size: 1, concurrency: 1 }).pipe(Layer.provide(workers)),
    );
    const client = yield* RpcClient.make(KiwiRpcs).pipe(Effect.provideContext(protocol));
    const lost = (cause: unknown) =>
      KiwiWorkerFailed.make({ stage: "lost", reason: String(cause) });
    const call = <A>(effect: Effect.Effect<A, KiwiWorkerFailed | RpcClientError.RpcClientError>) =>
      effect.pipe(Effect.catchTag("RpcClientError", (error) => Effect.fail(lost(error))));
    yield* call(client.Load());
    const worker = yield* Deferred.await(spawned);
    return {
      terms: (texts) => call(client.Terms({ texts })),
      busy: (work) =>
        Effect.acquireUseRelease(
          Effect.sync(() => worker.ref()),
          () => work,
          () => Effect.sync(() => worker.unref()),
        ),
    } satisfies KiwiSession;
  }).pipe(
    Effect.catchTag("WorkerError", (error) =>
      Effect.fail(KiwiWorkerFailed.make({ stage: "lost", reason: String(error) })),
    ),
  );

/** A worker that failed to load or was lost is replaced by the next request's new one. */
const keepsSession = (error: KiwiWorkerFailed) => {
  switch (error.stage) {
    case "run":
      return true;
    case "load":
    case "lost":
      return false;
  }
};

const workerFailed = (cause: KiwiWorkerFailed) =>
  Effect.fail(MorphAnalysisFailed.make({ reason: "worker_failed", cause }));

/**
 * Kiwi in a worker, started on first use and kept. Building the model peaks at ~900 MB and settles
 * near 240 MB (macOS physical footprint). Ending an idle worker was measured and dropped: the
 * footprint did not go down, and every restart paid the build peak and ~2 s again.
 *
 * The session lives in a `ScopedRef` owned by the layer's Scope: replacing it (after a lost or
 * failed worker) and closing the Scope both stop the worker and await its exit.
 */
const makeKiwi = Effect.gen(function* () {
  const storage = yield* StorageRoot;
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path | ArchiveInstaller>();
  const connect = ensureModel(storage.path).pipe(
    Effect.provideContext(context),
    Effect.flatMap((modelDirectory) => rpcSession({ modelDirectory })),
    Effect.asSome,
  );
  const session = yield* ScopedRef.make(() => Option.none<KiwiSession>());
  // One request holds the worker at a time, so `busy` pairs each ref with its unref.
  const oneRequest = yield* Semaphore.make(1);
  const discard = ScopedRef.set(session, Effect.succeed(Option.none<KiwiSession>()));
  const live = Effect.flatMap(
    ScopedRef.get(session),
    Option.match({
      onSome: Effect.succeed,
      onNone: () =>
        ScopedRef.set(session, connect).pipe(
          Effect.andThen(ScopedRef.get(session)),
          // `set` just stored the session it acquired.
          Effect.map(Option.getOrThrow),
        ),
    }),
  ).pipe(Effect.catchTag("KiwiWorkerFailed", workerFailed));

  const request = (texts: readonly string[]) =>
    Effect.flatMap(live, (current) =>
      current.busy(current.terms(texts.map((text) => text.slice(0, maxCharacters)))).pipe(
        Effect.tapError((error) => (keepsSession(error) ? Effect.void : discard)),
        Effect.catchTag("KiwiWorkerFailed", workerFailed),
      ),
    ).pipe(oneRequest.withPermits(1));

  const layerScope = yield* Effect.scope;
  const fork = Effect.runForkWith(context);

  return {
    identity: `kiwi-${kiwiModel.version}-cong-v1`,
    ready: () => Option.isSome(ScopedRef.getUnsafe(session)),
    // Starting the session loads the model; failures (offline, no model) just leave it not ready.
    warm: () => {
      fork(Effect.forkIn(live.pipe(oneRequest.withPermits(1), Effect.ignore), layerScope));
    },
    terms: Effect.fnUntraced(function* (texts: readonly string[]) {
      const all: string[][] = [];
      for (let index = 0; index < texts.length; index += batchSize)
        all.push(
          ...(yield* request(texts.slice(index, index + batchSize))).map((terms) => [...terms]),
        );
      return all;
    }),
  } satisfies MorphAnalyzerApi;
});

/** Korean morphological analysis for search terms. */
export class MorphAnalyzer extends Context.Service<MorphAnalyzer, MorphAnalyzerApi>()(
  "memory-agent/memory/morph/analyzer/MorphAnalyzer",
) {
  /** Kiwi in a worker thread, with its model downloaded to `<storage>/models` on first use. */
  static readonly kiwi = Layer.effect(MorphAnalyzer, makeKiwi).pipe(
    Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, archiveInstallerLayer)),
  );

  /** No analyzer: search runs without morpheme terms. */
  static readonly disabled = Layer.succeed(MorphAnalyzer, {
    identity: "none",
    ready: () => false,
    warm: () => undefined,
    terms: () => Effect.fail(MorphAnalysisFailed.make({ reason: "disabled" })),
  });
}
