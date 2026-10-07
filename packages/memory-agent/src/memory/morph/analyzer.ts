import { isTruthy } from "../../truthy.ts";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { existsSync, mkdirSync } from "node:fs";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { Context, Data, Deferred, HashMap, Ref, Effect, Layer, Option, Schema } from "effect";
import { StorageRoot } from "../../config/storage-root.ts";
import { installArchive } from "../../runtime/archive.ts";
import { runtimeWorker } from "../../runtime/resources.ts";

export class MorphAnalysisFailed extends Data.TaggedError("MorphAnalysisFailed")<{
  readonly reason: string;
}> {}

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

const Reply = Schema.Union([
  Schema.Struct({
    id: Schema.Finite,
    kind: Schema.Literal("terms"),
    terms: Schema.Array(Schema.Array(Schema.String)),
  }),
  Schema.Struct({ id: Schema.Finite, kind: Schema.Literal("error"), error: Schema.String }),
]);
const decodeReply = Schema.decodeUnknownOption(Reply);

/** Downloads and extracts the model once, into `<storage>/models/kiwi-<version>`. */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
async function ensureModel(storageRoot: string) {
  const root = join(storageRoot, "models", `kiwi-${kiwiModel.version}`);
  const modelDirectory = join(root, kiwiModel.directory);
  if (existsSync(join(modelDirectory, "cong.mdl"))) return modelDirectory;
  mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
  const failure = await installArchive(
    { url: kiwiModel.url, algorithm: "sha256", digest: kiwiModel.sha256 },
    root,
  );
  if (failure !== null)
    throw new Error(`Kiwi model install failed (${failure.reason}): ${failure.detail}`);
  return modelDirectory;
}

/**
 * Kiwi in a worker, started on first use and kept. Building the model peaks at ~900 MB and settles
 * near 240 MB (macOS physical footprint). Ending an idle worker was measured and dropped: the
 * footprint did not go down, and every restart paid the build peak and ~2 s again.
 */
const makeKiwi = Effect.gen(function* () {
  const storage = yield* StorageRoot;
  const context = yield* Effect.context<never>();
  const runSync = Effect.runSyncWith(context);
  let worker: Worker | null = null;
  let loaded = false;
  let starting: Promise<Worker> | null = null;
  let nextId = 1;
  const pending = yield* Ref.make(HashMap.empty<number, Deferred.Deferred<typeof Reply.Type>>());

  const stop = () => {
    const current = worker;
    worker = null;
    loaded = false;
    const waiting = runSync(Ref.getAndSet(pending, HashMap.empty()));
    for (const [id, done] of waiting)
      Deferred.doneUnsafe(done, Effect.succeed({ id, kind: "error", error: "analyzer stopped" }));
    return current?.terminate();
  };

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const start = async () => {
    const modelDirectory = await ensureModel(storage.path);
    const created = new Worker(runtimeWorker("kiwi-worker"), { workerData: { modelDirectory } });
    created.on("message", (message) => {
      const decoded = decodeReply(message);
      if (Option.isNone(decoded)) return lost();
      const reply = decoded.value;
      const done = Option.getOrUndefined(HashMap.get(runSync(Ref.get(pending)), reply.id));
      runSync(Ref.update(pending, HashMap.remove(reply.id)));
      if (isTruthy(done)) Deferred.doneUnsafe(done, Effect.succeed(reply));
      // An idle worker must not keep the process alive; one with requests in flight must.
      if (HashMap.isEmpty(runSync(Ref.get(pending)))) created.unref();
    });
    const lost = () => {
      if (worker === created) void stop();
    };
    created.on("error", lost);
    created.on("exit", lost);
    created.unref();
    return created;
  };

  const running = () => {
    if (worker !== null) return Promise.resolve(worker);
    starting ??= start().then(
      (created) => {
        if (closed) {
          void created.terminate();
          throw new MorphAnalysisFailed({ reason: "analyzer stopped" });
        }
        worker = created;
        starting = null;
        return created;
      },
      (error) => {
        starting = null;
        throw error;
      },
    );
    return starting;
  };

  const request = Effect.fnUntraced(function* (texts: readonly string[]) {
    const current = yield* Effect.tryPromise({
      try: () => running(),
      catch: () => new MorphAnalysisFailed({ reason: "analyzer could not start" }),
    });
    const id = nextId++;
    const done = yield* Deferred.make<typeof Reply.Type>();
    const reply = yield* Ref.update(pending, HashMap.set(id, done)).pipe(
      Effect.andThen(
        Effect.try({
          try: () => {
            if (closed || worker !== current)
              throw new MorphAnalysisFailed({ reason: "analyzer stopped" });
            current.ref();
            current.postMessage({ id, texts: texts.map((text) => text.slice(0, maxCharacters)) });
          },
          catch: () => new MorphAnalysisFailed({ reason: "analyzer request failed" }),
        }),
      ),
      Effect.andThen(Deferred.await(done)),
      Effect.ensuring(
        Ref.updateAndGet(pending, HashMap.remove(id)).pipe(
          Effect.map((remaining) => {
            if (HashMap.isEmpty(remaining)) current.unref();
          }),
        ),
      ),
    );
    switch (reply.kind) {
      case "error":
        return yield* new MorphAnalysisFailed({ reason: reply.error });
      case "terms":
        loaded = true;
        return reply.terms.map((terms) => [...terms]);
    }
  });

  const layerScope = yield* Effect.scope;
  const fork = Effect.runForkWith(context);
  let closed = false;
  yield* Effect.addFinalizer(() =>
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    Effect.promise(async () => {
      closed = true;
      await stop();
      if (isTruthy(starting)) {
        const created = await starting.catch(() => null);
        await created?.terminate();
      }
    }),
  );

  return {
    identity: `kiwi-${kiwiModel.version}-cong-v1`,
    ready: () => loaded && worker !== null,
    // A tiny request loads the model; failures (offline, no model) just leave it not ready.
    warm: () => {
      fork(Effect.forkIn(request(["준비"]).pipe(Effect.ignore), layerScope));
    },
    terms: Effect.fnUntraced(function* (texts: readonly string[]) {
      const all: string[][] = [];
      for (let index = 0; index < texts.length; index += batchSize)
        all.push(...(yield* request(texts.slice(index, index + batchSize))));
      return all;
    }),
  } satisfies MorphAnalyzerApi;
});

/** Korean morphological analysis for search terms. */
export class MorphAnalyzer extends Context.Service<MorphAnalyzer, MorphAnalyzerApi>()(
  "memory-agent/memory/morph/analyzer/MorphAnalyzer",
) {
  /** Kiwi in a worker thread, with its model downloaded to `<storage>/models` on first use. */
  static readonly kiwi = Layer.effect(MorphAnalyzer, makeKiwi);

  /** No analyzer: search runs without morpheme terms. */
  static readonly disabled = Layer.succeed(MorphAnalyzer, {
    identity: "none",
    ready: () => false,
    warm: () => undefined,
    terms: () => Effect.fail(new MorphAnalysisFailed({ reason: "disabled" })),
  });
}
