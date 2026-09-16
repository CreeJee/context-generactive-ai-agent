import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { Context, Data, Effect, Layer, Schema } from "effect";
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

const Reply = Schema.Union(
  Schema.Struct({
    id: Schema.Number,
    kind: Schema.Literal("terms"),
    terms: Schema.Array(Schema.Array(Schema.String)),
  }),
  Schema.Struct({ id: Schema.Number, kind: Schema.Literal("error"), error: Schema.String }),
);
const decodeReply = Schema.decodeUnknownSync(Reply);

/** Downloads and extracts the model once, into `<storage>/models/kiwi-<version>`. */
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
  let worker: Worker | null = null;
  let loaded = false;
  let starting: Promise<Worker> | null = null;
  let nextId = 1;
  const pending = new Map<number, (reply: typeof Reply.Type) => void>();

  const stop = () => {
    const current = worker;
    worker = null;
    loaded = false;
    for (const [id, resolve] of pending) resolve({ id, kind: "error", error: "analyzer stopped" });
    pending.clear();
    void current?.terminate();
  };

  const start = async () => {
    const modelDirectory = await ensureModel(storage.path);
    const created = new Worker(runtimeWorker("kiwi-worker"), { workerData: { modelDirectory } });
    created.on("message", (message) => {
      const reply = decodeReply(message);
      pending.get(reply.id)?.(reply);
      pending.delete(reply.id);
      // An idle worker must not keep the process alive; one with requests in flight must.
      if (pending.size === 0) created.unref();
    });
    created.on("error", () => {
      if (worker === created) stop();
    });
    created.unref();
    return created;
  };

  const running = () => {
    if (worker) return Promise.resolve(worker);
    starting ??= start().then(
      (created) => {
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

  const request = async (texts: readonly string[]) => {
    const current = await running();
    const id = nextId++;
    const reply = await new Promise<typeof Reply.Type>((resolve) => {
      pending.set(id, resolve);
      current.ref();
      current.postMessage({ id, texts: texts.map((text) => text.slice(0, maxCharacters)) });
    });
    switch (reply.kind) {
      case "error":
        throw new Error(reply.error);
      case "terms":
        loaded = true;
        return reply.terms.map((terms) => [...terms]);
    }
  };

  yield* Effect.addFinalizer(() => Effect.sync(stop));

  return {
    identity: `kiwi-${kiwiModel.version}-cong-v1`,
    ready: () => loaded && worker !== null,
    // A tiny request loads the model; failures (offline, no model) just leave it not ready.
    warm: () => void request(["준비"]).catch(() => undefined),
    terms: (texts: readonly string[]) =>
      Effect.tryPromise({
        try: async () => {
          const all: string[][] = [];
          for (let index = 0; index < texts.length; index += batchSize)
            all.push(...(await request(texts.slice(index, index + batchSize))));
          return all;
        },
        catch: (error) =>
          new MorphAnalysisFailed({
            reason: error instanceof Error ? error.message : String(error),
          }),
      }),
  } satisfies MorphAnalyzerApi;
});

/** Korean morphological analysis for search terms. */
export class MorphAnalyzer extends Context.Tag("memory-agent/MorphAnalyzer")<
  MorphAnalyzer,
  MorphAnalyzerApi
>() {
  /** Kiwi in a worker thread, with its model downloaded to `<storage>/models` on first use. */
  static readonly kiwi = Layer.scoped(MorphAnalyzer, makeKiwi);

  /** No analyzer: search runs without morpheme terms. */
  static readonly disabled = Layer.succeed(MorphAnalyzer, {
    identity: "none",
    ready: () => false,
    warm: () => undefined,
    terms: () => Effect.fail(new MorphAnalysisFailed({ reason: "disabled" })),
  });
}
