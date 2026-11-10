import { it } from "@effect/vitest";
import { RegistryProvider } from "@effect/atom-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Array as Arr, Cause, Effect } from "effect";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import { render } from "vitest-browser-react";
import { expect, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "../../app.css";
import type { SessionRunState } from "memory-agent/definitions";
import { SessionEventScopeContext } from "../events/context";
import { allowedWorkflowActions, workflowFixture } from "../session/workflow-test-fixtures";
import { SessionView, type SlashSupport } from "./chat-panel";
import { chatCopy } from "./copy";

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
  workflow: { phase: "chat", mode: "plan", goal: null, plan: null, ledger: [] },
  actions: allowedWorkflowActions,
  uncertainRuns: [],
};

/** A board card with only what the chat's list reads. */
const boardCard = (id: string, title: string, status: string) => ({
  card: {
    id,
    title,
    description: "",
    dependsOn: [],
    acceptanceCriteria: [],
    ruleRefs: [],
    outcomes: ["O1"],
    status,
    evidence: [],
  },
  lastChange: null,
});

/** A Plan of ten cards waiting for approval, serving the Goal's one outcome. */
const draftBoard = {
  plan: { version: 4, status: "ready", summary: "Test the policy" },
  cards: [
    boardCard("c1", "정책 읽기", "ready"),
    ...Arr.makeBy(9, (index) =>
      boardCard(`c${index + 2}`, `테스트 고치기 ${index + 2}`, "backlog"),
    ),
  ],
  outcomes: [
    {
      id: "O1",
      text: "정책 테스트가 통과한다",
      status: { _tag: "InProgress", pending: ["c1", "c2"] },
    },
  ],
  history: [],
  pendingChanges: [],
};

/** The same Plan running: the card that waits for a person sits last in the Plan. */
const runningBoard: typeof draftBoard = {
  ...draftBoard,
  plan: { ...draftBoard.plan, status: "executing" },
  cards: [
    boardCard("c1", "정책 읽기", "done"),
    boardCard("c2", "테스트 고치기", "in_progress"),
    boardCard("c3", "배포 결정", "human_decision"),
  ],
};

/** What the server answers for the session; a test may swap it before opening the session. */
const served = { run: runState, board: draftBoard };

/** The changes the page sent: path and body. */
const sent: string[] = [];

/** The server behind the real API clients; changes other than the lease are only recorded. */
const server = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const request = new Request(input, init);
  const { pathname } = new URL(request.url);
  if (pathname === "/api/sessions/s1/lease")
    return Promise.resolve(Response.json({ state: "mine" }));
  if (pathname === "/api/sessions/s1" && request.method === "GET")
    return Promise.resolve(Response.json(served.run));
  if (pathname === "/api/sessions/s1/messages")
    return Promise.resolve(
      Response.json({ messages, older: null, activeRun: null, interrupts: null }),
    );
  if (pathname === "/api/sessions/s1/board") return Promise.resolve(Response.json(served.board));
  if (pathname === "/api/sessions/s1/kanban")
    return Promise.resolve(Response.json({ active: false }));
  if (pathname === "/api/sessions/s1/decisions") return Promise.resolve(Response.json([]));
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

it.live("leaving a running board asks first, and only a confirmed move is sent", () =>
  Effect.gen(function* () {
    served.run = { ...runState, workflow: { ...workflowFixture, phase: "running" } };
    const { screen } = yield* openSession;
    const moves = () => sent.filter((line) => line.includes('"Move"'));
    const chat = screen.getByRole("button", { name: "Chat", exact: true });

    yield* sdkCall(() => userEvent.click(chat));
    yield* sdkCall(() =>
      expect.element(screen.getByText(chatCopy.chatPanel.leave.toChatTitle)).toBeVisible(),
    );
    yield* sdkCall(() =>
      userEvent.click(screen.getByRole("button", { name: chatCopy.chatPanel.leave.keep })),
    );
    expect(moves()).toEqual([]);

    yield* sdkCall(() => userEvent.click(chat));
    yield* sdkCall(() =>
      userEvent.click(screen.getByRole("button", { name: chatCopy.chatPanel.leave.change })),
    );
    yield* sdkCall(() => expect.poll(() => moves().length).toBe(1));
    expect(moves()[0]).toContain('"move":"chat"');
    served.run = runState;
    yield* sdkCall(() => screen.unmount());
    vi.unstubAllGlobals();
  }),
);

it.live("a Plan of ten cards waiting for approval lists them one line each", () =>
  Effect.gen(function* () {
    served.run = { ...runState, workflow: workflowFixture };
    const { screen } = yield* openSession;
    const bar = screen.getByRole("region", { name: chatCopy.workflow.label });

    yield* sdkCall(() =>
      expect.element(bar.getByText(`Plan · ${chatCopy.workflow.stages.shaping}`)).toBeVisible(),
    );
    // A Plan still waiting for approval opens unfolded, its cards in the Plan's order.
    const cards = bar
      .getByRole("region", { name: chatCopy.boardPanel.cardsDone(0, 10) })
      .getByRole("link");
    yield* sdkCall(() => expect.poll(() => cards.elements().length).toBe(10));
    const first = cards.first();
    expect(first.element().textContent).toContain("정책 읽기");
    expect(first.element().getAttribute("href")).toContain("card=c1");
    // One line a card, so ten of them stay short.
    expect(first.element().getBoundingClientRect().height).toBe(24);
    yield* sdkCall(() => expect.element(bar.getByText("정책 테스트가 통과한다")).toBeVisible());
    yield* sdkCall(() =>
      expect
        .element(bar.getByRole("button", { name: chatCopy.workflow.approveAndRun }))
        .toBeEnabled(),
    );
    served.run = runState;
    yield* sdkCall(() => screen.unmount());
    vi.unstubAllGlobals();
  }),
);

it.live("a running Plan stays one line until unfolded, the cards that need a look first", () =>
  Effect.gen(function* () {
    served.run = { ...runState, workflow: { ...workflowFixture, phase: "running" } };
    served.board = runningBoard;
    const { screen } = yield* openSession;
    const bar = screen.getByRole("region", { name: chatCopy.workflow.label });
    const fold = bar.getByRole("button", {
      name: new RegExp(`Plan · ${chatCopy.workflow.stages.running}`),
    });

    yield* sdkCall(() => expect.element(fold).toBeVisible());
    yield* sdkCall(() =>
      expect.element(bar.getByText(chatCopy.boardPanel.cardTally(1, 3))).toBeVisible(),
    );
    // Folded, the cards are on the page but not shown.
    yield* sdkCall(() => expect.element(bar.getByText("배포 결정")).not.toBeVisible());
    yield* sdkCall(() => userEvent.click(fold));
    const cards = bar.getByRole("region", { name: chatCopy.boardPanel.cardsDone(1, 3) });
    yield* sdkCall(() => expect.element(cards).toBeVisible());
    expect(
      cards
        .getByRole("link")
        .elements()
        .map((link) => link.textContent),
    ).toEqual([
      expect.stringContaining("배포 결정"),
      expect.stringContaining("테스트 고치기"),
      expect.stringContaining("정책 읽기"),
    ]);
    served.run = runState;
    served.board = draftBoard;
    yield* sdkCall(() => screen.unmount());
    vi.unstubAllGlobals();
  }),
);
