import { i18n } from "@lingui/core";
import { Cause, Effect } from "effect";
import { JSDOM } from "jsdom";

/**
 * The settings dialog reads its project from the project list query, so a change the list picks up
 * (a saved permission mode) shows without reopening the dialog. It runs in jsdom without a browser.
 *
 * The jsdom globals must exist before any component module loads, and this file's static imports of
 * app modules would hoist above the setup, so the dialog modules load dynamically after it.
 */

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});

// jsdom does not implement matchMedia, which the UI's mobile query reads.
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

// The globals the dialog's modules read must exist before they load. Node defines some of them as
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

// React's act only flushes updates when the environment says it is a test.
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  value: true,
  configurable: true,
  writable: true,
});

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@lingui/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { SettingsOverlay } = await import("./settings-dialog");
const { globalQueries } = await import("../queries/global");
const { it } = await import("@effect/vitest");
const { afterEach, describe, expect } = await import("vite-plus/test");

type ListedProject = import("../api").ListedProject;
type RootType = import("react-dom/client").Root;

const projectOf = (permissionMode: ListedProject["permissionMode"]): ListedProject => ({
  id: "alpha",
  root: "/work/alpha",
  name: "Alpha",
  crossRecallExcluded: false,
  permissionMode,
  createdAt: "2026-10-01T09:00:00.000Z",
  hiddenAt: null,
  folderMissing: false,
});

const mounts: RootType[] = [];

const documentRef = dom.window.document;

const sdkCall = Effect.fn("settingsDialog.sdkCall")(function* <A>(
  operation: () => A | PromiseLike<A>,
) {
  return yield* Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: (cause) => new Cause.UnknownError(cause),
  });
});

/**
 * React's act around `work`; returning a promise makes act wait for the work it scheduled. The query
 * cache tells its observers on a timer, so the wait outlasts that timer.
 */
const acting = (work: () => void) =>
  sdkCall(() =>
    act(() => {
      work();
      return Effect.runPromise(Effect.sleep("10 millis"));
    }),
  );

afterEach(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.forEach(mounts.splice(0), (root) => acting(() => root.unmount()), {
        discard: true,
      });
      documentRef.body.replaceChildren();
    }),
  ),
);

describe("SettingsOverlay (jsdom)", () => {
  it.live("권한 모드가 바뀐 프로젝트 목록을 따라간다", () =>
    Effect.gen(function* () {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const projectsKey = globalQueries.projects().queryKey;
      client.setQueryData(projectsKey, [projectOf("ask")]);
      const container = documentRef.createElement("div");
      documentRef.body.append(container);
      const root = createRoot(container);
      mounts.push(root);
      yield* acting(() =>
        root.render(
          <I18nProvider i18n={i18n}>
            <QueryClientProvider client={client}>
              <SettingsOverlay
                projectId="alpha"
                initialPage="permission"
                reportLink="/report"
                open
                onClose={() => {}}
              />
            </QueryClientProvider>
          </I18nProvider>,
        ),
      );
      const trigger = () => documentRef.querySelector("#project-permission-mode");
      expect(trigger()?.textContent).toContain("매번 묻기");

      // The saved mode reaches the list; the open dialog shows it without being reopened.
      yield* acting(() => client.setQueryData(projectsKey, [projectOf("auto")]));
      expect(trigger()?.textContent).toContain("자동 판단");
    }),
  );
});
