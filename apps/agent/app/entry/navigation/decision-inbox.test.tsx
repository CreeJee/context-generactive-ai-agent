import { i18n } from "@lingui/core";
import { Cause, Data, Effect } from "effect";
import { JSDOM } from "jsdom";

/**
 * The sidebar's decision inbox gathers what waits in every listed project, not only the open one.
 * It runs in jsdom without a browser.
 *
 * The jsdom globals must exist before any component module loads, and this file's static imports of
 * app modules would hoist above the setup, so the inbox modules load dynamically after it.
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

// The globals the inbox's modules read must exist before they load. Node defines some of them as
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
const { SidebarMenu, SidebarProvider } = await import("../../components/ui/sidebar");
const { api } = await import("../api");
const { projectQueries } = await import("../queries/project");
const { DecisionInbox } = await import("./decision-inbox");
const { it } = await import("@effect/vitest");
const { afterEach, describe, expect, vi } = await import("vite-plus/test");

type DecisionInboxItem = import("../api").DecisionInboxItem;
type DecisionKind = import("../api").DecisionKind;
type RootType = import("react-dom/client").Root;

const Kind = Data.taggedEnum<DecisionKind>();
const State = Data.taggedEnum<DecisionInboxItem["state"]>();

const decisionOf = (requestId: string): DecisionInboxItem => ({
  requestId,
  sessionId: "session-1",
  goalInstanceId: "goal-1",
  cardId: "card-1",
  kind: Kind.RetryExhausted({ attempts: 3 }),
  factsSeq: 1,
  factsChanged: false,
  createdAt: 0,
  state: State.Pending(),
  sessionTitle: null,
  cardTitle: "카드",
});

const mounts: RootType[] = [];

const documentRef = dom.window.document;

const sdkCall = Effect.fn("decisionInbox.sdkCall")(function* <A>(
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
      vi.restoreAllMocks();
    }),
  ),
);

describe("DecisionInbox (jsdom)", () => {
  it.live("the badge counts the decisions waiting in every listed project", () =>
    Effect.gen(function* () {
      const decisions = {
        alpha: [decisionOf("a-1")],
        beta: [decisionOf("b-1"), decisionOf("b-2")],
      };
      const waitingIn = (project: string) =>
        project === "alpha" || project === "beta" ? decisions[project] : [];
      vi.spyOn(api, "decisionInbox").mockImplementation((project) =>
        Promise.resolve(waitingIn(project)),
      );
      vi.spyOn(api, "projectBoards").mockImplementation(() => Promise.resolve([]));
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      client.setQueryData(projectQueries.decisions("alpha").queryKey, decisions.alpha);
      client.setQueryData(projectQueries.decisions("beta").queryKey, decisions.beta);
      client.setQueryData(projectQueries.boards("alpha").queryKey, []);
      client.setQueryData(projectQueries.boards("beta").queryKey, []);
      const container = documentRef.createElement("div");
      documentRef.body.append(container);
      const root = createRoot(container);
      mounts.push(root);
      yield* acting(() =>
        root.render(
          <I18nProvider i18n={i18n}>
            <QueryClientProvider client={client}>
              <SidebarProvider>
                <SidebarMenu>
                  <DecisionInbox
                    projects={[
                      { id: "alpha", name: "Alpha" },
                      { id: "beta", name: "Beta" },
                    ]}
                    onOpenCard={() => {}}
                  />
                </SidebarMenu>
              </SidebarProvider>
            </QueryClientProvider>
          </I18nProvider>,
        ),
      );

      const badge = container.querySelector('[data-slot="sidebar-menu-badge"]');
      expect(badge?.textContent).toBe("3");
    }),
  );
});
