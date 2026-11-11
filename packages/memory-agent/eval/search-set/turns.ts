/**
 * Needs in the shape of the turn path's memory lookup. When a run's context is compacted, the app
 * looks up memory with the latest user statements: the turn first, then the ones before it,
 * joined and cut at 6,000 characters (`retrievalAppendix` in src/agent/chat.ts; a workflow run also
 * adds its goal and plan, which the copy does not keep per turn). That lookup reranks with the same
 * query, and so does the memory lead for an external agent (the turn alone).
 *
 * A query as long as the reranker reads is the case its pair cut decides, and the recorded `recall`
 * needs rarely have one (their statements are mostly short). So turns are drawn in two groups:
 * `any` turn, and `long` turns whose query is longer than the reranker reads. Each turn is a `recall`
 * need (the judge reads the statements, latest last) with one `turn` item, the app's query. The
 * memory is what was stored before the first node of the turn's run. Turns are drawn in an order
 * fixed by a hash of the user node's id, at most one per session over both groups.
 */
import { Array as Arr, Console, Effect, HashSet, Iterable, Option, Order, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { rerankModel } from "../../src/memory/rerank/reranker.ts";
import { namesSomethingExactly } from "../../src/memory/search.ts";
import { sha256 } from "../../src/runtime/synchronous-crypto.ts";
import { appRerankTokenizer } from "./app-reranker.ts";
import { appendRows, languageOf, type Need, readRows, setFiles, textId } from "./files.ts";
import { statementsBefore } from "./nodes.ts";

/** The longest lookup query, as the app cuts the joined statements. */
const queryCharacters = 6_000;

/**
 * The turn path's query from the statements, oldest first: the latest statement, then the others
 * in order, each once.
 */
export const turnQuery = (statements: ReadonlyArray<string>) =>
  Arr.dedupe([...statements.slice(-1), ...statements.slice(0, -1)])
    .filter((text) => text.length > 0)
    .join("\n")
    .slice(0, queryCharacters);

/** The recall need's description: the statements, latest last, as recorded needs write it. */
export const statementsText = (statements: ReadonlyArray<string>) =>
  statements.join("\n").slice(0, queryCharacters);

const Turn = Schema.Struct({
  id: Schema.String,
  session_id: Schema.String,
  project_id: Schema.String,
  /** The first node the turn's run stored after it. */
  next_seq: Schema.Finite,
});
type Turn = typeof Turn.Type;

export interface TurnsInput {
  readonly storage: string;
  /** Turns drawn from all turns. */
  readonly any: number;
  /** Turns drawn from those whose query is longer than the reranker reads. */
  readonly long: number;
}

export const writeTurns = Effect.fn("searchSet.turns")(function* ({
  storage,
  any,
  long,
}: TurnsInput) {
  const sql = yield* SqlClient.SqlClient;
  const files = setFiles(storage);
  const turns = Arr.sort(
    yield* SqlSchema.findAll({
      Request: Schema.Void,
      Result: Turn,
      execute: () => sql`
        SELECT u.id, u.session_id, u.project_id, min(n.seq) AS next_seq
        FROM nodes u JOIN nodes n ON n.run_id = u.run_id AND n.seq > u.seq
        WHERE u.kind = 'user' AND u.run_id IS NOT NULL
        GROUP BY u.id`,
    })(undefined),
    Order.mapInput(Order.String, (turn: Turn) => sha256(turn.id)),
  );
  const tokenizer = yield* appRerankTokenizer(storage);
  const queryTokens = (query: string) =>
    tokenizer.encode(query, { add_special_tokens: false }).length;
  const existing = HashSet.fromIterable(
    Iterable.map(yield* readRows(files.needs), (need) => need.need),
  );

  /** One turn's need and item, when it has statements. */
  const made = (turn: Turn) =>
    Effect.map(statementsBefore(turn.next_seq), (statements) => {
      const query = turnQuery(statements);
      const description = statementsText(statements);
      const need: Need = {
        need: `recall:${textId(`${turn.project_id}\u0000${description}`)}`,
        kind: "recall",
        description,
        projectId: turn.project_id,
        // The user's setting reads other projects in the turn path's lookup.
        crossProject: true,
        beforeSeq: turn.next_seq,
        known: [],
        ageDays: null,
      };
      return Option.liftPredicate(
        {
          need,
          query,
          item: {
            item: `turn:${textId(`${turn.project_id}\u0000${query}`)}`,
            need: need.need,
            style: "turn" as const,
            query,
            language: languageOf(query),
            exact: namesSomethingExactly(query),
          },
          long: queryTokens(query) > rerankModel.maxTokens,
        },
        () => query.length > 0,
      );
    });

  // Hash order, one turn per session, until both groups are full: `any` takes every turn it meets
  // until it is full, `long` the long ones after that. A turn drawn by an earlier run is drawn again
  // and counted, but not written twice.
  const drawn = yield* Effect.forEach(turns, (turn) =>
    Effect.map(
      made(turn),
      Option.map((each) => ({ turn, ...each })),
    ),
  ).pipe(
    Effect.map(Arr.getSomes),
    Effect.map((candidates) =>
      Arr.mapAccum(
        candidates,
        { sessions: HashSet.empty<string>(), any: 0, long: 0 },
        (state, candidate) => {
          const group = HashSet.has(state.sessions, candidate.turn.session_id)
            ? Option.none()
            : state.any < any
              ? Option.some("any" as const)
              : candidate.long && state.long < long
                ? Option.some("long" as const)
                : Option.none();
          return Option.match(group, {
            onNone: () => [state, Option.none()] as const,
            onSome: (taken) =>
              [
                {
                  sessions: HashSet.add(state.sessions, candidate.turn.session_id),
                  any: state.any + (taken === "any" ? 1 : 0),
                  long: state.long + (taken === "long" ? 1 : 0),
                },
                Option.some({ ...candidate, group: taken }),
              ] as const,
          });
        },
      ),
    ),
    Effect.map(([, taken]) => Arr.getSomes(taken)),
  );
  const fresh = drawn.filter(({ need }) => !HashSet.has(existing, need.need));
  yield* appendRows(files.needs)(fresh.map(({ need }) => need));
  yield* appendRows(files.items)(fresh.map(({ item }) => item));
  yield* Console.log(
    `turns ${turns.length}; drawn any ${Arr.countBy(drawn, (each) => each.group === "any")} ` +
      `(longer than the reranker reads ${Arr.countBy(drawn, (each) => each.group === "any" && each.long)}), ` +
      `long ${Arr.countBy(drawn, (each) => each.group === "long")}; added ${fresh.length}`,
  );
});
