import { runNativeEffect } from "../src/runtime/native-effect.ts";
import { isTruthy } from "../src/truthy.ts";
// Recall evaluation with the real embedding model and the lexical index, on two sets: Korean
// decisions (recall-corpus.ts) and what coding sessions leave behind (recall-technical.ts).
// The model must already be under ~/.context-generactive-agent/models (the app downloads it).
//   vp run eval:recall                     all configurations, both sets
//   vp run eval:recall "trigram + morph"   one configuration
//   --models-root <dir>                    read the models from <dir>/models instead (a copy)
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { NodeServices } from "@effect/platform-node";
import { Context, FileSystem } from "effect";
import { nodePlatform } from "../src/runtime/node-platform.ts";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { path } from "../src/runtime/synchronous-path.ts";
const { join } = path;
import { Clock, Console, Duration, Effect, Layer, MutableHashMap, Option, Schema } from "effect";
import { SecretStore } from "../src/config/secrets.ts";
import { StorageRoot, defaultStorageRoot } from "../src/config/storage-root.ts";
import { memoryAgentLayer } from "../src/layers.ts";
import { EmbedderRuntime, Embedder, EmbeddingError } from "../src/memory/embedding/embedder.ts";
import { localModel, modelFile } from "../src/memory/embedding/models.ts";
import { Indexer } from "../src/memory/embedding/indexer.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { MemorySearch, searchTuning, type SearchTuning } from "../src/memory/search.ts";
import { Projects } from "../src/projects/projects.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import {
  recallQueries,
  recallSessions,
  type RecallQuery,
  type RecallStatement,
} from "./recall-corpus.ts";
import { technicalQueries, technicalSessions } from "./recall-technical.ts";

const modelsRootAt = process.argv.indexOf("--models-root");
const modelsRoot = modelsRootAt === -1 ? undefined : process.argv.splice(modelsRootAt, 2)[1];
const tuningAt = process.argv.indexOf("--tuning");
const TuningOverride = Schema.Struct({
  vectorCut: Schema.optional(Schema.Finite),
  vectorWeight: Schema.optional(Schema.Finite),
  textWeight: Schema.optional(Schema.Finite),
  morphWeight: Schema.optional(Schema.Finite),
  exactTextWeight: Schema.optional(Schema.Finite),
  otherProjectMerge: Schema.optional(Schema.Literals(["alternate", "append"])),
});
// The evaluation's tuning override exists only when --tuning was given
// (exactOptionalPropertyTypes), so the value is built whole from the app defaults.
const tuning: SearchTuning | undefined =
  tuningAt === -1
    ? undefined
    : {
        ...searchTuning,
        ...Object.fromEntries(
          Object.entries(
            await Effect.runPromise(
              Schema.decodeEffect(Schema.fromJsonString(TuningOverride))(
                process.argv.splice(tuningAt, 2)[1] ?? "{}",
              ),
            ),
          ).filter(([, value]) => value !== undefined),
        ),
      };
const home = modelsRoot ?? (await Effect.runPromise(defaultStorageRoot));
const embeddingModel = join(home, "models", localModel.id, modelFile("cpu"));
const modelFound = await nodePlatform.runPromise(
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.exists(embeddingModel)),
);
if (!modelFound) throw new Error(`model missing: ${embeddingModel}`);

const sharedModels = StorageRoot.layer(home);
const embedder = Embedder.localFile("gpu").pipe(Layer.provide(sharedModels));
const quantized = Embedder.localFile("cpu").pipe(Layer.provide(sharedModels));
const noEmbedder = Layer.succeed(Embedder, {
  identity: "none",
  dimensions: localModel.dimensions,
  embed: () => Effect.fail(EmbeddingError.make({ cause: "disabled" })),
  runtime: () => EmbedderRuntime.other(),
});

interface Configuration {
  readonly name: string;
  readonly embedder: Layer.Layer<Embedder>;
  /** Trigram and short substring ranking; "trigram" in the name. */
  readonly text: boolean;
  /** Morph term ranking; "morph" in the name. */
  readonly morph: boolean;
}

const configurations: readonly Configuration[] = [
  { name: "vector + trigram", embedder, text: true, morph: false },
  { name: "vector + trigram + morph", embedder, text: true, morph: true },
  { name: "vector", embedder, text: false, morph: false },
  { name: "vector + morph", embedder, text: false, morph: true },
  { name: "vector(cpu file) + trigram", embedder: quantized, text: true, morph: false },
  { name: "vector(cpu file) + trigram + morph", embedder: quantized, text: true, morph: true },
  { name: "vector(cpu file) + morph", embedder: quantized, text: false, morph: true },
  { name: "trigram", embedder: noEmbedder, text: true, morph: false },
  { name: "trigram + morph", embedder: noEmbedder, text: true, morph: true },
  { name: "morph", embedder: noEmbedder, text: false, morph: true },
];

interface RecallSet {
  readonly name: string;
  readonly sessions: readonly (readonly RecallStatement[])[];
  readonly queries: readonly RecallQuery[];
}

const recallSets: readonly RecallSet[] = [
  { name: "decisions", sessions: recallSessions, queries: recallQueries },
  { name: "technical", sessions: technicalSessions, queries: technicalQueries },
];

// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
const evaluate = Effect.fn("eval.evaluate")(function* (
  configuration: Configuration,
  set: RecallSet,
) {
  const platform = yield* Layer.build(NodeServices.layer);
  const fs = Context.get(platform, FileSystem.FileSystem);
  const base = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "memory-agent-recall-" }),
  );
  const projectRoot = join(base, "project");
  yield* fs.makeDirectory(projectRoot);
  const servicesContext = yield* Layer.build(
    memoryAgentLayer(join(base, "storage"), {
      embedder: configuration.embedder,
      interpretAutomatically: false,
      secrets: SecretStore.memory,
      skillsHome: join(base, "home"),
      searchTuning: { ...tuning, text: configuration.text, morph: configuration.morph },
    }),
  );
  return yield* Effect.provideContext(
    Effect.gen(function* () {
      const project = yield* (yield* Projects).add(projectRoot);
      const nodes = yield* Nodes;
      // Each recorded node, by the key of the statement it holds.
      const recorded = yield* Effect.forEach(
        set.sessions,
        Effect.fnUntraced(function* (statements) {
          const session = yield* (yield* Sessions).create(project.id);
          return yield* Effect.forEach(statements, (statement) =>
            Effect.map(
              nodes.append({
                projectId: project.id,
                sessionId: session.id,
                kind: statement.kind ?? "user",
                text: statement.text,
              }),
              (node) => [node.id, statement.key] as const,
            ),
          );
        }),
      );
      const keys = MutableHashMap.fromIterable(recorded.flat());
      const indexer = yield* Indexer;
      const [indexed] = yield* Effect.timed(
        Effect.ignore(indexer.lexicalAll()).pipe(Effect.andThen(Effect.ignore(indexer.indexAll()))),
      );
      const indexedMs = Math.round(Duration.toMillis(indexed));
      const search = yield* MemorySearch;

      const searchStarted = yield* Clock.currentTimeNanos;
      // Where each query's expected statement ranked; -1 when it was not found.
      const ranked = yield* Effect.forEach(
        set.queries,
        Effect.fnUntraced(function* (item) {
          const result = yield* search.find({
            query: item.query,
            projectId: project.id,
            limit: 10,
          });
          const found = result.matches.map((match) =>
            Option.getOrUndefined(MutableHashMap.get(keys, match.id)),
          );
          return { item, found, rank: found.indexOf(item.expected), degraded: result.degraded };
        }),
      );
      const ranks = ranked.map(({ rank }) => rank);
      const within = (limit: number) => ranks.filter((rank) => rank >= 0 && rank < limit).length;
      const top1 = within(1);
      const top3 = within(3);
      const top5 = within(5);
      const reciprocal = ranks
        .filter((rank) => rank >= 0)
        .reduce((sum, rank) => sum + 1 / (rank + 1), 0);
      const misses = ranked
        .filter(({ rank }) => rank !== 0)
        .map(
          ({ item, found, rank, degraded }) =>
            `${item.query} → ${rank < 0 ? "없음" : `${rank + 1}위`} (1위 ${found[0] ?? "-"}, degraded ${degraded.join(",") || "-"})`,
        );
      const total = set.queries.length;
      return {
        name: `${set.name} · ${configuration.name}`,
        top1: `${top1}/${total}`,
        top3: `${top3}/${total}`,
        top5: `${top5}/${total}`,
        mrr: (reciprocal / total).toFixed(3),
        indexedMs,
        searchMs: Math.round(
          Duration.toMillis(Duration.nanos((yield* Clock.currentTimeNanos) - searchStarted)) /
            total,
        ),
        misses,
      };
    }),
    servicesContext,
  );
}, Effect.scoped);

/** Every configuration on both sets, or only the configuration `only` names. */
const printRecall = (only: string | undefined) =>
  Effect.forEach(
    recallSets.flatMap((set) =>
      configurations
        .filter((configuration) => !isTruthy(only) || configuration.name === only)
        .map((configuration) => ({ set, configuration })),
    ),
    ({ set, configuration }) =>
      Effect.flatMap(evaluate(configuration, set), (result) =>
        // Native stdout/stderr or SDK logging boundary preserves the existing output format.
        Console.log(
          [
            `## ${result.name}: top1 ${result.top1}, top3 ${result.top3}, top5 ${result.top5}, MRR ${result.mrr} (index ${result.indexedMs} ms, ${result.searchMs} ms/query)`,
            ...result.misses.map((miss) => `  - ${miss}`),
          ].join("\n"),
        ),
      ),
    { discard: true },
  );

// The configuration name is the first argument that is not a flag or a flag's value.
const arguments_ = process.argv.slice(2);
const only = arguments_.find(
  (argument, index) =>
    !argument.startsWith("--") &&
    arguments_[index - 1] !== "--models-root" &&
    arguments_[index - 1] !== "--tuning",
);
await runNativeEffect(printRecall(only));
