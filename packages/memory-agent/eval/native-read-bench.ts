/**
 * Times the native seed read on a read-only copy of a real memory database, stage by stage.
 *
 *   node --no-warnings eval/native-read-bench.ts <db copy> [index.tvim copy] [--lexical <dir>]
 *     [--project <id>] [--queries <file>] [--rounds <n>] [--json <file>]
 *
 * Pass `auto` as the index to use the copy's `vectors/<sha256(embedder)[:16]>/index.tvim`.
 * Without an index the reads run without a query vector (no candidate/vector stages): the text
 * stage, which is what fails, does not depend on it. With the index a random unit vector stands
 * in for the embedding; the stages' cost does not depend on which vector it is. The text and morph
 * stages read the lexical index in `--lexical` (`auto`: the copy's own, as the app names it under
 * `<db dir>/lexical`) and are off without it. An app run on the copy (search-set pool, relevance)
 * builds that index; changes still journaled drop their nodes, and the report counts them.
 *
 * Query groups, the shapes the app searches with:
 * - find: the find_memory queries recorded in the copy's tool calls (limit 12, own project);
 * - interpret: user statements cut to 500 characters (limit 10, own project);
 * - recall: three consecutive user turns joined and cut to 6000 characters (limit 16).
 * `--queries` adds a JSON file of `{ group, query, projectId, limit }` lines.
 *
 * "cold" is the first read of each query on a new read session (an empty SQLite page cache; the
 * OS file cache may still hold the pages). "warm" repeats it on the same session.
 * Nothing it reads is printed: only counts and times. `--json` writes per-read rows (no text).
 */
import { DatabaseSync } from "node:sqlite";
import { Array as Arr, Console, Effect, FileSystem, Option, Random, Schema } from "effect";
import { SecureRandom } from "effect/crypto";
import { addonPath, loadTurbovec, type NativeReadOutput } from "../../turbovec/index.js";
import { initializeNodeSqlite } from "../src/runtime/node-sqlite-bridge.ts";
import { lexicalLayout } from "../src/memory/embedding/native-vector-index.ts";
import { readCoverage, type ReadCoverage } from "../src/memory/native-search/coverage.ts";
import { searchTerms } from "../src/memory/search.ts";
import { nodePlatform } from "../src/runtime/node-platform.ts";
import { sha256 } from "../src/runtime/synchronous-crypto.ts";
import { path } from "../src/runtime/synchronous-path.ts";

interface BenchQuery {
  readonly group: string;
  readonly query: string;
  readonly projectId: string;
  readonly limit: number;
}

/** Prints one line of the report. */
const print = (line: string) => Effect.runPromise(Console.log(line));

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv.splice(at, 2)[1];
};
const projectFlag = flag("--project");
const queriesFile = flag("--queries");
const rounds = Number(flag("--rounds") ?? "1");
const jsonOut = flag("--json");
// One session for every query, as the app's worker keeps it: pass "cold" is then each query's
// first read on a session other queries already used.
const sharedAt = argv.indexOf("--shared-session");
const sharedSession = sharedAt !== -1;
if (sharedSession) argv.splice(sharedAt, 1);
const lexicalFlag = flag("--lexical");
const [dbPath, indexArgument] = argv;
if (dbPath === undefined) {
  await Effect.runPromise(
    Console.error(
      "usage: native-read-bench.ts <db copy> [index.tvim copy] [--lexical <dir>] [--project <id>]",
    ),
  );
  process.exit(2);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const select = (sql: string, ...params: (string | number)[]) => db.prepare(sql).all(...params);
const Count = Schema.Array(Schema.Struct({ n: Schema.Finite }));
const count = (sql: string, ...params: (string | number)[]) =>
  Effect.runPromise(Schema.decodeUnknownEffect(Count)(select(sql, ...params))).then(
    (rows) => rows[0]!.n,
  );
const QueryRecord = Schema.Struct({
  group: Schema.String,
  query: Schema.String,
  projectId: Schema.String,
  limit: Schema.Finite,
});

const embedder =
  (
    await Effect.runPromise(
      Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ embedder: Schema.String })))(
        select(
          "SELECT embedder FROM node_vectors GROUP BY embedder ORDER BY count(*) DESC LIMIT 1",
        ),
      ),
    )
  )[0]?.embedder ?? "none";
// "auto": the app's own index file for that embedder, beside the database copy.
const indexPath =
  indexArgument === "auto"
    ? path.join(path.dirname(dbPath), "vectors", sha256(embedder).slice(0, 16), "index.tvim")
    : indexArgument;
const ownProject =
  projectFlag ??
  (
    await Effect.runPromise(
      Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ project_id: Schema.String })))(
        select("SELECT project_id FROM nodes WHERE kind = 'user' ORDER BY seq DESC LIMIT 1"),
      ),
    )
  )[0]!.project_id;

const quotedString = /"query"\s*:\s*"((?:[^"\\]|\\.)*)"/u;
const decodeQuoted = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.String));
const recordedFinds = (
  await Effect.runPromise(
    Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ text: Schema.String, project_id: Schema.String })),
    )(
      select(
        "SELECT text, project_id FROM nodes WHERE kind = 'tool_call' AND json_extract(detail, '$.toolName') = 'find_memory' ORDER BY seq DESC LIMIT 2000",
      ),
    ),
  )
).flatMap((row): BenchQuery[] => {
  const match = quotedString.exec(row.text);
  if (match === null) return [];
  // A quoted value whose escapes are not JSON's is not a query the bench can replay.
  return Option.toArray(decodeQuoted(`"${match[1]}"`)).flatMap((query) =>
    query.trim().length === 0
      ? []
      : [{ group: "find", query, projectId: row.project_id, limit: 12 }],
  );
});
await print(
  `recorded find_memory calls: ${recordedFinds.length}, own project ${recordedFinds.filter((q) => q.projectId === ownProject).length}`,
);
const finds = [...new Map(recordedFinds.map((q) => [`${q.projectId}\u0000${q.query}`, q])).values()]
  // Each replayed in the project it was asked in, as its own project.
  .slice(0, 60);
const users = await Effect.runPromise(
  Schema.decodeUnknownEffect(
    Schema.Array(Schema.Struct({ text: Schema.String, session_id: Schema.NullOr(Schema.String) })),
  )(
    select(
      "SELECT text, session_id FROM nodes WHERE kind = 'user' AND project_id = ? AND length(text) > 20 ORDER BY seq DESC LIMIT 600",
      ownProject,
    ),
  ),
);
const interprets = users.slice(0, 40).map((row) => ({
  group: "interpret",
  query: row.text.slice(0, 500),
  projectId: ownProject,
  limit: 10,
}));
const recalls = users
  .slice(0, 120)
  .flatMap((row, index, rows) => {
    const window = rows.slice(index, index + 3);
    return window.length === 3 && window.every((w) => w.session_id === row.session_id)
      ? [
          window
            .map((w) => w.text)
            .reverse()
            .join("\n")
            .slice(0, 6_000),
        ]
      : [];
  })
  .filter((_, index) => index % 3 === 0)
  .slice(0, 30)
  .map((query) => ({ group: "recall", query, projectId: ownProject, limit: 16 }));
const decodeQueryRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(QueryRecord));
const extra: ReadonlyArray<BenchQuery> =
  queriesFile === undefined
    ? []
    : await nodePlatform.runPromise(
        Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(queriesFile)).pipe(
          Effect.flatMap((text) =>
            Effect.forEach(
              text.split("\n").filter((line) => line.trim().length > 0),
              (line) => decodeQueryRecord(line),
            ),
          ),
        ),
      );
const queries = [...extra, ...finds, ...interprets, ...recalls];

const { VectorIndex, MemoryReadSession, SearchControl, LexicalIndex } = loadTurbovec();
initializeNodeSqlite(addonPath);
const index = indexPath === undefined ? new VectorIndex(384, 4) : VectorIndex.load(indexPath);
// "auto": the app's own lexical index, beside the database copy.
const lexicalDirectory =
  lexicalFlag === "auto"
    ? path.join(path.dirname(dbPath), "lexical", sha256(lexicalLayout).slice(0, 16))
    : lexicalFlag;
// Opening a missing folder would make an empty index and time reads that find nothing.
const lexicalFound =
  lexicalDirectory !== undefined &&
  (await nodePlatform.runPromise(
    Effect.flatMap(FileSystem.FileSystem, (fs) => fs.exists(lexicalDirectory)),
  ));
if (lexicalDirectory !== undefined && !lexicalFound) {
  await Effect.runPromise(Console.error(`no lexical index at ${lexicalDirectory}`));
  process.exit(2);
}
const lexical = lexicalDirectory === undefined ? null : LexicalIndex.open(lexicalDirectory, false);
const randomUnit = () => {
  const values = Float32Array.from(
    Effect.runSync(Effect.forEach(Arr.range(1, 384), () => Random.next)),
    (value) => value - 0.5,
  );
  const norm = Math.hypot(...values);
  return values.map((value) => value / norm);
};

interface Row {
  readonly group: string;
  readonly pass: "cold" | "warm";
  readonly chars: number;
  readonly trigramTerms: number;
  readonly shortTerms: number;
  readonly morphTerms: number;
  readonly out: NativeReadOutput;
  readonly coverage: ReadCoverage;
  readonly coverageMs: number;
  readonly wallMs: number;
}
const rows: Row[] = [];
const owner = SecureRandom.uuidV4Unsafe();
const readOnce = (reader: InstanceType<typeof MemoryReadSession>, q: BenchQuery) => {
  const terms = searchTerms(q.query);
  const morphTerms = lexical?.morphTerms(q.query) ?? [];
  const requestId = SecureRandom.uuidV4Unsafe();
  const control = new SearchControl(SecureRandom.uuidV4Unsafe(), owner, "bench", requestId, 2_000);
  const started = performance.now();
  try {
    const out = reader.search(
      index,
      lexical,
      {
        allowedProjects: [q.projectId],
        embedder,
        query: indexPath === undefined ? undefined : randomUnit(),
        trigramTerms: terms.trigram,
        shortTerms: terms.short,
        morphQuery: q.query,
        vectorK: Math.min(q.limit * 4, 48),
        textK: q.limit * 2,
        morphK: q.limit * 2,
        textEnabled: lexical !== null,
        morphEnabled: lexical !== null && q.query.trim().length > 0,
        remainingMs: 2_000,
        inputBudgetBytes: 1_048_576,
        outputBudgetBytes: 1_048_576,
      },
      control.token(),
      owner,
      "bench",
      requestId,
    );
    // The worker counts coverage on its own connection after the read, as here.
    const coverageStarted = performance.now();
    const coverage =
      out.kind === "success"
        ? Effect.runSync(readCoverage(db, embedder, [q.projectId]))
        : { unindexed: 0, lexicalPending: 0, uninterpreted: 0 };
    const coverageMs = performance.now() - coverageStarted;
    return { out, coverage, coverageMs, wallMs: performance.now() - started, terms, morphTerms };
  } finally {
    control.close();
  }
};

const shared = sharedSession ? new MemoryReadSession(dbPath) : undefined;
const rssBefore = process.memoryUsage().rss;
for (let round = 0; round < rounds; round++) {
  for (const q of queries) {
    const reader = shared ?? new MemoryReadSession(dbPath);
    try {
      for (const pass of ["cold", "warm"] as const) {
        const { out, coverage, coverageMs, wallMs, terms, morphTerms } = readOnce(reader, q);
        rows.push({
          group: q.group,
          pass,
          chars: q.query.length,
          trigramTerms: terms.trigram.length,
          shortTerms: terms.short.length,
          morphTerms: morphTerms.length,
          out,
          coverage,
          coverageMs,
          wallMs,
        });
      }
    } finally {
      if (shared === undefined) reader.close();
    }
  }
}
const rssGrowthMb = (process.memoryUsage().rss - rssBefore) / 1_048_576;
shared?.close();

const quantile = (values: readonly number[], q: number) => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
};
const fmt = (value: number) => (Number.isNaN(value) ? "-" : value.toFixed(1));
const stat = (values: readonly number[]) =>
  `${fmt(quantile(values, 0.5))}/${fmt(quantile(values, 0.95))}`;

await print(
  `session ${sharedSession ? "shared" : "per query"}; rss growth ${rssGrowthMb.toFixed(0)} MB`,
);
const nodeCount = await count("SELECT count(*) AS n FROM nodes");
const ownNodeCount = await count(
  "SELECT count(*) AS n FROM nodes WHERE project_id = ?",
  ownProject,
);
await print(
  `db rows: ${nodeCount} nodes, own project ${ownNodeCount} nodes; index ${indexPath === undefined ? "none" : index.size()} vectors; lexical ${lexical === null ? "none" : `${lexical.size()} documents, ${Math.max(0, ...rows.map((row) => row.coverage.lexicalPending))} changes pending`}; queries find ${finds.length} interpret ${interprets.length} recall ${recalls.length} extra ${extra.length}; rounds ${rounds}`,
);
await print(
  "| group | pass | n | fail (stage) | wall p50/p95 | text p50/p95 | trigram p50/p95 | short sum p50/p95 | short max p95 | short terms p50/max | trigram terms p50/max | candidate+vector p50/p95 | morph p50/p95 | morph terms p50/max | coverage p50/p95 |",
);
await print("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
const groups = [...new Set(rows.map((row) => row.group))];
for (const group of groups)
  for (const pass of ["cold", "warm"] as const) {
    const selected = rows.filter((row) => row.group === group && row.pass === pass);
    const failed = selected.filter((row) => row.out.kind !== "success");
    const stages = [
      ...new Set(failed.map((row) => `${row.out.kind}@${row.out.failedStage ?? "-"}`)),
    ];
    await print(
      `| ${group} | ${pass} | ${selected.length} | ${failed.length} ${stages.join(",")} | ${stat(selected.map((r) => r.wallMs))} | ${stat(selected.map((r) => r.out.textMs))} | ${stat(selected.flatMap((r) => (r.out.trigramMs == null ? [] : [r.out.trigramMs])))} | ${stat(selected.map((r) => r.out.shortTermMs))} | ${fmt(
        quantile(
          selected.map((r) => r.out.shortTermMaxMs),
          0.95,
        ),
      )} | ${fmt(
        quantile(
          selected.map((r) => r.shortTerms),
          0.5,
        ),
      )}/${Math.max(0, ...selected.map((r) => r.shortTerms))} | ${fmt(
        quantile(
          selected.map((r) => r.trigramTerms),
          0.5,
        ),
      )}/${Math.max(0, ...selected.map((r) => r.trigramTerms))} | ${stat(selected.map((r) => r.out.candidateMs + r.out.vectorMs))} | ${stat(selected.map((r) => r.out.morphMs))} | ${fmt(
        quantile(
          selected.map((r) => r.morphTerms),
          0.5,
        ),
      )}/${Math.max(0, ...selected.map((r) => r.morphTerms))} | ${stat(selected.map((r) => r.coverageMs))} |`,
    );
  }
if (jsonOut !== undefined) {
  const report =
    rows
      .map((row) =>
        JSON.stringify({
          group: row.group,
          pass: row.pass,
          chars: row.chars,
          trigramTerms: row.trigramTerms,
          shortTerms: row.shortTerms,
          wallMs: row.wallMs,
          kind: row.out.kind,
          failedStage: row.out.failedStage,
          textIds: row.out.textIds,
          candidateMs: row.out.candidateMs,
          vectorMs: row.out.vectorMs,
          textMs: row.out.textMs,
          trigramMs: row.out.trigramMs,
          shortTermMs: row.out.shortTermMs,
          shortTermMaxMs: row.out.shortTermMaxMs,
          shortTermsDone: row.out.shortTermsDone,
          morphTerms: row.morphTerms,
          morphMs: row.out.morphMs,
          textUnavailable: row.out.textUnavailable,
          queueMs: row.out.queueMs,
          coverageMs: row.coverageMs,
        }),
      )
      .join("\n") + "\n";
  await nodePlatform.runPromise(
    Effect.flatMap(FileSystem.FileSystem, (fs) => fs.writeFileString(jsonOut, report)),
  );
}
index.close();
lexical?.close();
db.close();
