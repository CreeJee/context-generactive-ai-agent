import { it } from "@effect/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Cause, Effect } from "effect";
import { useState } from "react";
import { render } from "vitest-browser-react";
import { expect, vi } from "vite-plus/test";
import "../../../app.css";
import { ProjectBoard, type BoardCardRef } from "./project-board";

const noCards = {
  backlog: 0,
  ready: 0,
  in_progress: 0,
  verify: 0,
  human_decision: 0,
  done: 0,
  blocked: 0,
};
const card = (id: string, title: string, status: string, dependsOn: readonly string[] = []) => ({
  card: {
    id,
    title,
    description: "",
    dependsOn,
    acceptanceCriteria: [],
    ruleRefs: [],
    status,
    evidence: [],
  },
  lastChange: null,
});
const payments = {
  sessionId: "session-a",
  sessionTitle: "결제 모듈",
  plan: { version: 3, status: "executing", summary: "결제 플로우 정리" },
  counts: { ...noCards, done: 1, in_progress: 1 },
  kanbanActive: true,
  updatedAt: "2026-10-21T01:00:00.000Z",
};
const logging = {
  sessionId: "session-b",
  sessionTitle: null,
  plan: { version: 1, status: "ready", summary: "로그 수집" },
  counts: { ...noCards, ready: 1 },
  kanbanActive: false,
  updatedAt: "2026-10-20T01:00:00.000Z",
};
const boards = {
  "session-a": {
    plan: payments.plan,
    cards: [card("a1", "토큰 저장", "done"), card("a2", "결제 요청", "in_progress", ["a1"])],
    history: [],
    pendingChanges: [],
  },
  "session-b": {
    plan: logging.plan,
    cards: [card("b1", "로그 포맷", "ready")],
    history: [],
    pendingChanges: [],
  },
};

const requests: string[] = [];
/** The server behind the real API client and transport. */
const server = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const request = new Request(input, init);
  const { pathname } = new URL(request.url);
  requests.push(`${request.method} ${pathname}`);
  if (pathname === "/api/projects/project-1/boards")
    return Promise.resolve(Response.json([payments, logging]));
  if (pathname === "/api/projects/project-1/decisions") return Promise.resolve(Response.json([]));
  const session = /^\/api\/sessions\/(session-[ab])\/(board|kanban)$/.exec(pathname);
  if (session?.[2] === "kanban") return Promise.resolve(Response.json({ active: false }));
  if (session?.[1] === "session-a" || session?.[1] === "session-b")
    return Promise.resolve(Response.json(boards[session[1]]));
  return Promise.resolve(Response.json({ error: "not_found" }, { status: 404 }));
};

const sdkCall = Effect.fn("BrowserTest.sdkCall")(<A,>(call: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(call()),
    catch: (cause) => new Cause.UnknownError(cause),
  }),
);

/** The page's part: the peeked card lives in the URL, so the board gets it back as a prop. */
function Harness({ onOpenSession }: { readonly onOpenSession: (sessionId: string) => void }) {
  const [peek, setPeek] = useState<BoardCardRef | null>(null);
  return (
    <QueryClientProvider client={new QueryClient()}>
      <ProjectBoard
        projectId="project-1"
        holder="page-1"
        peek={peek}
        onPeek={setPeek}
        onOpenSession={onOpenSession}
        onClose={() => {}}
      />
    </QueryClientProvider>
  );
}

it.live("project board shows every conversation's cards as a lane and peeks a card", () =>
  Effect.gen(function* () {
    vi.stubGlobal("fetch", server);
    const opened = vi.fn();
    const screen = yield* sdkCall(() => render(<Harness onOpenSession={opened} />));

    yield* sdkCall(() => expect.element(screen.getByText("결제 모듈")).toBeVisible());
    yield* sdkCall(() => expect.element(screen.getByText("제목 없는 대화")).toBeVisible());
    // Each lane draws its own conversation's cards.
    yield* sdkCall(() => expect.element(screen.getByText("결제 요청")).toBeVisible());
    yield* sdkCall(() => expect.element(screen.getByText("로그 포맷")).toBeVisible());
    expect(requests).toContain("GET /api/sessions/session-a/board");
    expect(requests).toContain("GET /api/sessions/session-b/board");

    // A lane's "대화 열기" goes to that conversation.
    yield* sdkCall(() =>
      screen
        .getByRole("region", { name: "결제 모듈 보드" })
        .getByRole("button", { name: "대화 열기" })
        .click(),
    );
    expect(opened).toHaveBeenCalledWith("session-a");

    // Opening a card peeks it beside the board; the peek is a dialog over the lanes.
    yield* sdkCall(() => screen.getByText("로그 포맷").click());
    yield* sdkCall(() =>
      expect.element(screen.getByRole("heading", { name: "로그 포맷" })).toBeVisible(),
    );
    vi.unstubAllGlobals();
  }),
);
