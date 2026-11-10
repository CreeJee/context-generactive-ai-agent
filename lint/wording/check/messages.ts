import { extractMessages } from "@lingui/native-tools";
import { Array as Arr, Effect, Result, Schema } from "effect";

import { linguiCoreMacroModules, linguiJsxMacroModules } from "../policy.ts";

/**
 * One Lingui message as the wording check reads it, and where a finding should point: `where` as
 * `file:line:column` for people, `line` (from 1) and `column` (from 0) for lint locations.
 */
export interface Message {
  readonly text: string;
  readonly where: string;
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

/** A PO string line (`msgid "…"`, `msgstr "…"` or a continuation `"…"`) and its quoted text. */
const poString = /^(?:msgid |msgstr |msgctxt )?(".*")$/u;

/** The text a run of PO string lines spells; PO escapes are JSON's for what `lingui extract` writes. */
const poText = (lines: ReadonlyArray<string>): string =>
  Arr.map(lines, (line) => {
    const quoted = poString.exec(line)?.[1];
    // SAFETY: `quoted` matched `".*"`, a double-quoted string with C-style escapes.
    return quoted === undefined ? "" : (JSON.parse(quoted) as string);
  }).join("");

/** The lines of a field: its keyword line and the continuation lines after it. */
const fieldLines = (lines: ReadonlyArray<string>, at: number): ReadonlyArray<string> => {
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((line) => !line.startsWith('"'));
  return [lines[at] ?? "", ...(end === -1 ? rest : rest.slice(0, end))];
};

/**
 * The messages of a Lingui catalog whose translation (`msgstr`) differs from its source text: the
 * screen shows the translation, and the lint rule `wording/content` already checks the source text
 * where it is written. A finding points at the `msgstr` line in the catalog. The header and obsolete
 * (`#~`) entries are skipped.
 */
export function catalogMessages(file: string, source: string): ReadonlyArray<Message> {
  const lines = source.split("\n");
  // An entry starts at a non-blank line after a blank one (or the first line).
  const starts = Arr.filterMap(lines, (line, index) =>
    line !== "" && (index === 0 || lines[index - 1] === "")
      ? Result.succeed(index)
      : Result.failVoid,
  );
  return Arr.filterMap(starts, (start) => {
    const rest = lines.slice(start);
    const blank = rest.indexOf("");
    const entry = blank === -1 ? rest : rest.slice(0, blank);
    const msgid = entry.findIndex((line) => line.startsWith("msgid "));
    const msgstr = entry.findIndex((line) => line.startsWith("msgstr "));
    if (msgid === -1 || msgstr === -1) return Result.failVoid;
    const original = poText(fieldLines(entry, msgid));
    const translation = poText(fieldLines(entry, msgstr));
    if (original === "" || translation === "" || translation === original) return Result.failVoid;
    const line = start + msgstr + 1;
    return withHangul(translation, { where: `${file}:${line}:1`, line, column: 0 });
  });
}

/**
 * The messages a source file declares, read with the extractor `lingui extract` uses but without
 * writing a catalog: the lint rule and the Claude Code hook check an edit before anyone extracts.
 */
export const sourceMessages = Effect.fnUntraced(function* (
  file: string,
  source: string,
): Effect.fn.Return<ReadonlyArray<Message>, MessagesUnreadable> {
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
