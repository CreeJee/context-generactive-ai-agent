/**
 * Times the native seed read on a read-only copy of a real memory database, stage by stage.
 *
 *   node --no-warnings eval/native-read-bench.ts <db copy> [index.tvim copy] [--project <id>]
 *     [--queries <file>] [--rounds <n>] [--json <file>]
 *
 * Pass `auto` as the index to use the copy's `vectors/<sha256(embedder)[:16]>/index.tvim`.
 * Without an index the reads run without a query vector (no candidate/vector stages): the text
 * stage, which is what fails, does not depend on it. With the index a random unit vector stands
 * in for the embedding; the stages' cost does not depend on which vector it is. Morph terms need
 * the Kiwi model, which the copy does not carry, so the morph stage is off.
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
import { Schema } from "effect";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { addonPath, loadTurbovec, type NativeReadOutput } from "../../turbovec/index.js";
import { initializeNodeSqlite } from "../src/runtime/node-sqlite-bridge.ts";
import { searchTerms } from "../src/memory/search.ts";

interface BenchQuery {
  readonly group: string;
  readonly query: string;
  readonly projectId: string;
  readonly limit: number;
}

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
const [dbPath, indexArgument] = argv;
if (dbPath === undefined) {
  console.error("usage: native-read-bench.ts <db copy> [index.tvim copy] [--project <id>]");
  process.exit(2);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const select = (sql: string, ...params: (string | number)[]) => db.prepare(sql).all(...params);
const Count = Schema.Array(Schema.Struct({ n: Schema.Number }));
const count = (sql: string, ...params: (string | number)[]) =>
  Schema.decodeUnknownSync(Count)(select(sql, ...params))[0]!.n;
const QueryRecord = Schema.Struct({
  group: Schema.String,
  query: Schema.String,
  projectId: Schema.String,
  limit: Schema.Number,
});

const embedder =
  Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ embedder: Schema.String })))(
    select("SELECT embedder FROM node_vectors GROUP BY embedder ORDER BY count(*) DESC LIMIT 1"),
  )[0]?.embedder ?? "none";
// "auto": the app's own index file for that embedder, beside the database copy.
const indexPath =
  indexArgument === "auto"
    ? join(
        dirname(dbPath),
        "vectors",
        createHash("sha256").update(embedder).digest("hex").slice(0, 16),
        "index.tvim",
      )
    : indexArgument;
const ownProject =
  projectFlag ??
  Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ project_id: Schema.String })))(
    select("SELECT project_id FROM nodes WHERE kind = 'user' ORDER BY seq DESC LIMIT 1"),
  )[0]!.project_id;

const quotedString = /"query"\s*:\s*"((?:[^"\\]|\\.)*)"/u;
const recordedFinds = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ text: Schema.String, project_id: Schema.String })),
)(
  select(
    "SELECT text, project_id FROM nodes WHERE kind = 'tool_call' AND json_extract(detail, '$.toolName') = 'find_memory' ORDER BY seq DESC LIMIT 2000",
  ),
).flatMap((row): BenchQuery[] => {
  const match = quotedString.exec(row.text);
  if (match === null) return [];
  const query = Schema.decodeUnknownSync(Schema.String)(JSON.parse(`"${match[1]}"`));
  return query.trim().length === 0
    ? []
    : [{ group: "find", query, projectId: row.project_id, limit: 12 }];
});
console.log(
  `recorded find_memory calls: ${recordedFinds.length}, own project ${recordedFinds.filter((q) => q.projectId === ownProject).length}`,
);
const finds = [...new Map(recordedFinds.map((q) => [`${q.projectId}\u0000${q.query}`, q])).values()]
  // Each replayed in the project it was asked in, as its own project.
  .slice(0, 60);
const users = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ text: Schema.String, session_id: Schema.NullOr(Schema.String) })),
)(
  select(
    "SELECT text, session_id FROM nodes WHERE kind = 'user' AND project_id = ? AND length(text) > 20 ORDER BY seq DESC LIMIT 600",
    ownProject,
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
const extra: BenchQuery[] =
  queriesFile === undefined
    ? []
    : readFileSync(queriesFile, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line): BenchQuery => Schema.decodeUnknownSync(QueryRecord)(JSON.parse(line)));
const queries = [...extra, ...finds, ...interprets, ...recalls];

const { VectorIndex, MemoryReadSession, SearchControl } = loadTurbovec();
initializeNodeSqlite(addonPath);
const index = indexPath === undefined ? new VectorIndex(384, 4) : VectorIndex.load(indexPath);
const randomUnit = () => {
  const values = Float32Array.from({ length: 384 }, () => Math.random() - 0.5);
  const norm = Math.hypot(...values);
  return values.map((value) => value / norm);
};

interface Row {
  readonly group: string;
  readonly pass: "cold" | "warm";
  readonly chars: number;
  readonly trigramTerms: number;
  readonly shortTerms: number;
  readonly out: NativeReadOutput;
  readonly wallMs: number;
}
const rows: Row[] = [];
const owner = randomUUID();
const readOnce = (reader: InstanceType<typeof MemoryReadSession>, q: BenchQuery) => {
  const terms = searchTerms(q.query);
  const requestId = randomUUID();
  const control = new SearchControl(randomUUID(), owner, "bench", requestId, 2_000);
  const started = performance.now();
  try {
    const out = reader.search(
      index,
      {
        allowedProjects: [q.projectId],
        embedder,
        query: indexPath === undefined ? undefined : randomUnit(),
        trigramTerms: terms.trigram,
        shortTerms: terms.short,
        morphTerms: [],
        vectorK: Math.min(q.limit * 4, 48),
        textK: q.limit * 2,
        morphK: q.limit * 2,
        textEnabled: true,
        morphEnabled: false,
        remainingMs: 2_000,
        inputBudgetBytes: 1_048_576,
        outputBudgetBytes: 1_048_576,
      },
      control.token(),
      owner,
      "bench",
      requestId,
    );
    return { out, wallMs: performance.now() - started, terms };
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
        const { out, wallMs, terms } = readOnce(reader, q);
        rows.push({
          group: q.group,
          pass,
          chars: q.query.length,
          trigramTerms: terms.trigram.length,
          shortTerms: terms.short.length,
          out,
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

console.log(
  `session ${sharedSession ? "shared" : "per query"}; rss growth ${rssGrowthMb.toFixed(0)} MB`,
);
console.log(
  `db rows: ${count("SELECT count(*) AS n FROM nodes")} nodes, own project ${count("SELECT count(*) AS n FROM nodes WHERE project_id = ?", ownProject)} nodes; index ${indexPath === undefined ? "none" : index.size()} vectors; queries find ${finds.length} interpret ${interprets.length} recall ${recalls.length} extra ${extra.length}; rounds ${rounds}`,
);
console.log(
  "| group | pass | n | fail (stage) | wall p50/p95 | text p50/p95 | trigram p50/p95 | short sum p50/p95 | short max p95 | short terms p50/max | trigram terms p50/max | candidate+vector p50/p95 | coverage p50/p95 |",
);
console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
const groups = [...new Set(rows.map((row) => row.group))];
for (const group of groups)
  for (const pass of ["cold", "warm"] as const) {
    const selected = rows.filter((row) => row.group === group && row.pass === pass);
    const failed = selected.filter((row) => row.out.kind !== "success");
    const stages = [
      ...new Set(failed.map((row) => `${row.out.kind}@${row.out.failedStage ?? "-"}`)),
    ];
    console.log(
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
      )}/${Math.max(0, ...selected.map((r) => r.trigramTerms))} | ${stat(selected.map((r) => r.out.candidateMs + r.out.vectorMs))} | ${stat(selected.map((r) => r.out.coverageMs))} |`,
    );
  }
if (jsonOut !== undefined)
  writeFileSync(
    jsonOut,
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
          queueMs: row.out.queueMs,
          coverageMs: row.out.coverageMs,
        }),
      )
      .join("\n") + "\n",
  );
index.close();
db.close();
