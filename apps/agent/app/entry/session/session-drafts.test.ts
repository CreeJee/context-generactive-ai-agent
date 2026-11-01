import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, test } from "vite-plus/test";
import { type DraftStorage, draftsIn } from "./session-drafts";

/** A storage every tab shares, as a browser's tabs share `localStorage`. */
const storageOf = (items: Map<string, string>): DraftStorage => ({
  getItem: (key) => items.get(key) ?? null,
  setItem: (key, value) => void items.set(key, value),
  removeItem: (key) => void items.delete(key),
});

/** A tab with the session's draft on screen. */
const tabOf = (atoms: { readonly text: Atom.Atom<string>; readonly follow: Atom.Atom<void> }) => {
  const tab = AtomRegistry.make();
  tab.mount(atoms.text);
  tab.mount(atoms.follow);
  return tab;
};

describe("session drafts", () => {
  test("the old shared drafts move to their own keys", () => {
    const items = new Map([
      ["context-agent-session-drafts", JSON.stringify({ a: "old a", b: "old b" })],
      ["context-agent-session-draft:b", "newer b"],
    ]);
    const atoms = draftsIn({ storage: () => storageOf(items), shown: Atom.make(0) })("a");
    expect(tabOf(atoms).get(atoms.text)).toBe("old a");
    expect(Object.fromEntries(items)).toEqual({
      "context-agent-session-draft:a": "old a",
      "context-agent-session-draft:b": "newer b",
    });
  });

  test("a tab reads the stored text again when shown, unless it typed its own", () => {
    const shown = Atom.make(0);
    const storage = storageOf(new Map());
    const atoms = draftsIn({ storage: () => storage, shown })("s");
    const [first, second] = [tabOf(atoms), tabOf(atoms)];
    const show = (tab: AtomRegistry.AtomRegistry) => tab.set(shown, tab.get(shown) + 1);

    first.set(atoms.text, "hello");
    expect(second.get(atoms.text)).toBe("");
    show(second);
    expect(second.get(atoms.text)).toBe("hello");

    // The first tab sends it; the second, which never typed it, drops it once shown.
    first.set(atoms.text, "");
    show(second);
    expect(second.get(atoms.text)).toBe("");

    second.set(atoms.text, "next");
    show(first);
    expect(first.get(atoms.text)).toBe("next");

    first.set(atoms.text, "mine");
    second.set(atoms.text, "theirs");
    show(first);
    expect(first.get(atoms.text)).toBe("mine");
  });
});
