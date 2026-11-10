import { extractMessages } from "@lingui/native-tools";
import { Array as Arr, Effect, Option, Predicate, Result, Schema } from "effect";
import { parseSync, Visitor } from "oxc-parser";

/** One piece of wording in a source file, with where it starts. */
export interface SourceText {
  readonly text: string;
  readonly line: number;
  readonly column: number;
}

/** The file could not be read for wording, so nothing in it was checked. */
export class SourceParseFailed extends Schema.TaggedError<SourceParseFailed>()(
  "SourceParseFailed",
  {
    file: Schema.String,
    message: Schema.String,
  },
) {}

const hangul = /\p{Script=Hangul}/u;

/**
 * Stands in for a template expression, so `${count}개를 지웠어요` is read as one sentence. A Latin
 * letter keeps the morpheme analysis of the words around it unchanged.
 */
const placeholder = "X";

/** Line and column (both from 1) of an offset in `source`. */
function positionOf(source: string, offset: number): Pick<SourceText, "line" | "column"> {
  const before = source.slice(0, offset);
  const lineStart = before.lastIndexOf("\n") + 1;
  return { line: before.split("\n").length, column: offset - lineStart + 1 };
}

/**
 * Every string literal, template literal and JSX text in `source` that contains Hangul. A template
 * literal is read whole, with its expressions replaced by a placeholder.
 */
export const catalogTexts = Effect.fnUntraced(function* (
  file: string,
  source: string,
): Effect.fn.Return<ReadonlyArray<SourceText>, SourceParseFailed> {
  const parsed = parseSync(file, source);
  const firstError = Arr.head(parsed.errors);
  if (Option.isSome(firstError)) {
    return yield* new SourceParseFailed({ file, message: firstError.value.message });
  }
  const texts: Array<SourceText> = [];
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

/** An ICU argument (`{name}`) and the numbered tags Lingui writes for JSX inside `<Trans>`. */
const messageArgument = /\{[^{}]*\}/gu;
const messageTag = /<\/?\d+\/?>/gu;

/**
 * Every Lingui message in `source` (t`…`, msg(…), <Trans>…</Trans>) that contains Hangul, as plain
 * text: an argument reads as the placeholder and JSX tags are dropped, as a template literal is read.
 */
export const messageTexts = Effect.fnUntraced(function* (file: string, source: string) {
  const extracted = yield* Effect.tryPromise({
    try: () => extractMessages(source, file),
    catch: (cause) => new SourceParseFailed({ file, message: String(cause) }),
  });
  return Arr.filterMap(
    extracted.messages,
    ({ message, origin }): Result.Result<SourceText, void> =>
      message !== undefined && hangul.test(message)
        ? Result.succeed({
            text: message.replace(messageArgument, placeholder).replace(messageTag, ""),
            line: origin?.line ?? 1,
            column: origin?.column ?? 1,
          })
        : Result.failVoid,
  );
});
