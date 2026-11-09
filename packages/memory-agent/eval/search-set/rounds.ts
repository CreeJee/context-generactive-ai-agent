/**
 * Needs written from past rounds. A round is one run that answered one user message. Rounds are
 * drawn evenly across age (how long before the copy's last node) and language, in an order fixed by
 * a hash of the run id, so a larger run keeps the rounds a smaller one drew. The model reads the
 * user's message and the answer and writes what someone might ask later to find it again: a full
 * question and a short search query, both searched for the same need.
 */
import {
  Array as Arr,
  Console,
  DateTime,
  Effect,
  HashSet,
  Iterable,
  Match,
  Option,
  Order,
  Schema,
} from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { namesSomethingExactly } from "../../src/memory/search.ts";
import { sha256 } from "../../src/runtime/synchronous-crypto.ts";
import { ageBandOf, appendRows, languageOf, type Need, readRows, setFiles } from "./files.ts";
import { answerObject, EvalModel } from "./model.ts";

const RoundNode = Schema.Struct({
  id: Schema.String,
  run_id: Schema.String,
  project_id: Schema.String,
  kind: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  created_at: Schema.String,
});
type RoundNode = typeof RoundNode.Type;

/** A user message shorter than this is a nudge such as "continue", not something to recall. */
const minUserCharacters = 20;
/** Longer user messages are pasted logs or documents more than requests. */
const maxUserCharacters = 4_000;
/** An answer shorter than this says too little to ask about. */
const minAnswerCharacters = 80;
const shownUserCharacters = 1_500;
const shownAnswerCharacters = 3_000;
const dayMs = 86_400_000;

const Written = Schema.Struct({
  question: Schema.NonEmptyString,
  keywords: Schema.NonEmptyString,
});
const Skipped = Schema.Struct({ skip: Schema.Literal(true) });

const instructions = `You write test questions for a memory search over a person's past conversations with a coding agent.

You get one past exchange: the user's message and the agent's answer. Write what the person might ask much later, in a new conversation, to find this exchange again.

Rules:
- The exchange must hold the answer. Ask about the specific decision, fact, fix, finding or result it contains, not a general topic.
- Write as someone who remembers the gist but not the wording. Do not copy phrases of three or more words from the exchange. Names a person would remember (files, functions, commands, tools, error codes) may be used as they are.
- Write in the language the user wrote in.
- "question" is a full question. "keywords" is what the person would type into a search box: two to six words.

Answer with JSON only: {"question": "...", "keywords": "..."}
If the exchange holds nothing worth finding later (a greeting, "continue", an acknowledgement, a failed or empty answer), answer {"skip": true}.`;

/** One candidate round: its user message and the answer the model reads. */
interface Round {
  readonly run: string;
  readonly projectId: string;
  readonly user: RoundNode;
  readonly answer: RoundNode;
  readonly ageDays: number;
  readonly stratum: string;
  readonly order: string;
}

const millisOf = (iso: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(iso));

/** The rounds that can be asked about, from runs with exactly one user message. */
const candidateRounds = Effect.fn("searchSet.candidateRounds")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const nodes = yield* SqlSchema.findAll({
    Request: Schema.Void,
    Result: RoundNode,
    execute: () => sql`
      SELECT id, run_id, project_id, kind, text, created_at FROM nodes
      WHERE run_id IS NOT NULL AND kind IN ('user', 'assistant') ORDER BY seq`,
  })(undefined);
  const { at } = yield* SqlSchema.findOne({
    Request: Schema.Void,
    Result: Schema.Struct({ at: Schema.String }),
    execute: () => sql`SELECT max(created_at) AS at FROM nodes`,
  })(undefined);
  const last = millisOf(at);
  return Object.values(Arr.groupBy(nodes, (node) => node.run_id)).flatMap(
    (run): ReadonlyArray<Round> => {
      const users = run.filter((node) => node.kind === "user");
      // The final answer, which usually sums the round up.
      const answer = Arr.findLast(
        run,
        (node) => node.kind === "assistant" && node.text.trim().length >= minAnswerCharacters,
      );
      const user = Option.filter(
        Arr.head(users),
        (user) =>
          users.length === 1 &&
          user.text.length >= minUserCharacters &&
          user.text.length <= maxUserCharacters,
      );
      return Option.toArray(
        Option.zipWith(user, answer, (user, answer) => {
          const ageDays = (last - millisOf(user.created_at)) / dayMs;
          return {
            run: user.run_id,
            projectId: user.project_id,
            user,
            answer,
            ageDays,
            stratum: `${ageBandOf(ageDays)}/${languageOf(user.text)}`,
            order: sha256(user.run_id),
          };
        }),
      );
    },
  );
});

/** Takes rounds from the strata in turn, each in hash order, until `count` are taken. */
const drawn = (rounds: ReadonlyArray<Round>, count: number) => {
  const strata = Object.values(Arr.groupBy(rounds, (round) => round.stratum)).map((stratum) =>
    Arr.sort(
      stratum,
      Order.mapInput(Order.String, (round: Round) => round.order),
    ),
  );
  return Arr.makeBy(Math.max(0, ...strata.map((stratum) => stratum.length)), (depth) =>
    strata.flatMap((stratum) => stratum.slice(depth, depth + 1)),
  )
    .flat()
    .slice(0, count);
};

/** What the model made of one round. */
type Reply =
  | { readonly _tag: "Written"; readonly question: string; readonly keywords: string }
  | { readonly _tag: "Skipped" };

const replyOf = (text: string): Option.Option<Reply> =>
  Option.orElse(
    Option.map(answerObject(Written)(text), (written) => ({
      _tag: "Written" as const,
      ...written,
    })),
    () => Option.as(answerObject(Skipped)(text), { _tag: "Skipped" as const }),
  );

export interface RoundsInput {
  readonly storage: string;
  /** Rounds in all, counting those already written or skipped. */
  readonly count: number;
  readonly concurrency: number;
}

/**
 * Writes needs for `count` rounds in all. Rounds the model could not answer for are left for the
 * next run.
 */
export const writeRounds = Effect.fn("searchSet.rounds")(function* ({
  storage,
  count,
  concurrency,
}: RoundsInput) {
  const model = yield* EvalModel;
  const files = setFiles(storage);
  const rounds = drawn(yield* candidateRounds(), count);
  const done = HashSet.fromIterable(
    Iterable.appendAll(
      Iterable.map(yield* readRows(files.needs), (need) => need.need),
      Iterable.map(yield* readRows(files.skippedRounds), ({ round }) => `round:${round}`),
    ),
  );
  const pending = rounds.filter((round) => !HashSet.has(done, `round:${round.run}`));
  yield* Console.log(`rounds drawn ${rounds.length}; to write ${pending.length}`);

  const write = (round: Round, question: string, keywords: string) =>
    Effect.gen(function* () {
      const need: Need = {
        need: `round:${round.run}`,
        kind: "round",
        description: question,
        projectId: round.projectId,
        crossProject: true,
        beforeSeq: null,
        known: [round.user.id, round.answer.id],
        ageDays: Math.round(round.ageDays * 10) / 10,
      };
      yield* appendRows(files.needs)([need]);
      yield* appendRows(files.items)(
        (
          [
            ["question", question],
            ["keywords", keywords],
          ] as const
        ).map(([style, query]) => ({
          item: `${need.need}:${style}`,
          need: need.need,
          style,
          query,
          language: languageOf(query),
          exact: namesSomethingExactly(query),
        })),
      );
      return "written" as const;
    });

  const outcomes = yield* Effect.forEach(
    pending,
    (round) =>
      model
        .ask(
          instructions,
          `The user's message:\n${round.user.text.slice(0, shownUserCharacters)}\n\nThe agent's answer:\n${round.answer.text.slice(0, shownAnswerCharacters)}`,
        )
        .pipe(
          Effect.map(Option.flatMap(replyOf)),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed("unanswered" as const),
              onSome: (reply) =>
                Match.valueTags(reply, {
                  Written: ({ question, keywords }) => write(round, question, keywords),
                  Skipped: () =>
                    Effect.as(
                      appendRows(files.skippedRounds)([{ round: round.run }]),
                      "skipped" as const,
                    ),
                }),
            }),
          ),
        ),
    { concurrency },
  );
  const tally = (outcome: (typeof outcomes)[number]) =>
    Arr.countBy(outcomes, (each) => each === outcome);
  yield* Console.log(
    `written ${tally("written")}; skipped ${tally("skipped")}; unanswered ${tally("unanswered")}`,
  );
});
