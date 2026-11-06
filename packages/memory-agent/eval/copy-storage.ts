/**
 * The app's memory services over a copy of a real storage folder (agent.db, vectors/ and models/
 * like ~/.context-generactive-agent), opened as the app opens its own: MemorySearch with the local
 * embedder and the lexical index. Evaluations run searches on it; nothing they print holds memory
 * text.
 */
import { DatabaseSync } from "node:sqlite";
import { NodeFileSystem } from "@effect/platform-node";
import {
  Array as Arr,
  Console,
  Effect,
  FileSystem,
  Layer,
  MutableHashMap,
  Option,
  Result,
  Schema,
} from "effect";
import { Base64 } from "effect/encoding";
import { SqlClient, SqlSchema } from "effect/sql";
import { SecretStore } from "../src/config/secrets.ts";
import { StorageRoot } from "../src/config/storage-root.ts";
import { Database } from "../src/db/database.ts";
import { Embedder, EmbedderRuntime, identityMode } from "../src/memory/embedding/embedder.ts";
import { Indexer } from "../src/memory/embedding/indexer.ts";
import type { EmbeddingRole } from "../src/memory/embedding/models.ts";
import { memoryAgentLayer, type MemoryAgentLayerOptions } from "../src/layers.ts";
import type { SearchTuning } from "../src/memory/search.ts";
import { path } from "../src/runtime/synchronous-path.ts";

/** The copy's agent.db as the `SqlClient`, opened read-only: reading it never changes the copy. */
export const copyDatabase = (storage: string) =>
  Database.over(
    Effect.acquireRelease(
      Effect.try(() => new DatabaseSync(path.join(storage, "agent.db"), { readOnly: true })),
      (sqlite) => Effect.sync(() => sqlite.close()),
    ),
  );

// Query embeddings reused across runs, keyed by the embedder and the exact query text; the file
// lives in the copy. A torn final line from an interrupted append fails to decode and is skipped,
// and so is a line from before the embedder was recorded.
const CachedLine = Schema.Struct({
  embedder: Schema.String,
  text: Schema.String,
  vector: Schema.String,
});
const cacheLine = Schema.fromJsonString(CachedLine);

/** A cached vector, when it decodes to the embedder's size. */
const vectorOf = (encoded: string, bytes: number) =>
  Option.map(
    Option.filter(Result.getSuccess(Base64.decode(encoded)), (decoded) => decoded.length === bytes),
    // A copy starts at offset 0, as a Float32Array view needs.
    (decoded) => new Float32Array(decoded.slice().buffer),
  );

const encodedOf = (vector: Float32Array) =>
  Base64.encode(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength));

/** The cached embeddings of `embedder` in a copy, by text; lines that do not decode are skipped. */
const loadEmbedCache = Effect.fn("copyStorage.loadEmbedCache")(function* (
  file: string,
  embedder: string,
  bytes: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(file).pipe(
    // First run: no cache yet.
    Effect.orElseSucceed(() => ""),
  );
  const decode = Schema.decodeUnknownOption(cacheLine);
  return MutableHashMap.fromIterable(
    text.split("\n").flatMap((line) =>
      Option.toArray(
        Option.flatMap(
          Option.filter(decode(line), (cached) => cached.embedder === embedder),
          ({ text, vector }) =>
            Option.map(vectorOf(vector, bytes), (decoded) => [text, decoded] as const),
        ),
      ),
    ),
  );
});

/**
 * The app's embedder for `identity`, as a non-local runtime: the app then starts no background
 * backfill or GPU check, which would write to the copy and, failing there, block searches.
 * Query embeddings are cached in the copy, keyed by the exact text, so repeated runs skip the
 * model; a search embeds nothing else, and other roles go to the model.
 */
const cachedEmbedder = Effect.fn("copyStorage.cachedEmbedder")(function* (
  cacheFile: string,
  identity: string,
) {
  const embedder = yield* Embedder;
  const fs = yield* FileSystem.FileSystem;
  if (embedder.identity !== identity)
    return yield* Effect.die(`embedder ${embedder.identity} does not match the copy`);
  const cache = yield* loadEmbedCache(cacheFile, identity, embedder.dimensions * 4);
  const encodeLine = Schema.encodeEffect(cacheLine);
  /** Embeds the texts not cached yet and appends them to the cache file. */
  const fill = (missing: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const computed = yield* embedder.embed(missing, "query");
      const lines = yield* Effect.forEach(missing, (text, index) =>
        encodeLine({ embedder: identity, text, vector: encodedOf(computed[index]!) }),
      );
      // The cache is the copy's; failing to write it is the run's failure.
      yield* Effect.orDie(
        fs.writeFileString(cacheFile, lines.map((line) => `${line}\n`).join(""), { flag: "a" }),
      );
      missing.forEach((text, index) => MutableHashMap.set(cache, text, computed[index]!));
    });
  return {
    ...embedder,
    runtime: () => EmbedderRuntime.other(),
    embed: (texts: ReadonlyArray<string>, role: EmbeddingRole) =>
      role !== "query"
        ? embedder.embed(texts, role)
        : Effect.gen(function* () {
            const missing = Arr.dedupe(texts.filter((text) => !MutableHashMap.has(cache, text)));
            yield* Effect.when(
              Effect.orDie(fill(missing)),
              Effect.succeed(Arr.isReadonlyArrayNonEmpty(missing)),
            );
            // Every text is cached now.
            return texts.map((text) => Option.getOrThrow(MutableHashMap.get(cache, text)));
          }),
  };
});

const EmbedderVectors = Schema.Struct({ embedder: Schema.String, n: Schema.Finite });

/**
 * The model file the copy's vectors were made with: of the embedders the local model is, the one
 * holding the most vectors. Vectors of an earlier model may stay in the copy; searches skip them.
 */
export const copyEmbedder = (storage: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const embedders = yield* SqlSchema.findAll({
      Request: Schema.Void,
      Result: EmbedderVectors,
      execute: () =>
        sql`SELECT embedder, count(*) AS n FROM node_vectors GROUP BY embedder ORDER BY n DESC`,
    })(undefined).pipe(Effect.orDie);
    const [top, mode] = yield* Option.match(
      Arr.findFirst(embedders, (row) =>
        Option.map(identityMode(row.embedder), (mode) => [row, mode] as const),
      ),
      {
        // A copy without the local model's vectors cannot be searched by meaning.
        onNone: () => Effect.die("the copy holds no vectors of the local model"),
        onSome: Effect.succeed,
      },
    );
    yield* Console.log(`embedder ${top.embedder} (${top.n} vectors) -> ${mode}`);
    return Layer.effect(
      Embedder,
      cachedEmbedder(path.join(storage, "embed-cache.jsonl"), top.embedder),
    ).pipe(
      Layer.provide([Embedder.localFile(mode), NodeFileSystem.layer]),
      Layer.provide(StorageRoot.layer(storage)),
    );
  }).pipe(
    Layer.unwrap,
    Layer.provide(copyDatabase(storage)),
    // A copy whose database cannot be read cannot be searched at all.
    Layer.orDie,
  );

export interface CopyServices {
  readonly storage: string;
  /** Replaces the app's search tuning when given. */
  readonly tuning: Option.Option<SearchTuning>;
}

/**
 * Applies every journaled node change to the copy's lexical index before the first search: a
 * change still pending drops its node from the text and morph lists. The first run on a copy
 * builds the whole index; later runs apply only what changed.
 */
const lexicalCaughtUp = Layer.effectDiscard(
  Effect.gen(function* () {
    const applied = yield* Effect.flatMap(Indexer, (indexer) => indexer.lexicalAll()).pipe(
      // A copy whose lexical index cannot be built cannot be searched as the app searches.
      Effect.orDie,
    );
    yield* Console.log(`lexical changes applied ${applied}`);
  }),
);

/** The app's services over the copy, with the copy's embedder and no background work. */
export const copyLayer = ({ storage, tuning }: CopyServices) =>
  Effect.gen(function* () {
    // Inside the copy: the sandbox may refuse the system temp folder.
    const home = path.join(storage, "eval-home");
    yield* (yield* FileSystem.FileSystem).makeDirectory(home, { recursive: true });
    const options: MemoryAgentLayerOptions = {
      embedder: copyEmbedder(storage),
      interpretAutomatically: false,
      summarizeAutomatically: false,
      importsWatching: false,
      importsHome: home,
      sweepSecrets: false,
      secrets: SecretStore.memory,
      skillsHome: home,
    };
    // The tuning override is only present when given (exactOptionalPropertyTypes).
    return Layer.provideMerge(
      lexicalCaughtUp,
      Layer.merge(
        memoryAgentLayer(
          storage,
          Option.match(tuning, {
            onNone: () => options,
            onSome: (searchTuning) => ({ ...options, searchTuning }),
          }),
        ),
        NodeFileSystem.layer,
      ),
    );
  }).pipe(Layer.unwrap);
