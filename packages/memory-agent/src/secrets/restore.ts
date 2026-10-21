import { Data, Result } from "effect";

/** A hidden value, and where its placeholder sits in the redacted text. */
export interface HiddenSpan {
  readonly start: number;
  readonly end: number;
  readonly kind: string;
  readonly value: string;
}

/** Text as the model reads it, with the values its placeholders stand for. */
export interface RedactedView {
  readonly text: string;
  readonly hidden: readonly HiddenSpan[];
}

export type HiddenReplaceFailure = Data.TaggedEnum<{
  no_match: {};
  ambiguous: { readonly occurrences: number };
  /** The text to replace starts or ends inside a placeholder. */
  cuts_hidden: {};
}>;
export const HiddenReplaceFailure = Data.taggedEnum<HiddenReplaceFailure>();

/** What a hidden value reads as; the same text the redactor writes. */
export const placeholderOf = (kind: string) => `[redacted:${kind}]`;
const placeholder = /\[redacted:([^\]\s]+)\]/gu;

/** Whether the model's text holds a placeholder that may stand for a hidden value. */
export const mentionsHidden = (text: string) => text.includes("[redacted:");

/**
 * The replacement with its placeholders turned back into the values they stand for. Each
 * placeholder takes the first value of the same kind the replaced text held that is not taken yet;
 * one with nothing left to stand for stays as written. A value the replacement leaves out is
 * dropped, as when the model deletes the line that held it.
 */
function restore(replacement: string, replaced: readonly HiddenSpan[]) {
  const left = [...replaced];
  return replacement.replace(placeholder, (literal: string, kind: string) => {
    const index = left.findIndex((span) => span.kind === kind);
    if (index < 0) return literal;
    const [span] = left.splice(index, 1);
    return span?.value ?? literal;
  });
}

/**
 * Replaces text the model wrote against the redacted view of a file, and returns the file's real
 * text: values outside the replaced text stay as they were, and placeholders in the replacement
 * bring back the values of the text they replace. The model never sees a hidden value, so this is
 * how it can edit around one, or keep it, without writing the placeholder into the file.
 */
export function replaceKeepingHidden(options: {
  readonly view: RedactedView;
  readonly find: string;
  readonly replacement: string;
  readonly replaceAll: boolean;
}): Result.Result<{ readonly text: string; readonly replacements: number }, HiddenReplaceFailure> {
  const { view, find, replacement, replaceAll } = options;
  const starts: number[] = [];
  for (let at = view.text.indexOf(find); at >= 0; at = view.text.indexOf(find, at + find.length))
    starts.push(at);
  if (starts.length === 0) return Result.fail(HiddenReplaceFailure.no_match());
  if (starts.length > 1 && !replaceAll)
    return Result.fail(HiddenReplaceFailure.ambiguous({ occurrences: starts.length }));

  let out = "";
  let cursor = 0;
  let next = 0;
  /** Copies the view up to `end`, with the values of the placeholders before it. */
  const copyUntil = (end: number) => {
    for (let span = view.hidden[next]; span !== undefined && span.start < end;) {
      out += view.text.slice(cursor, span.start) + span.value;
      cursor = span.end;
      span = view.hidden[++next];
    }
    out += view.text.slice(cursor, end);
    cursor = end;
  };
  for (const start of starts) {
    const end = start + find.length;
    const replaced = view.hidden.filter((span) => span.end > start && span.start < end);
    if (replaced.some((span) => span.start < start || span.end > end))
      return Result.fail(HiddenReplaceFailure.cuts_hidden());
    copyUntil(start);
    out += restore(replacement, replaced);
    cursor = end;
    next += replaced.length;
  }
  copyUntil(view.text.length);
  return Result.succeed({ text: out, replacements: starts.length });
}
