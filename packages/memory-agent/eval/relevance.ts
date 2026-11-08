/**
 * Relevance set made from real use, and its score, on a copy of a real memory storage folder.
 *
 *   node --no-warnings eval/relevance.ts build <storage copy>   writes <storage copy>/relevance.jsonl
 *   node --no-warnings eval/relevance.ts score <storage copy> [--label <name>] [--group find|recall]
 *       [--tuning <json>] [--dump <file> [--resume]]
 *
 * The storage copy holds agent.db, vectors/ and models/ like ~/.context-generactive-agent. It is
 * opened as the app opens its own: the search under test is MemorySearch.find with the local
 * embedder and the lexical index. The set and anything holding memory text stay inside the copy, which is
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
import { Array as Arr, Console, Effect, FileSystem, Layer, Option, Schema } from "effect";
import { copyLayer } from "./copy-storage.ts";
import { MemorySearch, searchTuning, type SearchTuning } from "../src/memory/search.ts";
import { nodePlatform } from "../src/runtime/node-platform.ts";
import { sha256 } from "../src/runtime/synchronous-crypto.ts";
import { path } from "../src/runtime/synchronous-path.ts";

const Item = Schema.Struct({
  group: Schema.Literals(["find", "recall"]),
  query: Schema.String,
  projectId: Schema.String,
  crossProject: Schema.Boolean,
  limit: Schema.Finite,
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
          Object.entries(
            await Effect.runPromise(
              Schema.decodeEffect(Schema.fromJsonString(TuningOverride))(tuningJson),
            ),
          ).filter(([, value]) => value !== undefined),
        ),
      };
const resume = argv.includes("--resume");
const [mode, storage] = argv;
if ((mode !== "build" && mode !== "score") || storage === undefined) {
  await Effect.runPromise(
    Console.error(
      "usage: relevance.ts build|score <storage copy> [--label <name>] [--group <g>] " +
        "[--tuning <json>] [--dump <file> [--resume]]",
    ),
  );
  process.exit(2);
}
const setFile = path.join(storage, "relevance.jsonl");

/** The lines of `text` that decode as `schema`: blank lines and a torn final line are skipped. */
const decodedLines = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  text: string,
) => {
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(schema));
  return Effect.map(
    Effect.forEach(text.split("\n"), (line) => Effect.option(decode(line))),
    Arr.getSomes,
  );
};

const Call = Schema.Struct({
  id: Schema.String,
  seq: Schema.Finite,
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

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/** Identifies a dumped row's query without carrying its text: memory text stays in the copy. */
const querySha = (query: string) => sha256(query).slice(0, 12);

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

const build = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const db = new DatabaseSync(path.join(storage, "agent.db"), { readOnly: true });
  const calls = yield* Schema.decodeUnknownEffect(Schema.Array(Call))(
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
  yield* Effect.forEach(
    calls,
    (call, index) =>
      Effect.gen(function* () {
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
        const users = yield* Schema.decodeUnknownEffect(UserText)(
          usersBefore.all(call.session_id, call.seq),
        );
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
      }),
    { discard: true },
  );
  // One item per distinct query and project; the later call's opened nodes win.
  const unique = [
    ...new Map(
      items.map((item) => [`${item.group}\u0000${item.projectId}\u0000${item.query}`, item]),
    ).values(),
  ];
  const lines = yield* Effect.forEach(unique, (item) => encodeJson(item));
  yield* fs.writeFileString(setFile, lines.join("\n") + "\n");
  const count = (group: string) => Arr.countBy(unique, (item) => item.group === group);
  yield* Console.log(yield* encodeJson(seen));
  yield* Console.log(
    `find_memory calls ${Arr.countBy(calls, (call) => call.tool === "find_memory")}; items find ${count("find")} recall ${count("recall")}; relevant per item ${(unique.reduce((sum, item) => sum + item.relevant.length, 0) / Math.max(1, unique.length)).toFixed(2)}`,
  );
  db.close();
});

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
  reciprocal: Schema.Finite,
  at5: Schema.Finite,
  at12: Schema.Finite,
  at16: Schema.Finite,
});

/** A dump line: the run's label and the row, no memory text. */
const dumpLine = (row: DumpRow) => JSON.stringify({ label, ...row }) + "\n";

const score = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  // A killed run's dump rows are kept: --resume skips the items the dump already holds and
  // appends after them; without it the dump starts over.
  const DumpedKey = Schema.Struct({ group: Schema.String, query: Schema.String });
  const dumped =
    resume && dumpFile !== undefined
      ? yield* fs.readFileString(dumpFile).pipe(
          // Nothing dumped yet.
          Effect.orElseSucceed(() => ""),
          Effect.flatMap((text) => decodedLines(DumpedKey, text)),
        )
      : [];
  const doneKeys = new Set(dumped.map((row) => `${row.group}|${row.query}`));
  const decodeItem = Schema.decodeUnknownEffect(Schema.fromJsonString(Item));
  const items = (yield* Effect.forEach(
    (yield* fs.readFileString(setFile)).split("\n").filter((line) => line.trim().length > 0),
    (line) => decodeItem(line),
  )).filter(
    (item) =>
      (onlyGroup === undefined || item.group === onlyGroup) &&
      !doneKeys.has(`${item.group}|${querySha(item.query)}`),
  );
  const search = yield* MemorySearch;
  // Rows land in the dump as they finish: a long run shows progress, and a killed run keeps
  // the rows it already scored. Memory text stays out: ids and scores only.
  const dump = (row: DumpRow) =>
    dumpFile === undefined
      ? Effect.void
      : fs.writeFileString(dumpFile, dumpLine(row), { flag: "a" });
  if (dumpFile !== undefined && !resume) yield* fs.writeFileString(dumpFile, "");
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
              Arr.countBy(item.relevant, (id) => ids.slice(0, k).includes(id)) /
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
          Effect.tap(dump),
        ),
    { concurrency },
  );
  const mean = (values: readonly number[]) =>
    (values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)).toFixed(3);
  // A resumed run scored only its remaining items; the table reads the whole dump instead (the
  // last row per query wins, a torn final line is skipped), so it stays the set's score.
  const summaryRows = new Map<string, ScoredRow>(
    (dumpFile === undefined
      ? rows
      : yield* decodedLines(DumpedRow, yield* fs.readFileString(dumpFile))
    ).map((row) => [`${row.group}|${row.query}`, row] as const),
  );
  for (const group of new Set([...summaryRows.values()].map((row) => row.group))) {
    const selected = [...summaryRows.values()].filter((row) => row.group === group);
    yield* Console.log(
      `| ${label} | ${group} | ${selected.length} | ${Arr.countBy(selected, (row) => row.failed)} | ${Arr.countBy(selected, (row) => row.degraded.length > 0)} | ${mean(selected.map((row) => row.reciprocal))} | ${mean(selected.map((row) => row.at5))} | ${mean(selected.map((row) => row.at12))} | ${mean(selected.map((row) => row.at16))} |`,
    );
  }
});

if (mode === "build") await nodePlatform.runPromise(build);
else
  await nodePlatform.runPromise(
    Effect.scoped(
      Effect.flatMap(
        Layer.build(copyLayer({ storage, tuning: Option.fromNullishOr(tuning), reranker: false })),
        (services) =>
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
