import { Array as Arr, Effect, Option, Predicate, Schema } from "effect";
import { parseSync, Visitor } from "oxc-parser";

/** One piece of copy in a source file, with where it starts. */
export interface CopyText {
  readonly text: string;
  readonly line: number;
  readonly column: number;
}

/** The catalog file could not be parsed, so nothing in it was checked. */
export class CopyParseFailed extends Schema.TaggedError<CopyParseFailed>()("CopyParseFailed", {
  file: Schema.String,
  message: Schema.String,
}) {}

const hangul = /\p{Script=Hangul}/u;

/**
 * Stands in for a template expression, so `${count}개를 지웠어요` is read as one sentence. A Latin
 * letter keeps the morpheme analysis of the words around it unchanged.
 */
const placeholder = "X";

/** Line and column (both from 1) of an offset in `source`. */
function positionOf(source: string, offset: number): Pick<CopyText, "line" | "column"> {
  const before = source.slice(0, offset);
  const lineStart = before.lastIndexOf("\n") + 1;
  return { line: before.split("\n").length, column: offset - lineStart + 1 };
}

/**
 * Every string literal, template literal and JSX text in `source` that contains Hangul. A template
 * literal is read whole, with its expressions replaced by a placeholder.
 */
export const extractCopy = Effect.fnUntraced(function* (
  file: string,
  source: string,
): Effect.fn.Return<ReadonlyArray<CopyText>, CopyParseFailed> {
  const parsed = parseSync(file, source);
  const firstError = Arr.head(parsed.errors);
  if (Option.isSome(firstError)) {
    return yield* new CopyParseFailed({ file, message: firstError.value.message });
  }
  const texts: Array<CopyText> = [];
  const collect = (text: string, start: number) => {
    if (hangul.test(text)) texts.push({ text, ...positionOf(source, start) });
  };
  new Visitor({
    Literal(node) {
      if (Predicate.isString(node.value)) collect(node.value, node.start);
    },
    TemplateLiteral(node) {
      collect(
        node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join(placeholder),
        node.start,
      );
    },
    JSXText(node) {
      collect(node.value.trim(), node.start);
    },
  }).visit(parsed.program);
  return texts;
});
