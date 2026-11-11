import { Array as Arr, Option, Schema } from "effect";
import type { PreTrainedTokenizer } from "@huggingface/transformers";

/**
 * How a (query, text) pair longer than the model reads is cut to `maxTokens` tokens.
 *
 * - `head`: the joined pair `<s> query </s> text </s>` is cut at its end, as transformers.js cuts
 *   it. A query as long as the read leaves no room for the text, so every pair reads the same.
 * - `longest-first`: the longer side loses tokens first until both fit, and the special tokens stay.
 *   It is the strategy the reranker's own tokenizer files name (`truncation_strategy:
 *   longest_first`), which transformers.js does not apply: the shorter side keeps its tokens up to
 *   half the room, and the longer side gets the rest.
 * - `query-share`: the query keeps at most `share` of the room and the text gets the rest.
 */
export const PairCut = Schema.TaggedUnion({
  head: {},
  "longest-first": {},
  "query-share": { share: Schema.Finite },
});
export type PairCut = typeof PairCut.Type;

/** The special tokens the tokenizer puts around a pair's two sides. */
interface PairLayout {
  readonly prefix: ReadonlyArray<number>;
  readonly middle: ReadonlyArray<number>;
  readonly suffix: ReadonlyArray<number>;
}

const plainIds = (tokenizer: PreTrainedTokenizer, text: string) =>
  tokenizer.encode(text, { add_special_tokens: false });

/** The tokenizer's pair template, read from a pair of two one-token sides. */
const pairLayout = (tokenizer: PreTrainedTokenizer): PairLayout => {
  const [first] = plainIds(tokenizer, "a");
  const [second] = plainIds(tokenizer, "b");
  const pair = tokenizer.encode("a", { text_pair: "b" });
  const at = pair.indexOf(first!);
  const then = pair.indexOf(second!, at + 1);
  return {
    prefix: pair.slice(0, at),
    middle: pair.slice(at + 1, then),
    suffix: pair.slice(then + 1),
  };
};

/** The last whitespace in `text` up to position `chars`, when it is not the first character. */
const lastSpace = (text: string, chars: number) =>
  Option.filter(Option.some(text.slice(0, chars + 1).search(/\s\S*$/)), (at) => at > 0);

/**
 * The start of `text` that holds its first `tokens` tokens, or the whole text. It is cut before a
 * whitespace, where the tokenizer always ends a word, so its tokens are the whole text's first
 * ones. Lengths double from `tokens` characters, since a token holds at least one. Tokenizing a
 * whole 100 KB tool result took about a second, and 800 KB eight, while the model reads a pair's
 * first `maxTokens` tokens only.
 */
const leadingText = (tokenizer: PreTrainedTokenizer, tokens: number) => (text: string) =>
  Option.getOrElse(
    Arr.findFirst(
      Arr.unfold(tokens, (chars) =>
        chars < text.length ? Option.some([chars, chars * 2] as const) : Option.none(),
      ),
      (chars) =>
        Option.filter(
          Option.map(lastSpace(text, chars), (at) => text.slice(0, at)),
          (start) => plainIds(tokenizer, start).length >= tokens,
        ),
    ),
    () => text,
  );

/**
 * The lengths `longest-first` keeps of the two sides in `room` tokens, as the Hugging Face
 * tokenizers library computes them: the shorter side keeps up to half the room, the longer side the
 * rest.
 */
const longestFirst = (query: number, text: number, room: number) => {
  const shorter = Math.min(query, text, Math.floor(room / 2));
  return query + text <= room
    ? ([query, text] as const)
    : query <= text
      ? ([shorter, Math.min(text, room - shorter)] as const)
      : ([Math.min(query, room - shorter), shorter] as const);
};

/** The token ids the model reads of each (query, text) pair, special tokens included. */
export type PairTokens = (
  query: string,
  texts: ReadonlyArray<string>,
) => ReadonlyArray<ReadonlyArray<number>>;

/**
 * The token ids the model reads of each (query, text) pair, special tokens included, at most
 * `maxTokens` each. Only the first `maxTokens` tokens of either side can be read, so each side is
 * cut to the start that holds them before it is tokenized.
 */
export const pairTokens = ({
  tokenizer,
  maxTokens,
  cut,
}: {
  readonly tokenizer: PreTrainedTokenizer;
  readonly maxTokens: number;
  readonly cut: PairCut;
}): PairTokens => {
  const layout = pairLayout(tokenizer);
  const leading = leadingText(tokenizer, maxTokens);
  const room = maxTokens - layout.prefix.length - layout.middle.length - layout.suffix.length;
  /** Pairs of the two sides cut to the lengths `kept` gives for their token counts. */
  const assembled =
    (kept: (query: number, text: number) => readonly [number, number]): PairTokens =>
    (query, texts) => {
      const asked = plainIds(tokenizer, leading(query));
      return texts.map((text) => {
        const read = plainIds(tokenizer, leading(text));
        const [keptQuery, keptText] = kept(asked.length, read.length);
        return [
          ...layout.prefix,
          ...asked.slice(0, keptQuery),
          ...layout.middle,
          ...read.slice(0, keptText),
          ...layout.suffix,
        ];
      });
    };
  return PairCut.match(cut, {
    head: (): PairTokens => (query, texts) => {
      const question = leading(query);
      return texts.map((text) =>
        tokenizer.encode(question, { text_pair: leading(text) }).slice(0, maxTokens),
      );
    },
    "longest-first": () => assembled((query, text) => longestFirst(query, text, room)),
    "query-share": ({ share }) =>
      assembled((query, text) => {
        const kept = Math.min(query, Math.floor(room * share));
        return [kept, Math.min(text, room - kept)] as const;
      }),
  });
};

/** Pairs padded to the longest of them: the model's `input_ids` and `attention_mask`, row-major. */
export interface PaddedBatch {
  readonly ids: BigInt64Array;
  readonly mask: BigInt64Array;
  readonly dims: readonly [number, number];
}

/** One batch of pairs, each padded with `padId` to the longest. */
export const paddedBatch = ({
  pairs,
  padId,
}: {
  readonly pairs: ReadonlyArray<ReadonlyArray<number>>;
  readonly padId: number;
}): PaddedBatch => {
  const width = Math.max(0, ...pairs.map((pair) => pair.length));
  const cells = pairs.flatMap((pair) =>
    Arr.makeBy(width, (index) => (index < pair.length ? [pair[index]!, 1] : [padId, 0])),
  );
  return {
    ids: BigInt64Array.from(cells, ([id]) => BigInt(id!)),
    mask: BigInt64Array.from(cells, ([, read]) => BigInt(read!)),
    dims: [pairs.length, width],
  };
};
