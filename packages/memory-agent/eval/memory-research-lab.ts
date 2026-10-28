// Memory search research lab: times each stage of the search pipeline separately so a recall or
// latency problem can be pinned to the stage that causes it. Mirrors eval/recall.ts's corpus,
// seeding and layer assembly; every stage runs in its own temporary storage root.
//   node --no-warnings eval/memory-research-lab.ts            all stages, both sets
//   node --no-warnings eval/memory-research-lab.ts fake-embed  one stage
// Stages:
//   fake-embed  deterministic hashed vectors + token terms + trigram → isolates the vector+fusion path
//   real-embed  the local model (quint8, else fp32) + token terms + trigram → model quality vs the fake baseline
//   fts-only    no embedder + token terms + trigram                  → the text channel alone
//   morph-only  no embedder + Kiwi                                   → the morpheme channel alone
//   full        the local model + Kiwi + trigram                     → the production configuration
// Model stages need the model files under the real storage root; where they are unreadable the
// stage is skipped with the reason instead of failing the whole run.
import {
  Array as Arr,
  Cause,
  Console,
  Context,
  Duration,
  Effect,
  FileSystem,
  Layer,
  MutableHashMap,
  MutableRef,
  Option,
} from "effect";
import { nodePlatform } from "../src/runtime/node-platform.ts";
import { fakeEmbedderLayer } from "../src/testing/fake-embedder.ts";
import { fakeMorphLayer } from "../src/testing/fake-morph.ts";
import { path } from "../src/runtime/synchronous-path.ts";
const { join } = path;
import { SecretStore } from "../src/config/secrets.ts";
import { StorageRoot, defaultStorageRoot } from "../src/config/storage-root.ts";
import { memoryAgentLayer } from "../src/layers.ts";
import {
  Embedder,
  EmbedderRuntime,
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

// The lab runs from packages/memory-agent like the other eval scripts.
const repoRoot = join(process.cwd(), "..", "..");
// Temp roots live under the repo's gitignored node_modules: restricted environments may deny
// the system tmpdir and the real storage root alike.
const tmpBase = join(repoRoot, "node_modules", ".vp-tmp");
const labPrefix = "memory-research-lab-";

const home = await Effect.runPromise(defaultStorageRoot);
const quint8File = join(home, "models", localModel.id, modelFile("quint8"));
const fp32File = join(home, "models", localModel.id, modelFile("fp32"));
const kiwiFile = join(home, "models", `kiwi-${kiwiModel.version}`, kiwiModel.directory, "cong.mdl");
const dimensions = localModel.dimensions;

/** Readable now, or the reason a model-dependent stage has to be skipped. */
const readable = (file: string): Promise<boolean> =>
  nodePlatform.runPromise(
    Effect.flatMap(FileSystem.FileSystem, (fs) => fs.stat(file)).pipe(
      Effect.map((info) => Number(info.size) > 0),
      Effect.orElseSucceed(() => false),
    ),
  );

const noEmbedder = Layer.succeed(Embedder, {
  identity: "none",
  dimensions,
  embed: () => Effect.fail(EmbeddingError.make({ cause: "disabled" })),
  runtime: () => EmbedderRuntime.other(),
});

/** Embedder wrapper plus the accumulated embed time it reports through. */
interface TimedEmbedder<E, R> {
  readonly layer: Layer.Layer<Embedder, E, R>;
  readonly nanos: MutableRef.MutableRef<bigint>;
}

/** Wraps an embedder so the lab can report how long embedding took, apart from search. */
const timedEmbedder = <E, R>(inner: Layer.Layer<Embedder, E, R>): TimedEmbedder<E, R> => {
  const nanos = MutableRef.make(0n);
  return {
    nanos,
    layer: inner.pipe(
      Layer.flatMap((context) =>
        Layer.succeed(Embedder, {
          ...Context.get(context, Embedder),
          embed: (texts: readonly string[]) => {
            const startedAt = process.hrtime.bigint();
            return Context.get(context, Embedder)
              .embed(texts)
              .pipe(
                Effect.map((vectors) => {
                  MutableRef.update(nanos, (total) => total + process.hrtime.bigint() - startedAt);
                  return vectors;
                }),
              );
          },
        }),
      ),
    ),
  };
};

interface Stage {
  readonly name: string;
  readonly detail: string;
  readonly embedder: Layer.Layer<Embedder, never, StorageRoot>;
  readonly morph: Layer.Layer<MorphAnalyzer, never, StorageRoot>;
  /** Trigram and short substring ranking on top of the channels above. */
  readonly text: boolean;
  readonly embedNanos: MutableRef.MutableRef<bigint>;
}

const embedVariant = (await readable(quint8File))
  ? ("quint8" as const)
  : (await readable(fp32File))
    ? ("fp32" as const)
    : null;
const kiwiAvailable = await readable(kiwiFile);

const stages: readonly Stage[] = [
  {
    name: "fake-embed",
    detail: "레포의 가짜 임베더(문자 trigram SHA-256) + 가짜 형태소 + trigram",
    ...(() => {
      const timed = timedEmbedder(fakeEmbedderLayer);
      return { embedder: timed.layer, embedNanos: timed.nanos };
    })(),
    morph: fakeMorphLayer,
    text: true,
  },
  ...(embedVariant !== null
    ? [
        {
          name: "real-embed",
          detail: `로컬 모델(${embedVariant}) + 가짜 형태소 + trigram`,
          ...(() => {
            const timed = timedEmbedder(Embedder.localVariant(embedVariant));
            return { embedder: timed.layer, embedNanos: timed.nanos };
          })(),
          morph: fakeMorphLayer,
          text: true,
        } satisfies Stage,
      ]
    : []),
  {
    name: "fts-only",
    detail: "임베더 없음 + 가짜 형태소 + trigram",
    embedder: noEmbedder,
    morph: fakeMorphLayer,
    text: true,
    embedNanos: MutableRef.make(0n),
  },
  ...(kiwiAvailable
    ? [
        {
          name: "morph-only",
          detail: "임베더 없음 + Kiwi 형태소",
          embedder: noEmbedder,
          morph: MorphAnalyzer.kiwi,
          text: false,
          embedNanos: MutableRef.make(0n),
        } satisfies Stage,
      ]
    : []),
  ...(embedVariant !== null && kiwiAvailable
    ? [
        {
          name: "full",
          detail: `로컬 모델(${embedVariant}) + Kiwi + trigram`,
          ...(() => {
            const timed = timedEmbedder(Embedder.localVariant(embedVariant));
            return { embedder: timed.layer, embedNanos: timed.nanos };
          })(),
          morph: MorphAnalyzer.kiwi,
          text: true,
        } satisfies Stage,
      ]
    : []),
];

const skipped: readonly { readonly name: string; readonly reason: string }[] = [
  ...(embedVariant !== null
    ? []
    : [
        {
          name: "real-embed / full",
          reason: `로컬 임베딩 모델 파일을 읽을 수 없음 (${quint8File})`,
        },
      ]),
  ...(kiwiAvailable
    ? []
    : [
        {
          name: "morph-only / full",
          reason: `Kiwi 모델 파일을 읽을 수 없음 (${kiwiFile})`,
        },
      ]),
];

interface RecallSet {
  readonly name: string;
  readonly sessions: readonly (readonly RecallStatement[])[];
  readonly queries: readonly RecallQuery[];
}

const sets: readonly RecallSet[] = [
  { name: "decisions", sessions: recallSessions, queries: recallQueries },
  { name: "technical", sessions: technicalSessions, queries: technicalQueries },
];

interface SetMetrics {
  readonly name: string;
  readonly total: number;
  readonly top1: number;
  readonly top3: number;
  readonly top5: number;
  readonly mrr: string;
  readonly searchMsPerQuery: string;
  readonly maxQueryMs: number;
  readonly missCount: number;
  readonly misses: readonly string[];
}

interface StageResult {
  readonly kind: "ok";
  readonly name: string;
  readonly detail: string;
  readonly indexMs: number;
  readonly embedMsPerQuery: string;
  readonly unindexed: number;
  readonly degraded: readonly string[];
  readonly sets: readonly SetMetrics[];
}
type StageOutcome =
  | StageResult
  | { readonly kind: "failed"; readonly name: string; readonly reason: string };

/** One stage's seeding, indexing and timed queries inside its own runtime. */
const runStageEffects = Effect.fn("lab.stage.effects")(function* (stage: Stage) {
  // The lab's project root is the package directory itself, like the product registering the
  // folder it runs in; the temporary storage root lives outside it under node_modules/.vp-tmp.
  const project = yield* (yield* Projects).add(process.cwd());
  const nodes = yield* Nodes;
  // Each recorded node, by the key of the statement it holds.
  const recorded = yield* Effect.forEach(
    sets.flatMap((set) => set.sessions),
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
  const [indexDuration] = yield* Effect.timed(
    Effect.ignore(indexer.indexAll()).pipe(Effect.andThen(Effect.ignore(indexer.analyzeAll()))),
  );
  const search = yield* stage.text
    ? MemorySearch
    : // Evaluation entry point owns this Layer and its resource scope.
      Effect.scoped(
        Effect.flatMap(Layer.build(MemorySearch.tuned({ text: false })), (services) =>
          Effect.provideContext(MemorySearch, services),
        ),
      );

  // Each set's queries, timed one at a time, with where the expected statement ranked (-1: not found).
  const measured = yield* Effect.forEach(sets, (set) =>
    Effect.map(
      Effect.forEach(
        set.queries,
        Effect.fnUntraced(function* (item) {
          const startedAt = process.hrtime.bigint();
          const result = yield* search.find({
            query: item.query,
            projectId: project.id,
            limit: 10,
          });
          const queryNanos = process.hrtime.bigint() - startedAt;
          const found = result.matches.map((match) =>
            Option.getOrUndefined(MutableHashMap.get(keys, match.id)),
          );
          return {
            item,
            found,
            rank: found.indexOf(item.expected),
            queryNanos,
            unindexed: result.unindexed,
            degraded: result.degraded,
          };
        }),
      ),
      (queries) => ({ set, queries }),
    ),
  );
  const metrics = measured.map(({ set, queries }): SetMetrics => {
    const ranks = queries.map(({ rank }) => rank);
    const within = (limit: number) => ranks.filter((rank) => rank >= 0 && rank < limit).length;
    const reciprocal = ranks
      .filter((rank) => rank >= 0)
      .reduce((sum, rank) => sum + 1 / (rank + 1), 0);
    const searchNanos = queries.reduce((sum, { queryNanos }) => sum + queryNanos, 0n);
    const misses = queries
      .filter(({ rank }) => rank !== 0)
      .map(
        ({ item, found, rank, degraded }) =>
          `✗ ${item.query} → ${rank < 0 ? "없음" : `${rank + 1}위`} (1위 ${found[0] ?? "-"}${
            degraded.length > 0 ? `, degraded ${degraded.join(",")}` : ""
          })`,
      );
    const total = set.queries.length;
    const averageMs = Number(searchNanos) / 1e6 / total;
    return {
      name: set.name,
      total,
      top1: within(1),
      top3: within(3),
      top5: within(5),
      mrr: (reciprocal / total).toFixed(3),
      searchMsPerQuery: averageMs.toFixed(1),
      maxQueryMs: queries.reduce(
        (longest, { queryNanos }) => Math.max(longest, Math.round(Number(queryNanos) / 1e6)),
        0,
      ),
      missCount: misses.length,
      misses: misses.slice(0, 6),
    };
  });
  const searched = measured.flatMap(({ queries }) => queries);
  const embedMs =
    stage.embedder === noEmbedder ? 0 : Number(MutableRef.get(stage.embedNanos)) / 1e6;
  const queryCount = sets.reduce((sum, set) => sum + set.queries.length, 0);
  return {
    kind: "ok" as const,
    name: stage.name,
    detail: stage.detail,
    indexMs: Math.round(Duration.toMillis(indexDuration)),
    embedMsPerQuery: (embedMs / queryCount).toFixed(1),
    // What the last search reported; -1 when no query ran.
    unindexed: searched.at(-1)?.unindexed ?? -1,
    degraded: [...new Set(searched.flatMap(({ degraded }) => degraded))],
    sets: metrics,
  } satisfies StageResult;
});

// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
const evaluateStage = Effect.fn("lab.stage")(function* (stage: Stage) {
  const fs = yield* FileSystem.FileSystem;
  // Not scoped: the node process may die before Effect finalizers would run; a stale temp root
  // only costs disk, while a leaked one inside the FS module could block the next run.
  const base = yield* fs.makeTempDirectory({ directory: tmpBase, prefix: labPrefix });
  // The stage runs inside the layer's own scope: scoping the build alone would release the one
  // SQLite connection before the stage runs (eval/recall.ts owns its scope the same way).
  const outcome = yield* Effect.scoped(
    Effect.flatMap(
      Layer.build(
        memoryAgentLayer(join(base, "storage"), {
          embedder: stage.embedder,
          morphAnalyzer: stage.morph,
          interpretAutomatically: false,
          summarizeAutomatically: false,
          sweepSecrets: false,
          importsHome: join(base, "imports"),
          importsWatching: false,
          secrets: SecretStore.memory,
          skillsHome: join(base, "home"),
          kanbanWorktreesBase: join(base, "kanban"),
        }),
      ),
      (servicesContext) => Effect.provideContext(runStageEffects(stage), servicesContext),
    ),
  ).pipe(
    // The stage result is what matters; a failed stage becomes one failed stage, not a dead run.
    Effect.catchCause((cause) => {
      const error = Cause.squash(cause);
      // Tagged schema errors render empty `message`s; the tag and fields are the reason.
      const reason =
        error instanceof Error && error.message.length > 0
          ? error.message
          : `${error instanceof Error ? "" : String(error)}${Cause.pretty(cause)
              .split("\n")
              .filter((line) => line.trim().length > 0)
              .slice(-6)
              .join(" | ")}`;
      return Effect.succeed({
        kind: "failed" as const,
        name: stage.name,
        reason: reason.slice(0, 400),
      } satisfies StageOutcome);
    }),
  );
  if (outcome.kind === "ok") yield* fs.remove(base, { recursive: true, force: true });
  return outcome;
});

const top3 = (result: StageResult | undefined, setName: string): Option.Option<number> =>
  Option.fromNullishOr(result?.sets.find((entry) => entry.name === setName)).pipe(
    Option.map((set) => set.top3 / set.total),
  );

/** Stages that run with no embedder: the vector channel is absent by design there, so its
 * degraded/unindexed signals are the expected state, not failures. */
const withoutEmbedder = (name: string) => name === "fts-only" || name === "morph-only";

const print = (text: string) => nodePlatform.runPromise(Console.log(text));

/** What the run prints for a stage that finished: each set's numbers, then its signals and misses. */
const stageLines = (ok: StageResult): readonly string[] => [
  ...ok.sets.map(
    (set) =>
      `  ${set.name.padEnd(9)}: top1 ${set.top1}/${set.total} top3 ${set.top3}/${set.total} top5 ${set.top5}/${set.total} MRR ${set.mrr} | index ${ok.indexMs}ms, search ${set.searchMsPerQuery}ms/query (max ${set.maxQueryMs}ms), embed ${ok.embedMsPerQuery}ms/query`,
  ),
  `  unindexed ${ok.unindexed}${withoutEmbedder(ok.name) ? " (임베더 없음 스테이지라 예상)" : ""} | degraded ${
    ok.degraded.length > 0
      ? ok.degraded.join(",") + (withoutEmbedder(ok.name) ? " (임베더 없음 스테이지라 예상)" : "")
      : "없음"
  }`,
  ...(ok.sets.some((set) => set.missCount > 0)
    ? [
        `  misses (처음 ${Math.min(6, Math.max(...ok.sets.map((set) => set.missCount)))}개):`,
        ...ok.sets.flatMap((set) => set.misses.map((miss) => `    ${miss}`)),
      ]
    : []),
];

const only = process.argv.slice(2).find((argument) => argument !== "--");
const results = await nodePlatform.runPromise(
  Effect.forEach(
    stages.filter((stage) => only === undefined || stage.name === only),
    (stage) =>
      Effect.tap(evaluateStage(stage), (outcome) =>
        Console.log(
          [
            `\n== stage ${stage.name} — ${stage.detail} ==`,
            ...(outcome.kind === "failed" ? [`  failed: ${outcome.reason}`] : stageLines(outcome)),
          ].join("\n"),
        ),
      ),
  ),
);
await nodePlatform.runPromise(
  Effect.forEach(
    skipped,
    (entry) => Console.log(`\n== stage ${entry.name} — skipped: ${entry.reason} ==`),
    { discard: true },
  ),
);

// Verdict: which stage explains what the numbers show. Every line names the comparison behind it.
const ok = (name: string) => {
  const found = results.find((result) => result.kind === "ok" && result.name === name);
  return found?.kind === "ok" ? found : undefined;
};
const fake = ok("fake-embed");
const real = ok("real-embed");
const fts = ok("fts-only");
const morph = ok("morph-only");
const full = ok("full");
/** How far one stage's top3 is above another's, when both stages ran. */
const gap = (above: Option.Option<number>, below: Option.Option<number>) =>
  Option.zipWith(above, below, (high, low) => high - low);
/** The verdict lines one set's numbers support, in the order the stages compare. */
const setVerdict = (set: RecallSet): readonly string[] => {
  const textChannel = top3(fts, set.name);
  const fakeChannel = top3(fake, set.name);
  const realChannel = top3(real, set.name);
  return Arr.getSomes([
    textChannel.pipe(
      Option.filter((channel) => channel < 0.25),
      Option.map(
        (channel) =>
          `- [${set.name}] trigram FTS 채널 자체가 거의 회수하지 못함 (top3 ${Math.round(channel * 100)}%): 세그먼트·FTS 인덱스·매치 구성을 의심`,
      ),
    ),
    gap(fakeChannel, textChannel).pipe(
      Option.map((textDelta) =>
        textDelta >= -0.05
          ? `- [${set.name}] 벡터 경로(가짜 임베더)는 FTS 대비 top3 ${Math.round(textDelta * 100)}%p — ${textDelta > 0.05 ? "정상 범위" : "기여가 작음"}`
          : `- [${set.name}] 가짜 해시 임베더가 FTS보다 top3 ${Math.round(-textDelta * 100)}%p 낮음 — 랩용 해시 벡터의 한계로 보며 제품 실패로 읽지 않음`,
      ),
    ),
    gap(realChannel, fakeChannel).pipe(
      Option.map((modelDelta) =>
        modelDelta >= 0
          ? `- [${set.name}] 실제 모델이 가짜 대비 top3 +${Math.round(modelDelta * 100)}%p — 임베딩 채널 정상`
          : `- [${set.name}] 실제 모델이 가짜 대비 top3 ${Math.round(modelDelta * 100)}%p — 모델 로딩·identity·청킹 문제를 의심`,
      ),
    ),
    top3(morph, set.name).pipe(
      Option.filter((morphChannel) => morphChannel < 0.1),
      Option.map(
        (morphChannel) =>
          `- [${set.name}] Kiwi 형태소 채널 단독 top3 ${Math.round(morphChannel * 100)}% — 용어 추출이 이 코퍼스에서 거의 매치하지 않음`,
      ),
    ),
    gap(top3(full, set.name), realChannel).pipe(
      Option.map((kiwiDelta) =>
        kiwiDelta >= 0
          ? `- [${set.name}] Kiwi 추가가 top3 +${Math.round(kiwiDelta * 100)}%p`
          : `- [${set.name}] Kiwi 추가가 top3 ${Math.round(kiwiDelta * 100)}%p — 퓨전에서 형태소 용어가 방해할 수 있음`,
      ),
    ),
  ]);
};
const degradedStages = results.flatMap((result) =>
  result.kind === "ok" && !withoutEmbedder(result.name) && result.degraded.includes("vector")
    ? [result.name]
    : [],
);
const unindexedStages = results.flatMap((result) =>
  result.kind === "ok" && !withoutEmbedder(result.name) && result.unindexed > 0
    ? [`${result.name}(${result.unindexed})`]
    : [],
);
const lines = [
  ...sets.flatMap(setVerdict),
  ...(degradedStages.length > 0
    ? [
        `- 임베더가 실행 중 실패한 단계: ${degradedStages.join(", ")} (degraded vector) — 모델 로딩/워커 실패`,
      ]
    : []),
  ...(unindexedStages.length > 0
    ? [
        `- 인덱싱이 끝까지 비우지 못한 단계: ${unindexedStages.join(", ")} — indexAll 드레인 실패 의심`,
      ]
    : []),
];
await print(
  [
    "\n== verdict ==",
    ...lines,
    "\n모델 단계(real-embed, morph-only, full)는 스토리지 루트의 모델 파일을 읽을 수 있어야 실행됩니다. 샌드박스 안에서는 건너뛰어질 수 있습니다.",
  ].join("\n"),
);
