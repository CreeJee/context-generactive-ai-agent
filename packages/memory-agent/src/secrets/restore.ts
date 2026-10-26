import { Array as EffectArray, Data, Option, Result } from "effect";

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
  return replacement.replace(placeholder, (literal: string, kind: string) =>
    Option.match(
      EffectArray.findFirstIndex(left, (span) => span.kind === kind),
      {
        onNone: () => literal,
        onSome: (index) => left.splice(index, 1)[0]?.value ?? literal,
      },
    ),
  );
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
  const starts = EffectArray.unfold(view.text.indexOf(find), (at) =>
    at < 0 ? Option.none() : Option.some([at, view.text.indexOf(find, at + find.length)] as const),
  );
  if (starts.length === 0) return Result.fail(HiddenReplaceFailure.no_match());
  if (starts.length > 1 && !replaceAll)
    return Result.fail(HiddenReplaceFailure.ambiguous({ occurrences: starts.length }));

  const matches = starts.map((start) => {
    const end = start + find.length;
    return {
      start,
      end,
      replaced: view.hidden.filter((span) => span.end > start && span.start < end),
    };
  });
  if (
    matches.some(({ start, end, replaced }) =>
      replaced.some((span) => span.start < start || span.end > end),
    )
  )
    return Result.fail(HiddenReplaceFailure.cuts_hidden());
  const text =
    matches
      .map(
        ({ start, replaced }, index) =>
          unhidden(view, matches[index - 1]?.end ?? 0, start) + restore(replacement, replaced),
      )
      .join("") + unhidden(view, matches.at(-1)?.end ?? 0, view.text.length);
  return Result.succeed({ text, replacements: starts.length });
}

/** The view from `from` to `to`, with the values of the placeholders inside it. */
function unhidden(view: RedactedView, from: number, to: number) {
  const { out, cursor } = view.hidden
    .filter((span) => span.start >= from && span.end <= to)
    .reduce(
      (copied, span) => ({
        out: copied.out + view.text.slice(copied.cursor, span.start) + span.value,
        cursor: span.end,
      }),
      { out: "", cursor: from },
    );
  return out + view.text.slice(cursor, to);
}
