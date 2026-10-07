// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { join } from "node:path";
import {
  Console,
  Array as EffectArray,
  Effect,
  Layer,
  Schema,
  MutableHashMap,
  Option,
} from "effect";
import { memoryAgentLayer } from "../src/layers.ts";
import { SecretStore } from "../src/config/secrets.ts";
import { StorageRoot } from "../src/config/storage-root.ts";
import {
  Embedder,
  EmbeddingError,
  localModel,
  modelFile,
  normalize,
} from "../src/memory/embedding/embedder.ts";
import { Indexer } from "../src/memory/embedding/indexer.ts";
import { MorphAnalyzer, kiwiModel } from "../src/memory/morph/analyzer.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { MemorySearch } from "../src/memory/search.ts";
import { Projects } from "../src/projects/projects.ts";
import { Sessions } from "../src/sessions/sessions.ts";

const Fixture = Schema.Struct({
  cases: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      project: Schema.String,
      priorEvidence: Schema.Array(
        Schema.Struct({ id: Schema.String, project: Schema.String, text: Schema.String }),
      ),
      recentTurns: Schema.Array(Schema.String),
    }),
  ),
});
export class ShadowSearchError extends Schema.TaggedError<ShadowSearchError>()(
  "ShadowSearchError",
  {
    stage: Schema.Literals(["fixture", "temporary-storage", "cleanup", "model-load"]),
  },
) {}
const io = <A>(stage: ShadowSearchError["stage"], run: () => A) =>
  Effect.try({ try: run, catch: () => ShadowSearchError.make({ stage }) });
const disabledEmbedding = Layer.succeed(Embedder, {
  identity: "none",
  dimensions: 384,
  runtime: () => ({ kind: "other" as const }),
  embed: () => Effect.fail(new EmbeddingError({ cause: "text-only baseline" })),
});

const EmbeddingOutput = Schema.Struct({
  last_hidden_state: Schema.Struct({
    dims: Schema.Tuple([Schema.Int, Schema.Int, Schema.Int]),
    data: Schema.instanceOf(Float32Array),
  }),
});

// Unlike the production worker, both loaders explicitly forbid remote model files.
const offlineEmbedding = (cacheDir: string) =>
  Layer.effect(
    Embedder,
    Effect.gen(function* () {
      const { AutoTokenizer, AutoModel } = yield* Effect.tryPromise({
        try: () => import("@huggingface/transformers"),
        catch: () => ShadowSearchError.make({ stage: "model-load" }),
      }).pipe(Effect.orDie);
      const options = { cache_dir: cacheDir, local_files_only: true };
      const tokenizer = yield* Effect.tryPromise({
        try: () => AutoTokenizer.from_pretrained(localModel.id, options),
        catch: () => ShadowSearchError.make({ stage: "model-load" }),
      }).pipe(Effect.orDie);
      const model = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            AutoModel.from_pretrained(localModel.id, {
              ...options,
              dtype: "fp32",
              device: "cpu",
              model_file_name: "model_quint8_avx2",
            }),
          catch: () => ShadowSearchError.make({ stage: "model-load" }),
        }).pipe(Effect.orDie),
        (loaded) =>
          Effect.tryPromise({
            try: () => loaded.dispose(),
            catch: () => ShadowSearchError.make({ stage: "cleanup" }),
          }).pipe(Effect.orDie),
      );
      return Embedder.of({
        identity: `${localModel.id}@quint8/cls/${localModel.maxTokens}`,
        dimensions: 384,
        runtime: () => ({ kind: "other" }),
        embed: (texts) =>
          Effect.gen(function* () {
            if (texts.length === 0) return [];
            const output = yield* Effect.tryPromise({
              try: () =>
                model(
                  tokenizer([...texts], {
                    padding: true,
                    truncation: true,
                    max_length: localModel.maxTokens,
                  }),
                ),
              catch: (cause) => new EmbeddingError({ cause }),
            });
            const { last_hidden_state: hidden } = yield* Schema.decodeUnknownEffect(
              EmbeddingOutput,
            )(output).pipe(Effect.mapError((cause) => new EmbeddingError({ cause })));
            const [, tokens, dimensions] = hidden.dims;
            return texts.map((_, row) =>
              normalize(
                Float32Array.from(
                  hidden.data.slice(
                    row * tokens * dimensions,
                    row * tokens * dimensions + dimensions,
                  ),
                ),
              ),
            );
          }),
      });
    }),
  );

/** Actual project-only retrieval; never reads fixture searchEvidenceIds or generates answers. */
export const evaluateRecallShadowSearch = Effect.fnUntraced(function* (
  options: { textOnly?: boolean } = {},
) {
  const fixture = yield* io("fixture", () =>
    JSON.parse(readFileSync(new URL("./recall-turns.fixture.json", import.meta.url), "utf8")),
  ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Fixture)));
  const base = yield* Effect.acquireRelease(
    io("temporary-storage", () => realpathSync(mkdtempSync(join(tmpdir(), "recall-shadow-")))),
    (path) =>
      io("cleanup", () => rmSync(path, { recursive: true, force: true })).pipe(Effect.orDie),
  );
  const cacheRoot = join(homedir(), ".context-generactive-agent");
  const cached =
    !(options.textOnly === true) &&
    [
      join(cacheRoot, "models", localModel.id, modelFile("quint8")),
      join(cacheRoot, "models", localModel.id, "tokenizer.json"),
      join(cacheRoot, "models", localModel.id, "tokenizer_config.json"),
      join(cacheRoot, "models", localModel.id, "config.json"),
      join(cacheRoot, "models", `kiwi-${kiwiModel.version}`, kiwiModel.directory, "cong.mdl"),
    ].every(existsSync);
  const layer = memoryAgentLayer(join(base, "storage"), {
    embedder: cached ? offlineEmbedding(join(cacheRoot, "models")) : disabledEmbedding,
    morphAnalyzer: cached
      ? MorphAnalyzer.kiwi.pipe(Layer.provide(StorageRoot.layer(cacheRoot)))
      : MorphAnalyzer.disabled,
    interpretAutomatically: false,
    summarizeAutomatically: false,
    secrets: SecretStore.memory,
    skillsHome: join(base, "home"),
    skillsBuiltin: join(base, "builtin"),
    importsHome: join(base, "home"),
    importsWatching: false,
    sweepSecrets: false,
  });
  return yield* Effect.gen(function* () {
    const projects = yield* Projects;
    const sessions = yield* Sessions;
    const nodes = yield* Nodes;
    const projectIds = MutableHashMap.empty<string, string>();
    const keys = MutableHashMap.empty<string, string>();
    for (const label of EffectArray.dedupe(
      fixture.cases.flatMap((item) => [
        item.project,
        ...item.priorEvidence.map((evidence) => evidence.project),
      ]),
    )) {
      const root = join(base, label);
      yield* io("temporary-storage", () => mkdirSync(root));
      MutableHashMap.set(projectIds, label, (yield* projects.add(root)).id);
    }
    for (const item of fixture.cases) {
      const sessionIds = MutableHashMap.empty<string, string>();
      for (const label of EffectArray.dedupe([
        item.project,
        ...item.priorEvidence.map((evidence) => evidence.project),
      ]))
        MutableHashMap.set(
          sessionIds,
          label,
          (yield* sessions.create(Option.getOrThrow(MutableHashMap.get(projectIds, label)))).id,
        );
      for (const evidence of item.priorEvidence) {
        const node = nodes.append({
          projectId: Option.getOrThrow(MutableHashMap.get(projectIds, evidence.project)),
          sessionId: Option.getOrThrow(MutableHashMap.get(sessionIds, evidence.project)),
          kind: "user",
          text: evidence.text,
        });
        MutableHashMap.set(keys, node.id, evidence.id);
      }
    }
    const indexer = yield* Indexer;
    const preparationStarted = performance.now();
    if (cached) {
      yield* indexer.indexAll();
      yield* indexer.analyzeAll();
    }
    const search = yield* MemorySearch;
    const cases = yield* Effect.forEach(
      fixture.cases,
      Effect.fnUntraced(function* (item) {
        const query = item.recentTurns.join("\n");
        const rankings = yield* Effect.forEach(
          [5, 10, 16],
          Effect.fnUntraced(function* (k) {
            const started = performance.now();
            const result = yield* search.find({
              query,
              projectId: Option.getOrThrow(MutableHashMap.get(projectIds, item.project)),
              crossProject: false,
              limit: k,
            });
            return {
              k,
              rankedEvidenceIds: result.matches.map((match) =>
                Option.getOrThrow(MutableHashMap.get(keys, match.id)),
              ),
              wrongProjectCount: result.matches.filter((match) => match.fromOtherProject).length,
              degraded: result.degraded,
              unindexed: result.unindexed,
              uninterpreted: result.uninterpreted,
              complete: result.complete,
              elapsedMs: performance.now() - started,
            };
          }),
        );
        return { id: item.id, project: item.project, query, rankings };
      }),
    );
    return {
      mode: cached ? "cached-real-embedding-and-kiwi" : "degraded-text-only-baseline",
      fullActivation: false,
      degradationReason: cached
        ? null
        : options.textOnly === true
          ? "explicit-text-only"
          : "cached-model-assets-unavailable",
      answerGeneration: "not-run",
      sourceCorrectness: "unknown",
      interpretation: "disabled",
      crossProject: false,
      preparationAndSearchMs: performance.now() - preparationStarted,
      cases,
    };
    // Evaluation entry point owns this Layer and its resource scope.
  }).pipe(
    Effect.fnUntraced(function* <A, E, R>(program: Effect.Effect<A, E, R>) {
      const services = yield* Layer.build(layer);
      return yield* Effect.provideContext(program, services);
    }, Effect.scoped),
  );
});

if (import.meta.main) {
  const result = await Effect.runPromise(
    Effect.scoped(evaluateRecallShadowSearch({ textOnly: process.argv.includes("--text-only") })),
  );
  // Native stdout/stderr or SDK logging boundary preserves the existing output format.
  Effect.runSync(Console.log(JSON.stringify(result, null, 2)));
}
