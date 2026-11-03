import { it } from "@effect/vitest";
import { RegistryProvider } from "@effect/atom-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Cause, Effect } from "effect";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import { render } from "vitest-browser-react";
import { expect, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "../../app.css";
import type { SessionRunState } from "memory-agent/definitions";
import { SessionEventScopeContext } from "../events/context";
import { allowedWorkflowActions } from "../session/workflow-test-fixtures";
import { SessionView, type SlashSupport } from "./chat-panel";

/**
 * Renders of the panel, with the conversation in it, that a keystroke caused. React renders a
 * keystroke's update before its input event ends, so only renders during the event count; the
 * panel reads the slash commands once a render, to hand them to the input box.
 */
const panel = { typing: false, renders: 0 };
document.addEventListener(
  "input",
  () => {
    panel.typing = true;
  },
  { capture: true },
);
window.addEventListener("input", () => {
  panel.typing = false;
});
const slash: SlashSupport = {
  get context() {
    if (panel.typing) panel.renders += 1;
    return { agents: [], models: [], efforts: [], skills: [] };
  },
  run: () => Promise.resolve(),
};

const messages = [
  { id: "u1", role: "user", parts: [{ type: "text", content: "이전 질문" }] },
  { id: "a1", role: "assistant", parts: [{ type: "text", content: "이전 답변" }] },
];
const queued = {
  id: "q1",
  seq: 1,
  text: "대기 메시지",
  attachmentIds: [],
  state: { _tag: "waiting", steered: false },
  createdAt: 1,
};
/** Nothing runs; the page reads this again when the run it started ends. */
const runState: SessionRunState = {
  running: null,
  lastRun: null,
  lease: { state: "mine" },
  context: {
    usedTokens: null,
    cachedTokens: null,
    cacheRatio: null,
    compactionStage: null,
    windowTokens: 258400,
    windowKnown: false,
    compactAtTokens: 64600,
  },
  workflow: { phase: "chat", goal: null, plan: null, ledger: [] },
  actions: allowedWorkflowActions,
  uncertainRuns: [],
};

/** The changes the page sent: path and body. */
const sent: string[] = [];

/** The server behind the real API clients; changes other than the lease are only recorded. */
const server = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const request = new Request(input, init);
  const { pathname } = new URL(request.url);
  if (pathname === "/api/sessions/s1/lease")
    return Promise.resolve(Response.json({ state: "mine" }));
  if (pathname === "/api/sessions/s1" && request.method === "GET")
    return Promise.resolve(Response.json(runState));
  if (pathname === "/api/sessions/s1/messages")
    return Promise.resolve(
      Response.json({ messages, older: null, activeRun: null, interrupts: null }),
    );
  if (pathname === "/api/sessions/s1/queue" && request.method === "GET")
    return Promise.resolve(Response.json({ items: [queued], nextDelivery: { _tag: "empty" } }));
  if (request.method === "POST")
    return request.text().then((body) => {
      sent.push(`${pathname} ${body}`);
      return Response.json(null);
    });
  return Promise.resolve(Response.json({ error: "not_found" }, { status: 404 }));
};

/** The work trace stream stays quiet. */
class QuietEventSource {
  addEventListener() {}
  close() {}
}

const sdkCall = Effect.fn("BrowserTest.sdkCall")(<A,>(call: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(call()),
    catch: (cause) => new Cause.UnknownError(cause),
  }),
);

/** One owned session with a short conversation and one queued message, read to the end. */
const openSession = Effect.gen(function* () {
  vi.stubGlobal("fetch", server);
  vi.stubGlobal("EventSource", QuietEventSource);
  sent.length = 0;
  const screen = yield* sdkCall(() =>
    render(
      <RegistryProvider>
        <QueryClientProvider client={new QueryClient()}>
          <NuqsTestingAdapter>
            <SessionEventScopeContext.Provider value={{ projectId: "p1", sessionId: "s1" }}>
              <SessionView sessionId="s1" imagesSupported={false} sendingEnabled slash={slash} />
            </SessionEventScopeContext.Provider>
          </NuqsTestingAdapter>
        </QueryClientProvider>
      </RegistryProvider>,
    ),
  );
  const input = screen.getByRole("textbox");
  yield* sdkCall(() => expect.element(input).toBeEnabled());
  yield* sdkCall(() => expect.element(screen.getByText("이전 답변")).toBeVisible());
  yield* sdkCall(() => expect.element(screen.getByText("대기 메시지")).toBeVisible());
  return { screen, input };
});

it.live("typing renders only the input box, and Enter sends what was typed", () =>
  Effect.gen(function* () {
    const { screen, input } = yield* openSession;
    panel.renders = 0;
    yield* sdkCall(() => userEvent.type(input, "새 질문"));
    yield* sdkCall(() => expect.element(input).toHaveValue("새 질문"));
    expect(panel.renders).toBe(0);

    yield* sdkCall(() => userEvent.keyboard("{Enter}"));
    yield* sdkCall(() => expect.element(input).toHaveValue(""));
    yield* sdkCall(() =>
      expect.poll(() => sent.some((line) => line.startsWith("/api/sessions/s1/runs "))).toBe(true),
    );
    expect(sent.find((line) => line.startsWith("/api/sessions/s1/runs "))).toContain("새 질문");
    yield* sdkCall(() => screen.unmount());
    vi.unstubAllGlobals();
  }),
);

it.live("editing a queued message renders only the input box, and Enter saves the edit", () =>
  Effect.gen(function* () {
    const { screen, input } = yield* openSession;
    yield* sdkCall(() => userEvent.click(input));
    yield* sdkCall(() => userEvent.keyboard("{Alt>}{ArrowUp}{/Alt}"));
    yield* sdkCall(() => expect.element(input).toHaveValue("대기 메시지"));

    panel.renders = 0;
    yield* sdkCall(() => userEvent.type(input, " 고침"));
    yield* sdkCall(() => expect.element(input).toHaveValue("대기 메시지 고침"));
    expect(panel.renders).toBe(0);
    // The unsaved text is stored once typing pauses.
    yield* sdkCall(() =>
      expect
        .poll(() => sent.some((line) => line.includes('"draft":"대기 메시지 고침"')))
        .toBe(true),
    );

    yield* sdkCall(() => userEvent.keyboard("{Enter}"));
    yield* sdkCall(() =>
      expect.poll(() => sent.some((line) => line.includes('"text":"대기 메시지 고침"'))).toBe(true),
    );
    yield* sdkCall(() => expect.element(input).toHaveValue(""));
    yield* sdkCall(() => screen.unmount());
    vi.unstubAllGlobals();
  }),
);
