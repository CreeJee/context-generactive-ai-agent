import { Option, Result, Schema } from "effect";
import type { LazyArg } from "effect/Function";
import { Atom } from "effect/reactivity";

/** Where the drafts are kept: the browser's `localStorage` on the page. */
export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** One session's unsent text in this tab. */
interface Draft {
  readonly text: string;
  /** Typed here since this tab last read it; showing the tab again does not replace it. */
  readonly edited: boolean;
}

const keyOf = (sessionId: string) => `context-agent-session-draft:${sessionId}`;
/** Until 2026-11-02 one key held every session's draft, and each tab wrote all of them back. */
const sharedKey = "context-agent-session-drafts";
const decodeShared = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);

/** Moves the old shared drafts to their own keys, leaving a draft already there as it is. */
function moveShared(storage: DraftStorage): void {
  const shared = storage.getItem(sharedKey);
  if (shared === null) return;
  for (const [sessionId, text] of Object.entries(
    Option.getOrElse(decodeShared(shared), () => ({})),
  ))
    if (storage.getItem(keyOf(sessionId)) === null) storage.setItem(keyOf(sessionId), text);
  storage.removeItem(sharedKey);
}

/** The stored text, or none when the storage cannot be read. */
const stored = (storage: LazyArg<DraftStorage>, sessionId: string): string =>
  Result.getOrElse(
    Result.try(() => {
      moveShared(storage());
      return storage().getItem(keyOf(sessionId)) ?? "";
    }),
    () => "",
  );

/** Keeps the text, or forgets it once empty; a storage that refuses it loses only the copy. */
const store = (storage: LazyArg<DraftStorage>, sessionId: string, text: string): void =>
  void Result.try(() =>
    text.length > 0
      ? storage().setItem(keyOf(sessionId), text)
      : storage().removeItem(keyOf(sessionId)),
  );

/**
 * Each session's unsent text, kept under the session's own key so a tab writes only the session it
 * types in. Tabs do not follow each other's typing. A tab reads the text when it mounts `follow`
 * and again each time `shown` ticks, unless it typed the text itself since; the last tab to type a
 * session's text is the one stored. Empty text counts as not typed, so a tab that sent its text
 * picks up what another tab wrote, and a tab still showing text another tab sent drops it.
 */
export const draftsIn = ({
  storage,
  shown,
}: {
  readonly storage: LazyArg<DraftStorage>;
  /** Ticks when the tab shows again. */
  readonly shown: Atom.Atom<number>;
}) => {
  // One atom per family, not one object holding them: `Atom.family` keeps only a weak reference,
  // and the registry holds a mounted atom but nothing holds a group. A collected group became new
  // atoms on the next render, with the draft read again from storage, which replaced the text being
  // typed and broke the IME composition under the caret.
  // Nothing is read before the page mounts, so the server's render and the first one match.
  const draft = Atom.family<string, Atom.Writable<Draft>>(() =>
    Atom.make<Draft>({ text: "", edited: false }),
  );
  const text = Atom.family((sessionId: string) =>
    Atom.writable(
      (get) => get(draft(sessionId)).text,
      (ctx, next: string) => {
        store(storage, sessionId, next);
        ctx.set(draft(sessionId), { text: next, edited: next.length > 0 });
      },
    ),
  );
  const follow = Atom.family((sessionId: string) =>
    Atom.make((get) => {
      get(shown);
      if (!get.once(draft(sessionId)).edited)
        get.set(draft(sessionId), { text: stored(storage, sessionId), edited: false });
    }),
  );
  return (sessionId: string) => ({
    /** The text; setting it stores it. */
    text: text(sessionId),
    /** Mounted by the page: reads the stored text now and each time the tab shows again. */
    follow: follow(sessionId),
  });
};

/** The page's drafts in `localStorage`, read again when the tab becomes visible. */
export const sessionDrafts = draftsIn({
  storage: () => localStorage,
  shown: Atom.windowFocusSignal,
});
