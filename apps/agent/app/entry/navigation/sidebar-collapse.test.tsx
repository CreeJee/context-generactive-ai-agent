import { i18n } from "@lingui/core";
import { Cause, Effect } from "effect";
import { JSDOM } from "jsdom";

/**
 * The collapsible group behavior in a DOM, without a browser: Base UI unmounts a closed panel, so a
 * folded group renders no row links and opening one mounts them. The browser test asserts the same
 * with real styles (sidebar.browser.tsx); this one runs everywhere on the installed jsdom.
 *
 * The jsdom globals must exist before any component module loads, and this file's static imports of
 * app modules would hoist above the setup, so the sidebar modules load dynamically after it.
 */

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});

// jsdom does not implement matchMedia, which the sidebar's mobile query reads.
Object.defineProperty(dom.window, "matchMedia", {
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
  configurable: true,
  writable: true,
});

// The globals the sidebar's modules read must exist before they load. Node defines some of them as
// getter-only, so each is redefined; defineProperty takes any property name, which is what makes
// plain string keys work without assertions.
const installedGlobals = [
  "window",
  "document",
  "navigator",
  "localStorage",
  "Element",
  "Node",
  "Text",
  "DocumentFragment",
  "HTMLElement",
  "SVGElement",
  "HTMLInputElement",
  "HTMLButtonElement",
  "HTMLAnchorElement",
  "Event",
  "CustomEvent",
  "MouseEvent",
  "KeyboardEvent",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
] satisfies readonly string[];

for (const key of installedGlobals) {
  Object.defineProperty(globalThis, key, {
    value: dom.window[key],
    configurable: true,
    writable: true,
  });
}

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@lingui/react");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { SidebarProvider } = await import("../../components/ui/sidebar");
const { SessionSection } = await import("./sidebar");
const { it } = await import("@effect/vitest");
const { afterEach, describe, expect } = await import("vite-plus/test");

type Session = import("../api").Session;
type RootType = import("react-dom/client").Root;

const sessionOf = (projectId: string, id: string, title: string): Session => ({
  id,
  projectId,
  title,
  createdAt: "2026-10-01T09:00:00.000Z",
  agent: null,
  archivedAt: null,
  importedFrom: null,
  worktreePath: null,
  branch: null,
});

/**
 * The shape SessionSection reads its groups as. `archived` defaults to none, so callers name only
 * the conversations.
 */
type Group = {
  readonly projectId: string;
  readonly name: string;
  readonly sessions: ReadonlyArray<Session>;
  readonly archived: ReadonlyArray<Session>;
  readonly folderMissing: boolean;
};

const group = (projectId: string, name: string, sessions: Session[], archived = []): Group => ({
  projectId,
  name,
  sessions,
  archived,
  folderMissing: false,
});

/** No conversation of any project is at work; tests that need one name their own. */
const idle: Array<import("../queries/project").ProjectWorking> = [];

const mounts: RootType[] = [];

const documentRef = dom.window.document;

const sdkCall = Effect.fn("sidebarCollapse.sdkCall")(function* <A>(
  operation: () => A | PromiseLike<A>,
) {
  return yield* Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: (cause) => new Cause.UnknownError(cause),
  });
});

/** React's act around `work`; returning a promise makes act wait for the work it scheduled. */
const acting = (work: () => void) =>
  sdkCall(() =>
    act(() => {
      work();
      return Promise.resolve();
    }),
  );

/** The rows are Links, so the section renders under the app's router like report tests do. */
const renderSection = Effect.fn("sidebarCollapse.renderSection")(function* (
  ui: React.ReactElement,
) {
  const container = documentRef.createElement("div");
  documentRef.body.append(container);
  const root = createRoot(container);
  mounts.push(root);
  const router = createMemoryRouter([{ path: "/", element: ui }], { initialEntries: ["/"] });
  yield* acting(() =>
    root.render(
      <I18nProvider i18n={i18n}>
        <SidebarProvider>
          <RouterProvider router={router} />
        </SidebarProvider>
      </I18nProvider>,
    ),
  );
  return { container, router };
});

afterEach(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.forEach(mounts.splice(0), (root) => acting(() => root.unmount()), {
        discard: true,
      });
      documentRef.body.replaceChildren();
      dom.window.localStorage.removeItem("context-agent-session-groups-open-v1");
    }),
  ),
);

const rowLinks = (container: HTMLElement) => [...container.querySelectorAll('a[href*="session="]')];

const click = Effect.fn("sidebarCollapse.click")(function* (container: HTMLElement, name: RegExp) {
  const trigger = [...container.querySelectorAll("button")].find((button) =>
    name.test(button.textContent ?? ""),
  );
  if (trigger === undefined) return yield* Effect.die(new Error(`no button ${String(name)}`));
  yield* acting(() => {
    trigger.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
});

describe("SessionSection collapsible groups (jsdom)", () => {
  it.live("a folded group renders no row links; an open one mounts its own", () =>
    Effect.gen(function* () {
      // No stored folds: the selected project starts open, every other group starts folded.
      const { container } = yield* renderSection(
        <div className="w-72">
          <SessionSection
            groups={[
              group("alpha", "Alpha", [sessionOf("alpha", "a1", "알파 대화")]),
              group("beta", "Beta", [sessionOf("beta", "b1", "베타 질문")]),
            ]}
            working={idle}
            loading={false}
            projectId="beta"
            sessionId="b1"
            archiveError={null}
            onCreate={() => {}}
            onArchive={() => {}}
            onDelete={() => {}}
            onRestore={() => {}}
            header={null}
            projectActions={() => null}
          />
        </div>,
      );

      // The page is on beta, so only beta's rows are mounted; alpha's folded group has none.
      const links = rowLinks(container);
      expect(links).toHaveLength(1);
      expect(links[0]!.textContent).toContain("베타 질문");
      expect(links[0]!.getAttribute("href")).toBe("/?project=beta&session=b1");

      // Opening the folded group mounts its rows; folding it again unmounts them.
      yield* click(container, /^Alpha/);
      expect(rowLinks(container)).toHaveLength(2);
      yield* click(container, /^Alpha/);
      expect(rowLinks(container)).toHaveLength(1);
    }),
  );

  it.live("every other project's row link carries its project and session parameter", () =>
    Effect.gen(function* () {
      const { container } = yield* renderSection(
        <div className="w-72">
          <SessionSection
            groups={[
              group("alpha", "Alpha", [sessionOf("alpha", "a1", "알파 대화")]),
              group("beta", "Beta", [sessionOf("beta", "b1", "베타 질문")]),
            ]}
            working={idle}
            loading={false}
            projectId="beta"
            sessionId="b1"
            archiveError={null}
            onCreate={() => {}}
            onArchive={() => {}}
            onDelete={() => {}}
            onRestore={() => {}}
            header={null}
            projectActions={() => null}
          />
        </div>,
      );

      // The page is on beta, so alpha's row is behind its folded header: open it to reach the row.
      yield* click(container, /^Alpha/);
      const alpha = rowLinks(container).find((link) => link.textContent?.includes("알파 대화"));
      expect(alpha).toBeDefined();
      const parameters = new URLSearchParams(alpha!.getAttribute("href")!.split("?")[1]);
      expect(parameters.get("project")).toBe("alpha");
      expect(parameters.get("session")).toBe("a1");
      // The row of the page in use is the current one; the other project's is not.
      expect(alpha!.getAttribute("aria-current")).toBeNull();
    }),
  );

  it.live(
    "a conversation at work leads its group with a spinner, and the header badges the count",
    () =>
      Effect.gen(function* () {
        const { container } = yield* renderSection(
          <div className="w-72">
            <SessionSection
              groups={[
                group("alpha", "Alpha", [
                  sessionOf("alpha", "a1", "알파 먼저"),
                  sessionOf("alpha", "a2", "알파 나중"),
                ]),
              ]}
              // a2 answers now: it leaves the "대화" section for the "진행 중" one above it.
              working={[
                { projectId: "alpha", answering: new Set(["a2"]), boardRunning: new Set() },
              ]}
              loading={false}
              projectId="alpha"
              sessionId={null}
              archiveError={null}
              onCreate={() => {}}
              onArchive={() => {}}
              onDelete={() => {}}
              onRestore={() => {}}
              header={null}
              projectActions={() => null}
            />
          </div>,
        );

        // The answering conversation is the first row; the idle one follows it.
        const titles = rowLinks(container).map((link) => link.textContent?.trim());
        expect(titles).toEqual(["알파 나중", "알파 먼저"]);
        // The leading row carries the answering spinner.
        expect(container.querySelector('a[href*="session=a2"] [role="status"]')).not.toBeNull();
        expect(container.querySelector('a[href*="session=a1"] [role="status"]')).toBeNull();

        // The group header badges how many conversations are at work in this project; the badge's
        // accessible name carries the count, its content the number and a spinning marker.
        const header = [...container.querySelectorAll("button")].find((button) =>
          (button.textContent ?? "").startsWith("Alpha"),
        );
        const badge = header?.querySelector('[data-slot="badge"][aria-label]');
        expect(badge?.getAttribute("aria-label")).toContain("진행 중 1개");
        expect(badge?.textContent).toContain("1");
        // The spinner inside the badge marks the count as live, like the rows it counts.
        expect(badge?.querySelector('[data-slot="spinner"]')).not.toBeNull();
      }),
  );

  it.live("the + button on a project header starts a conversation in that project", () =>
    Effect.gen(function* () {
      const created: string[] = [];
      const { container } = yield* renderSection(
        <div className="w-72">
          <SessionSection
            groups={[
              group("alpha", "Alpha", [sessionOf("alpha", "a1", "알파 대화")]),
              group("beta", "Beta", [sessionOf("beta", "b1", "베타 대화")]),
            ]}
            working={idle}
            loading={false}
            projectId="alpha"
            sessionId="a1"
            archiveError={null}
            onCreate={(projectId) => {
              created.push(projectId);
            }}
            onArchive={() => {}}
            onDelete={() => {}}
            onRestore={() => {}}
            header={null}
            projectActions={() => null}
          />
        </div>,
      );

      // The open conversation is alpha's; the second project's button still names the second one.
      const plus = container.querySelector('button[aria-label*="Beta"]');
      expect(plus).not.toBeNull();
      yield* acting(() => {
        plus!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      });
      expect(created).toEqual(["beta"]);
    }),
  );

  it.live("a project without conversations is a group while it is not the open project", () =>
    Effect.gen(function* () {
      const { container } = yield* renderSection(
        <div className="w-72">
          <SessionSection
            groups={[
              group("alpha", "Alpha", [sessionOf("alpha", "a1", "알파 대화")]),
              group("gamma", "Gamma", []),
            ]}
            working={idle}
            loading={false}
            projectId="alpha"
            sessionId="a1"
            archiveError={null}
            onCreate={() => {}}
            onArchive={() => {}}
            onDelete={() => {}}
            onRestore={() => {}}
            header={null}
            projectActions={() => null}
          />
        </div>,
      );

      const gamma = [...container.querySelectorAll("button")].find((button) =>
        (button.textContent ?? "").startsWith("Gamma"),
      );
      expect(gamma).toBeDefined();
    }),
  );

  it.live("a group without conversations at work shows no badge", () =>
    Effect.gen(function* () {
      const { container } = yield* renderSection(
        <div className="w-72">
          <SessionSection
            groups={[
              group("alpha", "Alpha", [sessionOf("alpha", "a1", "알파 대화")]),
              group("beta", "Beta", [sessionOf("beta", "b1", "베타 대화")]),
            ]}
            // Only beta answers; alpha's header has nothing to badge.
            working={[{ projectId: "beta", answering: new Set(["b1"]), boardRunning: new Set() }]}
            loading={false}
            projectId="beta"
            sessionId={null}
            archiveError={null}
            onCreate={() => {}}
            onArchive={() => {}}
            onDelete={() => {}}
            onRestore={() => {}}
            header={null}
            projectActions={() => null}
          />
        </div>,
      );

      yield* click(container, /^Alpha/);
      const headerOf = (name: string) =>
        [...container.querySelectorAll("button")].find((button) =>
          (button.textContent ?? "").startsWith(name),
        );
      expect(headerOf("Beta")?.querySelector('[data-slot="badge"][aria-label]')).not.toBeNull();
      expect(headerOf("Alpha")?.querySelector('[data-slot="badge"][aria-label]')).toBeNull();
    }),
  );
});
