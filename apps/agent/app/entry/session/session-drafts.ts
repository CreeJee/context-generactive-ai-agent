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
}) =>
  Atom.family((sessionId: string) => {
    // Nothing is read before the page mounts, so the server's render and the first one match.
    const draft = Atom.make<Draft>({ text: "", edited: false });
    return {
      /** The text; setting it stores it. */
      text: Atom.writable(
        (get) => get(draft).text,
        (ctx, text: string) => {
          store(storage, sessionId, text);
          ctx.set(draft, { text, edited: text.length > 0 });
        },
      ),
      /** Mounted by the page: reads the stored text now and each time the tab shows again. */
      follow: Atom.make((get) => {
        get(shown);
        if (!get.once(draft).edited)
          get.set(draft, { text: stored(storage, sessionId), edited: false });
      }),
    };
  });

/** The page's drafts in `localStorage`, read again when the tab becomes visible. */
export const sessionDrafts = draftsIn({
  storage: () => localStorage,
  shown: Atom.windowFocusSignal,
});
