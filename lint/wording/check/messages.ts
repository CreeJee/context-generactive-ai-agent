import { parsePoFile } from "@lingui/format-po";
import { extractMessages } from "@lingui/native-tools";
import { Array as Arr, Effect, Option, Result, Schema } from "effect";

import { linguiCoreMacroModules, linguiJsxMacroModules } from "../policy.ts";

/** One Lingui message as the wording check reads it, and where a finding should point. */
export interface Message {
  readonly text: string;
  readonly where: string;
}

/** A message in a source file, with where its macro starts (line from 1, column from 0). */
export interface SourceMessage extends Message {
  readonly line: number;
  readonly column: number;
}

/** The file could not be read for messages, so nothing in it was checked. */
export class MessagesUnreadable extends Schema.TaggedError<MessagesUnreadable>()(
  "MessagesUnreadable",
  {
    file: Schema.String,
    message: Schema.String,
  },
) {}

const hangul = /\p{Script=Hangul}/u;

/** An ICU argument (`{name}`) and the numbered tags Lingui writes for JSX inside `<Trans>`. */
const messageArgument = /\{[^{}]*\}/gu;
const messageTag = /<\/?\d+\/?>/gu;

/**
 * Stands in for an argument, so `{count}개를 지웠습니다` is read as one sentence. A Latin letter keeps
 * the morpheme analysis of the words around it unchanged.
 */
const placeholder = "X";

/** A message as plain text: an argument reads as the placeholder and JSX tags are dropped. */
const plainText = (message: string) =>
  message.replace(messageArgument, placeholder).replace(messageTag, "");

const withHangul = <Place extends Omit<Message, "text">>(
  text: string,
  place: Place,
): Result.Result<Place & Message, void> =>
  hangul.test(text) ? Result.succeed({ ...place, text: plainText(text) }) : Result.failVoid;

/**
 * The messages of a Lingui catalog that `lingui extract` wrote. Each reads as what the app shows:
 * the translation (`msgstr`), or the source text where the translation is empty. Obsolete entries
 * are skipped. A finding points at the catalog and the source files the message comes from.
 */
export const catalogMessages = Effect.fnUntraced(function* (file: string, source: string) {
  const catalog = yield* Effect.try({
    try: () => parsePoFile(source),
    catch: (cause) => new MessagesUnreadable({ file, message: String(cause) }),
  });
  return Arr.filterMap(catalog.items, (item) =>
    item.obsolete
      ? Result.failVoid
      : withHangul(
          Option.getOrElse(
            Arr.findFirst(item.msgstr, (text) => text !== ""),
            () => item.msgid,
          ),
          // A `#:` line lists its origins separated by spaces.
          { where: `${file} (${item.references.flatMap((line) => line.split(" ")).join(", ")})` },
        ),
  );
});

/**
 * The messages a source file declares, read with the extractor `lingui extract` uses but without
 * writing a catalog: the lint rule and the Claude Code hook check an edit before anyone extracts.
 */
export const sourceMessages = Effect.fnUntraced(function* (
  file: string,
  source: string,
): Effect.fn.Return<ReadonlyArray<SourceMessage>, MessagesUnreadable> {
  const extracted = yield* Effect.tryPromise({
    try: () =>
      extractMessages(source, file, {
        macro: {
          corePackage: [...linguiCoreMacroModules],
          jsxPackage: [...linguiJsxMacroModules],
        },
      }),
    catch: (cause) => new MessagesUnreadable({ file, message: String(cause) }),
  });
  return Arr.filterMap(extracted.messages, ({ message, origin }) => {
    // The extractor counts columns from 1; lint locations count them from 0.
    const line = origin?.line ?? 1;
    const column = origin?.column ?? 1;
    return message === undefined
      ? Result.failVoid
      : withHangul(message, { where: `${file}:${line}:${column}`, line, column: column - 1 });
  });
});
