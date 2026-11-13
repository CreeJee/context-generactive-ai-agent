import { Option, Schema } from "effect";

const TokenUnit = Schema.Literals(["", "k", "m"]);
const isTokenUnit = Schema.is(TokenUnit);
/**
 * Token counts in binary units, as model context windows are named: 128K is 131,072 tokens and 1M
 * is 1,048,576.
 */
const units = { "": 1, k: 1024, m: 1024 * 1024 } satisfies Record<typeof TokenUnit.Type, number>;

const tokenCountPattern = /^(\d+(?:\.\d+)?)\s*([km]?)$/;

/**
 * Reads a token count typed as digits (commas allowed) or with a `K`/`M` suffix, such as `128k`
 * or `1.5M`. Text that is not a count of tokens reads as none.
 */
export const parseTokenCount = (text: string): Option.Option<number> =>
  Option.fromNullishOr(tokenCountPattern.exec(text.trim().replaceAll(",", "").toLowerCase())).pipe(
    Option.flatMap(([, amount, unit]) =>
      Option.map(Option.liftPredicate(unit ?? "", isTokenUnit), (known) =>
        Math.round(Number(amount) * units[known]),
      ),
    ),
    Option.filter(Number.isSafeInteger),
  );

/** The shortest exact name of a token count: `128K` or `1M` when it divides evenly, else digits. */
export const formatTokenCount = (count: number): string =>
  count >= units.m && count % units.m === 0
    ? `${count / units.m}M`
    : count >= units.k && count % units.k === 0
      ? `${count / units.k}K`
      : count.toLocaleString("ko-KR");
