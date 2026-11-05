/**
 * Needs and items from recorded find_memory calls. Each distinct query is a `find` need; the three
 * user statements before the call are a `recall` need, as automatic recall would search them. Only
 * nodes stored before the call existed then, so the call's seq bounds what counts. The nodes the
 * model opened from the result (read_evidence or trace_evidence before its next search) are kept as
 * known nodes: the judge grades them with the rest, and they show how often it agrees.
 */
import { Array as Arr, Console, Effect, HashMap, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { namesSomethingExactly } from "../../src/memory/search.ts";
import { appendRows, languageOf, type Need, readRows, setFiles, textId } from "./files.ts";
import { nodeSeqs } from "./nodes.ts";

const Call = Schema.Struct({
  seq: Schema.Finite,
  run_id: Schema.String,
  session_id: Schema.String,
  project_id: Schema.String,
  text: Schema.String,
  tool: Schema.String,
  result: Schema.NullOr(Schema.String),
});
type Call = typeof Call.Type;
const FindArguments = Schema.Struct({
  query: Schema.String,
  crossProject: Schema.optional(Schema.Boolean),
});
const OpenArguments = Schema.Struct({ id: Schema.String });
const ResultIds = Schema.Struct({ matches: Schema.Array(Schema.Struct({ id: Schema.String })) });
const uuid = /"id"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/gu;

/** Longest recall query, as automatic recall cuts the joined statements. */
const recallCharacters = 6_000;
/** The user's message shown to the judge next to a find query. */
const contextCharacters = 1_500;

/** The JSON object after the tool name in a recorded call, or none when it is not one. */
const argumentsOf =
  <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
  (call: Call): Option.Option<S["Type"]> =>
    Schema.decodeOption(Schema.fromJsonString(schema))(call.text.slice(call.text.indexOf(" ") + 1));

/** The node ids a find_memory result listed: parsed, or every id in the text when it is cut. */
const resultIds = (text: string) =>
  Option.match(Schema.decodeOption(Schema.fromJsonString(ResultIds))(text), {
    onSome: (result) => result.matches.map((match) => match.id),
    onNone: () => [...text.matchAll(uuid)].map((match) => match[1]!),
  });

/** The nodes the model opened after the call at `index`, before its next search in the run. */
const openedAfter = (runCalls: ReadonlyArray<Call>, index: number) =>
  Arr.takeWhile(runCalls.slice(index + 1), (later) => later.tool !== "find_memory").flatMap(
    (later) => Option.toArray(argumentsOf(OpenArguments)(later)).map(({ id }) => id),
  );

/** A recorded search: the call, what it asked, and the nodes it listed that the model opened. */
interface Search {
  readonly call: Call;
  readonly query: string;
  readonly crossProject: boolean;
  readonly opened: ReadonlyArray<string>;
}

export const buildRecorded = Effect.fn("searchSet.recorded")(function* (storage: string) {
  const sql = yield* SqlClient.SqlClient;
  const files = setFiles(storage);
  const calls = yield* SqlSchema.findAll({
    Request: Schema.Void,
    Result: Call,
    execute: () => sql`
      SELECT c.seq, c.run_id, c.session_id, c.project_id, c.text,
        json_extract(c.detail, '$.toolName') AS tool,
        (SELECT r.text FROM nodes r WHERE r.session_id = c.session_id AND r.kind = 'tool_result'
          AND json_extract(r.detail, '$.toolCallId') = json_extract(c.detail, '$.toolCallId')
          LIMIT 1) AS result
      FROM nodes c WHERE c.kind = 'tool_call' AND c.run_id IS NOT NULL
        AND json_extract(c.detail, '$.toolName') IN ('find_memory', 'read_evidence', 'trace_evidence')
      ORDER BY c.seq`,
  })(undefined);
  const usersBefore = SqlSchema.findAll({
    Request: Call,
    Result: Schema.Struct({ text: Schema.String }),
    execute: (call) => sql`
      SELECT text FROM nodes WHERE session_id = ${call.session_id} AND kind = 'user'
        AND seq < ${call.seq} ORDER BY seq DESC LIMIT 3`,
  });
  const searches = Object.values(Arr.groupBy(calls, (call) => call.run_id)).flatMap((runCalls) =>
    runCalls.flatMap((call, index): ReadonlyArray<Search> => {
      if (call.tool !== "find_memory") return [];
      const listed = new Set(call.result === null ? [] : resultIds(call.result));
      return Option.toArray(argumentsOf(FindArguments)(call))
        .filter((input) => input.query.trim().length > 0)
        .map((input) => ({
          call,
          query: input.query,
          crossProject: input.crossProject ?? true,
          opened: openedAfter(runCalls, index).filter((id) => listed.has(id)),
        }));
    }),
  );
  const seqs = yield* nodeSeqs(searches.flatMap((search) => search.opened));
  /** The nodes that existed before `seq`, of those given. */
  const storedBefore = (ids: ReadonlyArray<string>, seq: number) =>
    Arr.dedupe(
      ids.filter((id) =>
        Option.match(HashMap.get(seqs, id), { onNone: () => false, onSome: (at) => at < seq }),
      ),
    );
  const made = yield* Effect.forEach(searches, (search) =>
    Effect.map(usersBefore(search.call), (users) => {
      const { call, query, crossProject } = search;
      const statements = users
        .map((user) => user.text)
        .reverse()
        .join("\n")
        .slice(0, recallCharacters);
      const base = {
        projectId: call.project_id,
        crossProject,
        beforeSeq: call.seq,
        known: storedBefore(search.opened, call.seq),
        ageDays: null,
      };
      const find: Need = {
        ...base,
        need: `find:${textId(`${call.project_id}\u0000${query}`)}`,
        kind: "find",
        description: Option.match(Arr.head(users), {
          onNone: () => `Query: ${query}`,
          onSome: (user) =>
            `Query: ${query}\n\nThe user's message the agent was working on:\n${user.text.slice(0, contextCharacters)}`,
        }),
      };
      const recall: Need = {
        ...base,
        need: `recall:${textId(`${call.project_id}\u0000${statements}`)}`,
        kind: "recall",
        description: statements,
      };
      return [
        { need: find, query },
        // Without a statement before the call there is nothing to recall from.
        ...(users.length === 0 ? [] : [{ need: recall, query: statements }]),
      ];
    }),
  );
  // One need per distinct text and project: the earliest call asks it; the nodes opened by the
  // later calls that existed by then are known too.
  const needs = Object.values(Arr.groupBy(made.flat(), ({ need }) => need.need)).map((group) => {
    const first = group[0];
    return {
      need: {
        ...first.need,
        known: storedBefore(
          group.flatMap(({ need }) => need.known),
          first.need.beforeSeq ?? Infinity,
        ),
      },
      query: first.query,
    };
  });
  const existing = new Set((yield* readRows(files.needs)).map((need) => need.need));
  const added = needs.filter(({ need }) => !existing.has(need.need));
  yield* appendRows(files.needs)(added.map(({ need }) => need));
  yield* appendRows(files.items)(
    added.map(({ need, query }) => ({
      item: need.need,
      need: need.need,
      style: need.kind === "find" ? ("find" as const) : ("recall" as const),
      query,
      language: languageOf(query),
      exact: namesSomethingExactly(query),
    })),
  );
  const count = (kind: Need["kind"]) => needs.filter(({ need }) => need.kind === kind).length;
  yield* Console.log(
    `find_memory calls ${searches.length}; needs find ${count("find")} recall ${count("recall")}; ` +
      `added ${added.length}; with known nodes ${needs.filter(({ need }) => need.known.length > 0).length}`,
  );
});
