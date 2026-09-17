// Recall evaluation with the real embedding model and Kiwi, on two sets: Korean decisions
// (recall-corpus.ts) and what coding sessions leave behind (recall-technical.ts).
// Both models must already be under ~/.context-generactive-agent/models (the app downloads them).
//   vp run eval:recall                    all configurations, both sets
//   vp run eval:recall "trigram + kiwi"   one configuration
//   vp run eval:recall --terms            Kiwi terms of the decision corpus and queries
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SecretStore } from "../src/config/secrets.ts";
import { StorageRoot } from "../src/config/storage-root.ts";
import { memoryAgentLayer } from "../src/layers.ts";
import {
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

const home = join(homedir(), ".context-generactive-agent");
const embeddingModel = join(home, "models", localModel.id, modelFile("quint8"));
const kiwiFile = join(home, "models", `kiwi-${kiwiModel.version}`, kiwiModel.directory, "cong.mdl");
for (const file of [embeddingModel, kiwiFile])
  if (!existsSync(file)) throw new Error(`model missing: ${file}`);

const sharedModels = StorageRoot.layer(home);
const embedder = Embedder.localVariant("fp32").pipe(Layer.provide(sharedModels));
const quantized = Embedder.localVariant("quint8").pipe(Layer.provide(sharedModels));
const kiwi = MorphAnalyzer.kiwi.pipe(Layer.provide(sharedModels));
const noEmbedder = Layer.succeed(Embedder, {
  identity: "none",
  dimensions: 384,
  embed: () => Effect.fail(new EmbeddingError({ cause: "disabled" })),
  runtime: () => ({ kind: "other" }),
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

async function evaluate(configuration: Configuration, set: RecallSet) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "memory-agent-recall-")));
  const projectRoot = join(base, "project");
  mkdirSync(projectRoot);
  const runtime = ManagedRuntime.make(
    memoryAgentLayer(join(base, "storage"), {
      embedder: configuration.embedder,
      morphAnalyzer: configuration.morph,
      interpretAutomatically: false,
      secrets: SecretStore.memory,
      skillsHome: join(base, "home"),
    }),
  );
  try {
    return await runtime.runPromise(
      Effect.gen(function* () {
        const project = yield* (yield* Projects).add(projectRoot);
        const nodes = yield* Nodes;
        const keys = new Map<string, string>();
        for (const statements of set.sessions) {
          const session = yield* (yield* Sessions).create(project.id);
          for (const statement of statements) {
            const node = nodes.append({
              projectId: project.id,
              sessionId: session.id,
              kind: statement.kind ?? "user",
              text: statement.text,
            });
            keys.set(node.id, statement.key);
          }
        }
        const indexer = yield* Indexer;
        const started = performance.now();
        yield* Effect.ignore(indexer.indexAll());
        yield* Effect.ignore(indexer.analyzeAll());
        const indexedMs = Math.round(performance.now() - started);
        const search = yield* configuration.text
          ? MemorySearch
          : Effect.provide(MemorySearch, MemorySearch.tuned({ text: false }));

        let top1 = 0;
        let top3 = 0;
        let top5 = 0;
        let reciprocal = 0;
        const misses: string[] = [];
        const searchStarted = performance.now();
        for (const item of set.queries) {
          const result = yield* search.find({
            query: item.query,
            projectId: project.id,
            limit: 10,
          });
          const found = result.matches.map((match) => keys.get(match.id));
          const rank = found.indexOf(item.expected);
          if (rank === 0) top1++;
          if (rank >= 0 && rank < 3) top3++;
          if (rank >= 0 && rank < 5) top5++;
          if (rank >= 0) reciprocal += 1 / (rank + 1);
          if (rank !== 0)
            misses.push(
              `${item.query} → ${rank < 0 ? "없음" : `${rank + 1}위`} (1위 ${found[0] ?? "-"}, degraded ${result.degraded.join(",") || "-"})`,
            );
        }
        const total = set.queries.length;
        return {
          name: `${set.name} · ${configuration.name}`,
          top1: `${top1}/${total}`,
          top3: `${top3}/${total}`,
          top5: `${top5}/${total}`,
          mrr: (reciprocal / total).toFixed(3),
          indexedMs,
          searchMs: Math.round((performance.now() - searchStarted) / total),
          misses,
        };
      }),
    );
  } finally {
    await runtime.dispose();
    rmSync(base, { recursive: true, force: true });
  }
}

const only = process.argv[2];
if (only === "--terms") {
  const texts = [
    ...recallQueries.map((item) => item.query),
    ...recallSessions.flat().map((statement) => statement.text),
  ];
  const terms = await Effect.runPromise(
    Effect.scoped(Effect.flatMap(MorphAnalyzer, (analyzer) => analyzer.terms(texts))).pipe(
      Effect.provide(kiwi),
    ),
  );
  texts.forEach((text, index) => console.log(`${text} | ${terms[index]?.join(" ")}`));
  process.exit(0);
}
for (const set of recallSets)
  for (const configuration of configurations) {
    if (only && configuration.name !== only) continue;
    const result = await evaluate(configuration, set);
    console.log(
      `## ${result.name}: top1 ${result.top1}, top3 ${result.top3}, top5 ${result.top5}, MRR ${result.mrr} (index ${result.indexedMs} ms, ${result.searchMs} ms/query)`,
    );
    for (const miss of result.misses) console.log(`  - ${miss}`);
  }
