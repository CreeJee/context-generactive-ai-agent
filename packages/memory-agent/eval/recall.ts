import { runNativeEffect } from "../src/runtime/native-effect.ts";
import { isTruthy } from "../src/truthy.ts";
// Recall evaluation with the real embedding model and Kiwi, on two sets: Korean decisions
// (recall-corpus.ts) and what coding sessions leave behind (recall-technical.ts).
// Both models must already be under ~/.context-generactive-agent/models (the app downloads them).
//   vp run eval:recall                    all configurations, both sets
//   vp run eval:recall "trigram + kiwi"   one configuration
//   vp run eval:recall --terms            Kiwi terms of the decision corpus and queries
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { NodeServices } from "@effect/platform-node";
import { Context, FileSystem } from "effect";
import { nodePlatform } from "../src/runtime/node-platform.ts";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { path } from "../src/runtime/synchronous-path.ts";
const { join } = path;
import { Clock, Console, Duration, Effect, Layer, MutableHashMap, Option } from "effect";
import { SecretStore } from "../src/config/secrets.ts";
import { StorageRoot, defaultStorageRoot } from "../src/config/storage-root.ts";
import { memoryAgentLayer } from "../src/layers.ts";
import {
  EmbedderRuntime,
  Embedder,
  EmbeddingError,
  localModel,
  modelFile,
} from "../src/memory/embedding/embedder.ts";
import { Indexer } from "../src/memory/embedding/indexer.ts";
import { MorphAnalyzer, kiwiModel } from "../src/memory/morph/analyzer.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { MemorySearch } from "../src/memory/search.ts";
import { Projects } from "../src/projects/projects.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import {
  recallQueries,
  recallSessions,
  type RecallQuery,
  type RecallStatement,
} from "./recall-corpus.ts";
import { technicalQueries, technicalSessions } from "./recall-technical.ts";

const home = await Effect.runPromise(defaultStorageRoot);
const embeddingModel = join(home, "models", localModel.id, modelFile("quint8"));
const kiwiFile = join(home, "models", `kiwi-${kiwiModel.version}`, kiwiModel.directory, "cong.mdl");
const missingModel = await nodePlatform.runPromise(
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    Effect.findFirst([embeddingModel, kiwiFile], (file) =>
      Effect.map(fs.exists(file), (exists) => !exists),
    ),
  ),
);
if (Option.isSome(missingModel)) throw new Error(`model missing: ${missingModel.value}`);

const sharedModels = StorageRoot.layer(home);
const embedder = Embedder.localVariant("fp32").pipe(Layer.provide(sharedModels));
const quantized = Embedder.localVariant("quint8").pipe(Layer.provide(sharedModels));
const kiwi = MorphAnalyzer.kiwi.pipe(Layer.provide(sharedModels));
const noEmbedder = Layer.succeed(Embedder, {
  identity: "none",
  dimensions: 384,
  embed: () => Effect.fail(EmbeddingError.make({ cause: "disabled" })),
  runtime: () => EmbedderRuntime.other(),
});

interface Configuration {
  readonly name: string;
  readonly embedder: Layer.Layer<Embedder>;
  readonly morph: Layer.Layer<MorphAnalyzer>;
  /** Trigram and short substring ranking; "trigram" in the name. */
  readonly text: boolean;
}

const configurations: readonly Configuration[] = [
  { name: "vector + trigram", embedder, morph: MorphAnalyzer.disabled, text: true },
  { name: "vector + trigram + kiwi", embedder, morph: kiwi, text: true },
  { name: "vector", embedder, morph: MorphAnalyzer.disabled, text: false },
  { name: "vector + kiwi", embedder, morph: kiwi, text: false },
  {
    name: "vector(quint8) + trigram",
    embedder: quantized,
    morph: MorphAnalyzer.disabled,
    text: true,
  },
  { name: "vector(quint8) + trigram + kiwi", embedder: quantized, morph: kiwi, text: true },
  { name: "vector(quint8) + kiwi", embedder: quantized, morph: kiwi, text: false },
  { name: "trigram", embedder: noEmbedder, morph: MorphAnalyzer.disabled, text: true },
  { name: "trigram + kiwi", embedder: noEmbedder, morph: kiwi, text: true },
  { name: "kiwi", embedder: noEmbedder, morph: kiwi, text: false },
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
      morphAnalyzer: configuration.morph,
      interpretAutomatically: false,
      secrets: SecretStore.memory,
      skillsHome: join(base, "home"),
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
        Effect.ignore(indexer.indexAll()).pipe(Effect.andThen(Effect.ignore(indexer.analyzeAll()))),
      );
      const indexedMs = Math.round(Duration.toMillis(indexed));
      const search = yield* configuration.text
        ? MemorySearch
        : // Evaluation entry point owns this Layer and its resource scope.
          Effect.scoped(
            Effect.flatMap(Layer.build(MemorySearch.tuned({ text: false })), (services) =>
              Effect.provideContext(MemorySearch, services),
            ),
          );

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

/** Kiwi terms of the decision corpus and queries, one line each. */
const printTerms = Effect.gen(function* () {
  const texts = [
    ...recallQueries.map((item) => item.query),
    ...recallSessions.flat().map((statement) => statement.text),
  ];
  const services = yield* Layer.build(kiwi);
  const terms = yield* Effect.provideContext(
    Effect.flatMap(MorphAnalyzer, (analyzer) => analyzer.terms(texts)),
    services,
  );
  // Native stdout/stderr or SDK logging boundary preserves the existing output format.
  yield* Console.log(texts.map((text, index) => `${text} | ${terms[index]?.join(" ")}`).join("\n"));
}).pipe(Effect.scoped);

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

const only = process.argv[2];
if (only === "--terms") {
  await runNativeEffect(printTerms);
  process.exit(0);
}
await runNativeEffect(printRecall(only));
