/**
 * Relevance set made from real use, and its score, on a copy of a real memory storage folder.
 *
 *   node --no-warnings eval/relevance.ts build <storage copy>   writes <storage copy>/relevance.jsonl
 *   node --no-warnings eval/relevance.ts score <storage copy> [--label <name>] [--group find|recall]
 *       [--tuning <json>] [--dump <file> [--resume]]
 *
 * The storage copy holds agent.db, vectors/ and models/ like ~/.context-generactive-agent. It is
 * opened as the app opens its own: the search under test is MemorySearch.find with the local
 * embedder and Kiwi. The set and anything holding memory text stay inside the copy, which is
 * outside git; this script prints only counts and scores.
 *
 * Rule: a recorded find_memory call is a query; the nodes of its result that the same run then
 * opened with read_evidence or trace_evidence, before its next find_memory call, are its relevant
 * nodes. Calls whose result the model opened nothing from are left out. This only knows what the
 * search returned then, so it rewards keeping those nodes, not finding better ones elsewhere.
 * `recall` items join the three user statements before the call (as automatic recall does) and keep
 * the same relevant nodes, with limit 16.
 */
import { DatabaseSync } from "node:sqlite";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Console, Effect, Layer, Option, Schema } from "effect";
import { SecretStore } from "../src/config/secrets.ts";
import { StorageRoot } from "../src/config/storage-root.ts";
import { Embedder, EmbedderRuntime } from "../src/memory/embedding/embedder.ts";
import { memoryAgentLayer } from "../src/layers.ts";
import { MemorySearch, searchTuning, type SearchTuning } from "../src/memory/search.ts";
import { runNativeEffect } from "../src/runtime/native-effect.ts";

const Item = Schema.Struct({
  group: Schema.Literals(["find", "recall"]),
  query: Schema.String,
  projectId: Schema.String,
  crossProject: Schema.Boolean,
  limit: Schema.Number,
  relevant: Schema.Array(Schema.String),
});
type Item = typeof Item.Type;

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv.splice(at, 2)[1];
};
const label = flag("--label") ?? "current";
const onlyGroup = flag("--group");
const dumpFile = flag("--dump");
const tuningJson = flag("--tuning");
// Concurrent scoring queues reads on the single owner slot, and the queue wait eats the read
// budget: keep 1 (the app's shape) unless a run explicitly asks otherwise.
const concurrency = Number(flag("--concurrency") ?? "1");
const TuningOverride = Schema.Struct({
  vectorCut: Schema.optional(Schema.Finite),
  vectorWeight: Schema.optional(Schema.Finite),
  textWeight: Schema.optional(Schema.Finite),
  morphWeight: Schema.optional(Schema.Finite),
  exactTextWeight: Schema.optional(Schema.Finite),
  otherProjectMerge: Schema.optional(Schema.Literals(["alternate", "append"])),
});
const tuning: SearchTuning | undefined =
  tuningJson === undefined
    ? undefined
    : // The flag overrides the named fields and keeps the app's other settings.
      {
        ...searchTuning,
        ...Object.fromEntries(
          Object.entries(Schema.decodeUnknownSync(TuningOverride)(JSON.parse(tuningJson))).filter(
            ([, value]) => value !== undefined,
          ),
        ),
      };
const resume = argv.includes("--resume");
const [mode, storage] = argv;
if ((mode !== "build" && mode !== "score") || storage === undefined) {
  console.error(
    "usage: relevance.ts build|score <storage copy> [--label <name>] [--group <g>] " +
      "[--tuning <json>] [--dump <file> [--resume]]",
  );
  process.exit(2);
}
const setFile = join(storage, "relevance.jsonl");

// Query embeddings reused across scoring runs, keyed by the exact query text; the file lives in
// the copy. A torn final line from an interrupted append fails to decode and is skipped.
const CachedLine = Schema.Struct({ text: Schema.String, vector: Schema.String });
const embedCacheFile = join(storage, "embed-cache.jsonl");
/** Query text -> base64 vector; the whole `{text, vector}` line is appended on a cache miss. */
const embedCache = new Map<string, string>();
try {
  for (const line of readFileSync(embedCacheFile, "utf8").split("\n"))
    if (line.trim().length > 0)
      try {
        const entry = Schema.decodeUnknownSync(CachedLine)(JSON.parse(line));
        embedCache.set(entry.text, entry.vector);
      } catch {
        // Torn final line.
      }
} catch {
  // First run: no cache yet.
}

const Call = Schema.Struct({
  id: Schema.String,
  seq: Schema.Number,
  run_id: Schema.NullOr(Schema.String),
  session_id: Schema.String,
  project_id: Schema.String,
  text: Schema.String,
  tool: Schema.String,
  result: Schema.NullOr(Schema.String),
});
const FindArguments = Schema.Struct({
  query: Schema.String,
  crossProject: Schema.optional(Schema.Boolean),
});
const OpenArguments = Schema.Struct({ id: Schema.String });
const ResultIds = Schema.Struct({ matches: Schema.Array(Schema.Struct({ id: Schema.String })) });
const UserText = Schema.Array(Schema.Struct({ text: Schema.String }));
const uuid = /"id"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/gu;

/** Identifies a dumped row's query without carrying its text: memory text stays in the copy. */
const querySha = (query: string) => createHash("sha256").update(query).digest("hex").slice(0, 12);

/** The JSON object after the tool name, or none when the recorded text is not one. */
const argumentsOf = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  text: string,
): Option.Option<S["Type"]> => {
  const json = text.slice(text.indexOf(" ") + 1);
  try {
    return Schema.decodeUnknownOption(schema)(JSON.parse(json));
  } catch {
    return Option.none();
  }
};

/** The node ids a find_memory result listed: parsed, or every id when the text is cut. */
const resultIds = (text: string) => {
  try {
    return Option.match(Schema.decodeUnknownOption(ResultIds)(JSON.parse(text)), {
      onSome: (result) => result.matches.map((match) => match.id),
      onNone: () => [...text.matchAll(uuid)].map((match) => match[1]!),
    });
  } catch {
    return [...text.matchAll(uuid)].map((match) => match[1]!);
  }
};

const build = () => {
  const db = new DatabaseSync(join(storage, "agent.db"), { readOnly: true });
  const calls = Schema.decodeUnknownSync(Schema.Array(Call))(
    db
      .prepare(
        `SELECT c.id, c.seq, c.run_id, c.session_id, c.project_id, c.text,
          json_extract(c.detail, '$.toolName') AS tool,
          (SELECT r.text FROM nodes r WHERE r.session_id = c.session_id AND r.kind = 'tool_result'
            AND json_extract(r.detail, '$.toolCallId') = json_extract(c.detail, '$.toolCallId')
            LIMIT 1) AS result
        FROM nodes c WHERE c.kind = 'tool_call'
          AND json_extract(c.detail, '$.toolName') IN ('find_memory', 'read_evidence', 'trace_evidence')
        ORDER BY c.seq`,
      )
      .all(),
  );
  const exists = db.prepare("SELECT 1 AS found FROM nodes WHERE id = ?");
  const usersBefore = db.prepare(
    "SELECT text FROM nodes WHERE session_id = ? AND kind = 'user' AND seq < ? ORDER BY seq DESC LIMIT 3",
  );
  const items: Item[] = [];
  const seen = { run: 0, result: 0, parsed: 0, listed: 0, opened: 0 };
  calls.forEach((call, index) => {
    if (call.tool !== "find_memory") return;
    if (call.run_id === null) return;
    seen.run++;
    if (call.result === null) return;
    seen.result++;
    const input = argumentsOf(FindArguments, call.text);
    if (Option.isNone(input) || input.value.query.trim().length === 0) return;
    seen.parsed++;
    const listed = new Set(resultIds(call.result));
    if (listed.size > 0) seen.listed++;
    const opened = new Set<string>();
    for (const later of calls.slice(index + 1)) {
      if (later.run_id !== call.run_id) continue;
      if (later.tool === "find_memory") break;
      Option.map(argumentsOf(OpenArguments, later.text), ({ id }) => opened.add(id));
    }
    if (opened.size > 0) seen.opened++;
    const relevant = [...opened].filter((id) => listed.has(id) && exists.get(id) !== undefined);
    if (relevant.length === 0) return;
    const crossProject = input.value.crossProject ?? true;
    items.push({
      group: "find",
      query: input.value.query,
      projectId: call.project_id,
      crossProject,
      limit: 12,
      relevant,
    });
    const users = Schema.decodeUnknownSync(UserText)(usersBefore.all(call.session_id, call.seq));
    if (users.length > 0)
      items.push({
        group: "recall",
        query: users
          .map((user) => user.text)
          .reverse()
          .join("\n")
          .slice(0, 6_000),
        projectId: call.project_id,
        crossProject: true,
        limit: 16,
        relevant,
      });
  });
  // One item per distinct query and project; the later call's opened nodes win.
  const unique = [
    ...new Map(
      items.map((item) => [`${item.group}\u0000${item.projectId}\u0000${item.query}`, item]),
    ).values(),
  ];
  writeFileSync(setFile, unique.map((item) => JSON.stringify(item)).join("\n") + "\n");
  const count = (group: string) => unique.filter((item) => item.group === group).length;
  console.log(JSON.stringify(seen));
  console.log(
    `find_memory calls ${calls.filter((call) => call.tool === "find_memory").length}; items find ${count("find")} recall ${count("recall")}; relevant per item ${(unique.reduce((sum, item) => sum + item.relevant.length, 0) / Math.max(1, unique.length)).toFixed(2)}`,
  );
  db.close();
};

/** One scored item's row: the query's hash and its scores; memory text stays out. */
interface DumpRow {
  readonly group: Item["group"];
  readonly query: string;
  readonly failed: boolean;
  readonly degraded: readonly string[];
  readonly reason?: string;
  readonly stage?: string | null;
  readonly elapsedMs?: number | null;
  readonly reciprocal: number;
  readonly at5: number;
  readonly at12: number;
  readonly at16: number;
}
/** What the per-group summary needs; a dumped row carries these plus its label. */
type ScoredRow = Pick<
  DumpRow,
  "group" | "failed" | "degraded" | "reciprocal" | "at5" | "at12" | "at16"
>;

const DumpedRow = Schema.Struct({
  label: Schema.String,
  group: Schema.Literals(["find", "recall"]),
  query: Schema.String,
  failed: Schema.Boolean,
  degraded: Schema.Array(Schema.String),
  reciprocal: Schema.Number,
  at5: Schema.Number,
  at12: Schema.Number,
  at16: Schema.Number,
});

const score = Effect.gen(function* () {
  // A killed run's dump rows are kept: --resume skips the items the dump already holds and
  // appends after them; without it the dump starts over.
  const DumpedKey = Schema.Struct({ group: Schema.String, query: Schema.String });
  const doneKeys = new Set<string>();
  if (resume && dumpFile !== undefined) {
    try {
      for (const line of readFileSync(dumpFile, "utf8").split("\n")) {
        if (line.trim().length === 0) continue;
        try {
          const row = Schema.decodeUnknownSync(DumpedKey)(JSON.parse(line));
          doneKeys.add(`${row.group}|${row.query}`);
        } catch {
          // Torn final line from a killed append.
        }
      }
    } catch {
      // Nothing dumped yet.
    }
  }
  const items = readFileSync(setFile, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => Schema.decodeUnknownSync(Item)(JSON.parse(line)))
    .filter((item) => onlyGroup === undefined || item.group === onlyGroup)
    .filter((item) => !doneKeys.has(`${item.group}|${querySha(item.query)}`));
  const search = yield* MemorySearch;
  // Rows land in the dump as they finish: a long run shows progress, and a killed run keeps
  // the rows it already scored. Memory text stays out: ids and scores only.
  const dump = (row: DumpRow) => {
    if (dumpFile !== undefined) appendFileSync(dumpFile, JSON.stringify({ label, ...row }) + "\n");
  };
  if (dumpFile !== undefined && !resume) writeFileSync(dumpFile, "");
  const rows = yield* Effect.forEach(
    items,
    (item) =>
      search
        .find({
          query: item.query,
          projectId: item.projectId,
          crossProject: item.crossProject,
          limit: item.limit,
        })
        .pipe(
          Effect.map((result) => {
            const ids = result.matches.map((match) => match.id);
            const first = ids.findIndex((id) => item.relevant.includes(id));
            const within = (k: number) =>
              item.relevant.filter((id) => ids.slice(0, k).includes(id)).length /
              item.relevant.length;
            return {
              group: item.group,
              query: querySha(item.query),
              failed: false,
              degraded: result.degraded,
              reciprocal: first < 0 ? 0 : 1 / (first + 1),
              at5: within(5),
              at12: within(12),
              at16: within(16),
            };
          }),
          Effect.catchTag("NativeMemorySearchFailed", (error) =>
            Effect.succeed({
              group: item.group,
              query: querySha(item.query),
              failed: true,
              degraded: [],
              reason: error.reason,
              stage: error.stage ?? null,
              elapsedMs: error.elapsedMs ?? null,
              reciprocal: 0,
              at5: 0,
              at12: 0,
              at16: 0,
            }),
          ),
          // Append each row as it settles, success or failure.
          Effect.tap((row) => Effect.sync(() => dump(row))),
        ),
    { concurrency },
  );
  const mean = (values: readonly number[]) =>
    (values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)).toFixed(3);
  // A resumed run scored only its remaining items; the table reads the whole dump instead (the
  // last row per query wins, a torn final line is skipped), so it stays the set's score.
  const summaryRows = new Map<string, ScoredRow>();
  if (dumpFile === undefined) {
    for (const row of rows) summaryRows.set(`${row.group}|${row.query}`, row);
  } else {
    for (const line of readFileSync(dumpFile, "utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const row = Schema.decodeUnknownSync(DumpedRow)(JSON.parse(line));
        summaryRows.set(`${row.group}|${row.query}`, row);
      } catch {
        // Torn final line from a killed append.
      }
    }
  }
  for (const group of new Set([...summaryRows.values()].map((row) => row.group))) {
    const selected = [...summaryRows.values()].filter((row) => row.group === group);
    yield* Console.log(
      `| ${label} | ${group} | ${selected.length} | ${selected.filter((row) => row.failed).length} | ${selected.filter((row) => row.degraded.length > 0).length} | ${mean(selected.map((row) => row.reciprocal))} | ${mean(selected.map((row) => row.at5))} | ${mean(selected.map((row) => row.at12))} | ${mean(selected.map((row) => row.at16))} |`,
    );
  }
});

/**
 * The model variant the copy's vectors were made with (the embedder holding the most vectors), run
 * as a non-local runtime: the app then starts no background backfill or GPU check, which would
 * write to the copy and, failing there, block searches.
 */
const searchEmbedder = () => {
  const db = new DatabaseSync(join(storage, "agent.db"), { readOnly: true });
  const top = Schema.decodeUnknownSync(
    Schema.Array(Schema.Struct({ embedder: Schema.String, n: Schema.Number })),
  )(
    db
      .prepare(
        "SELECT embedder, count(*) AS n FROM node_vectors GROUP BY embedder ORDER BY n DESC LIMIT 1",
      )
      .all(),
  )[0]!;
  db.close();
  const variant = top.embedder.includes("@fp32/") ? "fp32" : "quint8";
  console.log(`embedder ${top.embedder} (${top.n} vectors) -> ${variant}`);
  return Layer.effect(
    Embedder,
    Effect.gen(function* () {
      const embedder = yield* Embedder;
      if (embedder.identity !== top.embedder)
        return yield* Effect.die(`embedder ${embedder.identity} does not match the copy`);
      const vectorBytes = embedder.dimensions * 4;
      return {
        ...embedder,
        runtime: () => EmbedderRuntime.other(),
        // Scoring repeats the same queries across tuning candidates; embeddings are cached in the
        // copy, keyed by the exact text, so later candidate runs skip the model.
        embed: (texts) =>
          Effect.gen(function* () {
            const cached = texts.map((text): Option.Option<Float32Array> => {
              const vector = embedCache.get(text);
              if (vector === undefined) return Option.none();
              const bytes = Buffer.from(vector, "base64");
              if (bytes.length !== vectorBytes) return Option.none();
              return Option.some(
                new Float32Array(
                  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
                ),
              );
            });
            const missing = texts.filter((_, index) => Option.isNone(cached[index]));
            if (missing.length === 0) return cached.map(Option.getOrThrow);
            const computed = yield* embedder.embed(missing);
            const entries = missing.map((text, index) => ({
              text,
              vector: Buffer.from(
                computed[index]!.buffer,
                computed[index]!.byteOffset,
                computed[index]!.byteLength,
              ).toString("base64"),
            }));
            appendFileSync(
              embedCacheFile,
              entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
            );
            entries.forEach((entry) => embedCache.set(entry.text, entry.vector));
            const computedByText = new Map(
              missing.map((text, index) => [text, computed[index]!] as const),
            );
            return texts.map((text, index) =>
              Option.isSome(cached[index])
                ? Option.getOrThrow(cached[index])
                : computedByText.get(text)!,
            );
          }),
      };
    }),
  ).pipe(Layer.provide(Embedder.localVariant(variant)), Layer.provide(StorageRoot.layer(storage)));
};

if (mode === "build") build();
else {
  // Inside the copy: the sandbox may refuse the system temp folder.
  const home = join(storage, "eval-home");
  mkdirSync(home, { recursive: true });
  // The evaluation's tuning override is only present when --tuning was given
  // (exactOptionalPropertyTypes), so the two shapes are built whole.
  const baseOptions: import("../src/layers.ts").MemoryAgentLayerOptions = {
    embedder: searchEmbedder(),
    interpretAutomatically: false,
    summarizeAutomatically: false,
    importsWatching: false,
    importsHome: home,
    sweepSecrets: false,
    secrets: SecretStore.memory,
    skillsHome: home,
  };
  const layerOptions: import("../src/layers.ts").MemoryAgentLayerOptions =
    tuning === undefined ? baseOptions : { ...baseOptions, searchTuning: tuning };
  await runNativeEffect(
    Effect.scoped(
      Effect.flatMap(Layer.build(memoryAgentLayer(storage, layerOptions)), (services) =>
        Effect.provideContext(
          Effect.andThen(
            Console.log(
              "| label | group | n | failed | degraded | MRR | Recall@5 | Recall@12 | Recall@16 |\n|---|---|---|---|---|---|---|---|---|",
            ),
            score,
          ),
          services,
        ),
      ),
    ),
  );
}
