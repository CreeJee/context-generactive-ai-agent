/**
 * The read-only storage assembly for the standalone memory CLI.
 *
 * It provides the memory-read services the CLI commands need over a storage folder opened
 * read-only: `Projects`, `Nodes`, `Graph`, `Interpretations` and `MemorySearch` with the reranker
 * disabled. It differs from `memoryAgentLayer` (`../layers.ts`): no migration, no writer lease and
 * no lexical writer — the native index, the lexical index and the SQLite read session are opened in
 * this process read-only, so a running app is never locked out. It reads the vectors of the mode
 * the app embeds with (`embeddingModeFor` over the folder's settings), the mode `memory import`
 * embeds with too. The vector channel degrades (the `FindResult.degraded` contract) when that
 * mode's model file is missing; the text and morph channels degrade when the lexical index cannot
 * be opened.
 */
import { DatabaseSync } from "node:sqlite";
import { Effect, FileSystem, Layer, Option, Schema } from "effect";
import { nodePlatformLayer } from "../runtime/node-platform.ts";
import { SecureRandom } from "effect/crypto";
import { Database, DatabaseSchemaRejected, assertDatabaseSchema } from "../db/database.ts";
import { StorageRoot } from "../config/storage-root.ts";
import { Projects } from "../projects/projects.ts";
import { Interpretations } from "../memory/interpretations.ts";
import { Nodes } from "../memory/nodes.ts";
import { Graph } from "../memory/graph.ts";
import { MemorySearch, searchTuning, type SearchTuning } from "../memory/search.ts";
import {
  Embedder,
  EmbeddingError,
  EmbedderRuntime,
  embedderIdentity,
  embeddingModeFor,
} from "../memory/embedding/embedder.ts";
import type { EmbeddingMode } from "../memory/embedding/contracts.ts";
import { localModel, modelFile } from "../memory/embedding/models.ts";
import { Settings } from "../config/global-config.ts";
import { Reranker } from "../memory/rerank/reranker.ts";
import {
  VectorIndex,
  VectorIndexError,
  type VectorIndexApi,
} from "../memory/embedding/vector-index.ts";
import { lexicalLayout } from "../memory/embedding/native-vector-index.ts";
import { readCoverage } from "../memory/native-search/coverage.ts";
import { initializeNodeSqlite } from "../runtime/node-sqlite-bridge.ts";
import { requireRuntime } from "../runtime/resources.ts";
import { path } from "../runtime/synchronous-path.ts";
import { sha256 } from "../runtime/synchronous-crypto.ts";

/**
 * A native index file that cannot be opened is absent as far as the CLI is concerned: the channel
 * it feeds degrades instead of failing the read.
 */
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
const openedOrNull = <A>(open: () => A): A | null => {
  try {
    return open();
  } catch {
    return null;
  }
};

/** The failed open of a read-only assembly: the folder is missing or its files are unusable. */
export class StorageOpenFailed extends Schema.TaggedError<
  StorageOpenFailed,
  { readonly brand: unique symbol }
>()("StorageOpenFailed", {
  storage: Schema.String,
  cause: Schema.Defect(),
}) {}

/** The settings field that picks the embedding mode, decoded alone from `config.json`. */
const EmbeddingSettings = Schema.fromJsonString(
  Schema.Struct({ embeddingDevice: Settings.fields.embeddingDevice }),
);

/**
 * The mode the app embeds a storage folder with: `embeddingModeFor` over the folder's
 * `config.json`, a missing file being the defaults. The file is only read: `GlobalConfig.read`
 * would write an older file back.
 */
export const storageEmbeddingMode = Effect.fnUntraced(function* (storage: string) {
  const fs = yield* FileSystem.FileSystem;
  const json = yield* fs
    .readFileString(path.join(storage, "config.json"))
    .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed("{}")));
  return embeddingModeFor(yield* Schema.decodeEffect(EmbeddingSettings)(json));
});

/** The local embedding model's file for `mode` under a storage folder, read without a service. */
const localEmbeddingModelFile = (storage: string, mode: EmbeddingMode) =>
  path.join(storage, "models", localModel.id, modelFile(mode));

/** The vectors cache folder the app built for the local model's identity in `mode`. */
const vectorsDirectory = (storage: string, mode: EmbeddingMode) =>
  path.join(storage, "vectors", sha256(embedderIdentity(mode)).slice(0, 16));

/** The lexical index folder the app built for this lexical layout. */
export const lexicalDirectory = (storage: string) =>
  path.join(storage, "lexical", sha256(lexicalLayout).slice(0, 16));

/**
 * The CLI's read-only services over one storage folder, without migrating it.
 *
 * The database opens with `readOnly` and `query_only`, and a schema check fails closed on a
 * schema this build cannot read. The native vector index and SQLite read session are opened in
 * this process without the writer lease (the running app keeps writing), the lexical index is
 * opened only when it can be, and the vector channel degrades when the model file is missing.
 * `MemorySearch` keeps the app's measured tuning with the reranker off.
 */
/**
 * The CLI's read-only assembly over one storage folder.
 *
 * One options object keeps the call site a single argument, so there is no data-last form to
 * pipe: the layer is built once per command invocation.
 */
export function readOnlyMemoryLayer(options: {
  readonly storage: string;
  readonly tuning?: SearchTuning;
}) {
  const storage = options.storage;
  const tuning = options.tuning ?? searchTuning;
  return Layer.unwrap(
    Effect.gen(function* () {
      // A missing model degrades the vector channel instead of failing every read.
      const fs = yield* FileSystem.FileSystem;
      const mode = yield* storageEmbeddingMode(storage).pipe(
        Effect.mapError((cause) => StorageOpenFailed.make({ storage, cause })),
      );
      const modelFound = yield* fs.exists(localEmbeddingModelFile(storage, mode));
      const sqlite = yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            const opened = new DatabaseSync(path.join(storage, "agent.db"), { readOnly: true });
            opened.exec("PRAGMA query_only = ON");
            return opened;
          },
          catch: (cause) => StorageOpenFailed.make({ storage, cause }),
        }),
        (opened) => Effect.sync(() => opened.close()),
      );
      yield* Effect.try({
        try: () => assertDatabaseSchema(sqlite),
        catch: (cause) =>
          Schema.is(DatabaseSchemaRejected)(cause)
            ? cause
            : StorageOpenFailed.make({ storage, cause }),
      });
      const database = Database.over(Effect.succeed(sqlite));
      // Platform first (crypto/random/filesystem/path, no Terminal: the CLI never reads stdin),
      // then the read services over the read-only database, then MemorySearch with its degraded
      // embedder and in-process native reader.
      const foundation = Layer.mergeAll(nodePlatformLayer, StorageRoot.layer(storage));
      const readServices = Layer.mergeAll(
        Projects.layer,
        Nodes.layer,
        Graph.layer,
        Interpretations.layer,
      ).pipe(Layer.provide(database), Layer.provide(foundation));
      const search = MemorySearch.tuned(tuning).pipe(
        Layer.provide(Reranker.none),
        Layer.provide(embedderLayer(storage, mode, modelFound)),
        Layer.provide(readOnlyVectorIndex(sqlite, storage, mode)),
        Layer.provide(readServices),
        Layer.provide(database),
        Layer.provide(foundation),
      );
      // Every layer below is already closed over its own dependencies, so the parallel merge has
      // nothing left to satisfy between its members.
      // `database` is merged out as well: `import-status` reads the import cursors straight from
      // the read-only connection, with no lock and no writer.
      return Layer.mergeAll(foundation, database, readServices, Reranker.none, search);
    }),
  );
}

/**
 * The embedder of `mode` when its model file is there, run on the CPU (the app's gpu mode falls
 * back to the same file there, with the same vectors); a degraded embedder that cannot embed when
 * it is not. Both carry the mode's identity, so the coverage counts what the app has not embedded.
 */
const embedderLayer = (storage: string, mode: EmbeddingMode, modelFound: boolean) =>
  modelFound
    ? Embedder.localFile(mode).pipe(Layer.provide(StorageRoot.layer(storage)))
    : Layer.succeed(Embedder, {
        identity: embedderIdentity(mode),
        dimensions: localModel.dimensions,
        embed: () => Effect.fail(EmbeddingError.make({ cause: "disabled" })),
        runtime: () => EmbedderRuntime.other(),
      });

/**
 * Reads the app's vector cache and lexical index in this process, without the writer lease.
 * `VectorIndex.load` never writes, `LexicalIndex.openReadOnly` takes no writer lock, and
 * `MemoryReadSession` opens its own read-only connection; the app's owner keeps its lease and its
 * writer lock. A lexical index that cannot be opened leaves the text and morph channels off and
 * says so as `textUnavailable`; a missing or unloadable index file leaves the vector channel empty
 * instead of failing the read.
 */
const readOnlyVectorIndex = (sqlite: DatabaseSync, storage: string, mode: EmbeddingMode) =>
  Effect.gen(function* () {
    const addon = yield* Effect.try({
      try: () => requireRuntime("turbovec").pipe(Effect.runSync),
      catch: (cause) => StorageOpenFailed.make({ storage, cause }),
    });
    const opened = yield* Effect.try({
      try: () => {
        const binding = addon.loadTurbovec();
        initializeNodeSqlite(addon.addonPath);
        return binding;
      },
      catch: (cause) => StorageOpenFailed.make({ storage, cause }),
    });
    // An index file the CLI cannot load leaves the vector channel empty: an empty in-memory index
    // answers reads with no candidates instead of failing every read.
    const loaded = openedOrNull(() =>
      opened.VectorIndex.load(path.join(vectorsDirectory(storage, mode), "index.tvim")),
    );
    const index = loaded ?? new opened.VectorIndex(localModel.dimensions, 4);
    const lexical = Option.fromNullishOr(
      openedOrNull(() => opened.LexicalIndex.openReadOnly(lexicalDirectory(storage))),
    );
    const session = yield* Effect.try({
      try: () => new opened.MemoryReadSession(path.join(storage, "agent.db")),
      catch: (cause) => StorageOpenFailed.make({ storage, cause }),
    });
    const owner = SecureRandom.uuidV4Unsafe();
    /**
     * Text or morph matching was asked for, but no lexical index is open to answer it: the read
     * reports the text channel unavailable, so `FindResult.degraded` names it.
     */
    const lexicalMissing = (input: {
      readonly textEnabled: boolean;
      readonly morphEnabled: boolean;
    }) => Option.isNone(lexical) && (input.textEnabled || input.morphEnabled);
    const api: VectorIndexApi = {
      backend: {
        kind: "native",
        read: (input) =>
          Effect.flatMap(
            Effect.try({
              try: () => {
                // The native read refuses a text or morph channel without a lexical index, so a
                // CLI that could not open one asks for the vector channel alone.
                const asked = Option.isSome(lexical)
                  ? input
                  : { ...input, textEnabled: false, morphEnabled: false };
                const requestId = SecureRandom.uuidV4Unsafe();
                const control = new opened.SearchControl(
                  SecureRandom.uuidV4Unsafe(),
                  owner,
                  "read-only",
                  requestId,
                  input.remainingMs,
                );
                try {
                  const result = session.search(
                    index,
                    Option.getOrNull(lexical),
                    asked,
                    control.token(),
                    owner,
                    "read-only",
                    requestId,
                  );
                  return { result, control };
                } catch (error) {
                  control.close();
                  throw error;
                }
              },
              catch: (cause) => VectorIndexError.make({ operation: "search", cause }),
            }),
            ({ result, control }) =>
              // The worker counts coverage on its own read-only connection after the read.
              result.kind === "success"
                ? readCoverage(sqlite, input.embedder, input.allowedProjects, input.coverage).pipe(
                    Effect.map((coverage) => {
                      control.close();
                      return {
                        publication: { epoch: "read-only", generation: 0 },
                        result: {
                          ...result,
                          textUnavailable: result.textUnavailable || lexicalMissing(input),
                          unindexed: coverage.unindexed,
                          lexicalPending: coverage.lexicalPending,
                          uninterpreted: coverage.uninterpreted,
                          coverageMs: 0,
                        },
                      } as const;
                    }),
                    Effect.catch(() =>
                      Effect.sync(() => {
                        control.close();
                        return {
                          publication: { epoch: "read-only", generation: 0 },
                          result: {
                            ...result,
                            textUnavailable: result.textUnavailable || lexicalMissing(input),
                            unindexed: 0,
                            lexicalPending: 0,
                            uninterpreted: 0,
                            coverageMs: 0,
                          },
                        } as const;
                      }),
                    ),
                  )
                : Effect.sync(() => {
                    control.close();
                    return {
                      publication: { epoch: "read-only", generation: 0 },
                      result: {
                        ...result,
                        unindexed: 0,
                        lexicalPending: 0,
                        uninterpreted: 0,
                        coverageMs: 0,
                      },
                    } as const;
                  }),
          ),
      },
      // Write paths the read-only CLI never calls; a call would be a defect, not a write.
      size: () => 0,
      applyLexical: () =>
        Effect.fail(VectorIndexError.make({ operation: "lexical", cause: "read-only" })),
      flushRemovals: Effect.fail(VectorIndexError.make({ operation: "save", cause: "read-only" })),
      add: () => Effect.fail(VectorIndexError.make({ operation: "add", cause: "read-only" })),
      remove: () => Effect.fail(VectorIndexError.make({ operation: "remove", cause: "read-only" })),
      save: Effect.fail(VectorIndexError.make({ operation: "save", cause: "read-only" })),
      search: () => Effect.fail(VectorIndexError.make({ operation: "search", cause: "read-only" })),
      // SAFETY: `publish` belongs to the writing side of the index, which this read-only
      // assembly never reaches; its overloads cannot be expressed as a failing stub, so the
      // failure stands in for a call that would itself be a defect.
      publish: (() =>
        Effect.fail(VectorIndexError.make({ operation: "save", cause: "read-only" }))) as never,
    };
    return Layer.succeed(VectorIndex, api);
  }).pipe(Layer.unwrap);
