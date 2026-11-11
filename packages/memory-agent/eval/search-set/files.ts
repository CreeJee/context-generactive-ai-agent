/**
 * The search evaluation set's files, kept in the storage copy (outside git) with the memory text
 * they are made from. Every file is JSON lines, appended as work finishes, so a stopped step picks
 * up where it left off.
 *
 *   search-set/needs.jsonl       what someone wanted to find (the judge reads its description)
 *   search-set/items.jsonl       queries sent to a search; several items can share one need
 *   search-set/judgments.jsonl   one grade per need and node, from the model judge
 *   search-set/runs/<name>.jsonl one ranked list of node ids per item, from one search system
 *   search-set/slices.jsonl      more slices items are scored in (see `ItemSlice`)
 */
import { Array as Arr, Effect, FileSystem, Option, Schema } from "effect";
import { sha256 } from "../../src/runtime/synchronous-crypto.ts";
import { path } from "../../src/runtime/synchronous-path.ts";

/** The language a text is mostly written in: Hangul, Latin script, or both in good measure. */
export const Language = Schema.Literals(["ko", "en", "mixed"]);
export type Language = typeof Language.Type;

export const languageOf = (text: string): Language => {
  const hangul = text.match(/[가-힣]/gu)?.length ?? 0;
  const latin = text.match(/[A-Za-z]/gu)?.length ?? 0;
  return hangul > latin ? "ko" : latin > 3 * hangul ? "en" : "mixed";
};

/** How long before the copy's last node a round happened, in bands. */
const ageBands = [
  { band: "week", below: 7 },
  { band: "month", below: 30 },
  { band: "quarter", below: 90 },
  { band: "older", below: Infinity },
] as const;

export const ageBandOf = (days: number) =>
  Option.getOrElse(
    Option.map(
      Arr.findFirst(ageBands, ({ below }) => days < below),
      ({ band }) => band,
    ),
    () => "older" as const,
  );

/**
 * What someone wanted to find. `find`: a recorded find_memory call; `recall`: the user's statements
 * before that call, as automatic recall would search them; `round`: a question the model judge
 * wrote from one past round (a user message and the answer to it).
 */
export const Need = Schema.Struct({
  need: Schema.String,
  kind: Schema.Literals(["find", "recall", "round"]),
  /** What the judge reads as the need. */
  description: Schema.String,
  projectId: Schema.String,
  crossProject: Schema.Boolean,
  /**
   * Only nodes stored before this seq existed when a recorded question was asked; null for a
   * written question, which is asked of the whole copy.
   */
  beforeSeq: Schema.NullOr(Schema.Finite),
  /** Nodes known to bear on it: those the model opened from the search, or the round's own. */
  known: Schema.Array(Schema.String),
  /** Days from the round to the copy's last node; null for recorded questions. */
  ageDays: Schema.NullOr(Schema.Finite),
});
export type Need = typeof Need.Type;

/**
 * One query sent to a search. `find` and `recall` are recorded text; `question` and `keywords` are
 * the two forms written for a round: a full question and a short search query. `turn` is the turn
 * path's lookup query for a recall need: the latest statement first, then the earlier ones.
 */
export const Item = Schema.Struct({
  item: Schema.String,
  need: Schema.String,
  style: Schema.Literals(["find", "recall", "question", "keywords", "turn"]),
  query: Schema.String,
  language: Language,
  /** The query names something exactly: a path, an identifier, a version, an error code. */
  exact: Schema.Boolean,
});
export type Item = typeof Item.Type;

/** 2: holds what the need asks for; 1: about the same matter and helps; 0: neither. */
export const Grade = Schema.Literals([0, 1, 2]);
export type Grade = typeof Grade.Type;

export const Judgment = Schema.Struct({
  need: Schema.String,
  node: Schema.String,
  grade: Grade,
  /** The model that graded it. */
  judge: Schema.String,
});
export type Judgment = typeof Judgment.Type;

/** One item's ranking from one search system; a failed search keeps its reason and no ids. */
export const RunRow = Schema.Struct({
  item: Schema.String,
  ids: Schema.Array(Schema.String),
  failed: Schema.optional(Schema.String),
});
export type RunRow = typeof RunRow.Type;

/** A slice an item is scored in besides those its item and need give, written by another step. */
export const ItemSlice = Schema.Struct({ item: Schema.String, slice: Schema.String });

/** A round the judge found nothing worth asking about, so a later run does not ask again. */
export const SkippedRound = Schema.Struct({ round: Schema.String });

/** A JSON lines file and the schema of its rows. */
export interface RowFile<
  S extends Schema.Top & {
    readonly DecodingServices: never;
    readonly EncodingServices: never;
  },
> {
  readonly schema: S;
  readonly path: string;
}

/** The set's files under the copy. */
export const setFiles = (storage: string) => {
  const root = path.join(storage, "search-set");
  return {
    root,
    needs: { schema: Need, path: path.join(root, "needs.jsonl") },
    items: { schema: Item, path: path.join(root, "items.jsonl") },
    judgments: { schema: Judgment, path: path.join(root, "judgments.jsonl") },
    skippedRounds: { schema: SkippedRound, path: path.join(root, "skipped-rounds.jsonl") },
    slices: { schema: ItemSlice, path: path.join(root, "slices.jsonl") },
    runs: path.join(root, "runs"),
    run: (name: string) => ({ schema: RunRow, path: path.join(root, "runs", `${name}.jsonl`) }),
    /** A second model's grades of pairs the main judge graded, by the model's name. */
    check: (model: string) => ({
      schema: Judgment,
      path: path.join(root, `judgments-check-${model.replaceAll(/[^A-Za-z0-9.-]+/gu, "_")}.jsonl`),
    }),
  };
};

/** A short stable id for a text: memory text never goes into ids or printed output. */
export const textId = (text: string) => sha256(text).slice(0, 12);

/**
 * The rows of a JSON lines file that decode; a missing file has none, and a torn last line (from a
 * stopped append) is skipped.
 */
export const readRows = <
  S extends Schema.Top & { readonly DecodingServices: never; readonly EncodingServices: never },
>(
  file: RowFile<S>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(file.path).pipe(
      // Not written yet.
      Effect.orElseSucceed(() => ""),
    );
    const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(file.schema));
    return Arr.getSomes(
      yield* Effect.forEach(
        text.split("\n").filter((line) => line.trim().length > 0),
        (line) => Effect.option(decode(line)),
      ),
    );
  });

/** Appends rows to a JSON lines file, creating its folder first. */
export const appendRows =
  <S extends Schema.Top & { readonly DecodingServices: never; readonly EncodingServices: never }>(
    file: RowFile<S>,
  ) =>
  (rows: ReadonlyArray<S["Type"]>) =>
    Effect.gen(function* () {
      if (rows.length === 0) return;
      const fs = yield* FileSystem.FileSystem;
      const encode = Schema.encodeEffect(Schema.fromJsonString(file.schema));
      const lines = yield* Effect.forEach(rows, (row) => encode(row));
      yield* fs.makeDirectory(path.dirname(file.path), { recursive: true });
      yield* fs.writeFileString(file.path, lines.map((line) => `${line}\n`).join(""), {
        flag: "a",
      });
    });
