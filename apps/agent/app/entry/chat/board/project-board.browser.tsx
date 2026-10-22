import { it } from "@effect/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Cause, Effect, Schema } from "effect";
import { useState } from "react";
import { render } from "vitest-browser-react";
import { expect, vi } from "vite-plus/test";
import "../../../app.css";
import { BoardIntent, ProjectKanbanCommand } from "../../api";
import type { BoardCardRef } from "./board-moves";
import { ProjectBoard } from "./project-board";

/** A posted body back from the JSON the page sent; only its shape as a value matters here. */
const decodeBody = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

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
  rank: 0,
};
const logging = {
  sessionId: "session-b",
  sessionTitle: null,
  plan: { version: 1, status: "executing", summary: "로그 수집" },
  counts: { ...noCards, ready: 1 },
  kanbanActive: false,
  updatedAt: "2026-10-20T01:00:00.000Z",
  rank: 1,
};
/** A Plan not executing yet: named on the board, its cards not shown. */
const alerts = {
  sessionId: "session-c",
  sessionTitle: "알림 설계",
  plan: { version: 1, status: "ready", summary: "알림 채널" },
  counts: { ...noCards, ready: 2 },
  kanbanActive: false,
  updatedAt: "2026-10-19T01:00:00.000Z",
  rank: 2,
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
  "session-c": {
    plan: alerts.plan,
    cards: [card("c1", "채널 고르기", "ready"), card("c2", "템플릿", "ready")],
    history: [],
    pendingChanges: [],
  },
};

const requests: string[] = [];
/** The JSON bodies the page posted, as sent. */
const sent: string[] = [];
/** The server behind the real API client and transport. */
const server = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const request = new Request(input, init);
  const { pathname } = new URL(request.url);
  requests.push(`${request.method} ${pathname}`);
  if (request.method === "POST")
    return request.text().then((body) => {
      sent.push(body);
      return Response.json(
        pathname === "/api/projects/project-1/kanban"
          ? { protectedBranches: [], goalOrder: ["session-b", "session-a", "session-c"] }
          : { applied: true },
      );
    });
  if (pathname === "/api/projects/project-1/boards")
    return Promise.resolve(Response.json([payments, logging, alerts]));
  if (pathname === "/api/projects/project-1/decisions") return Promise.resolve(Response.json([]));
  const session = /^\/api\/sessions\/(session-[abc])\/(board|kanban)$/.exec(pathname);
  if (session?.[2] === "kanban") return Promise.resolve(Response.json({ active: false }));
  if (session?.[1] === "session-a" || session?.[1] === "session-b" || session?.[1] === "session-c")
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

it.live("project board shows the executing Plans in order, moves a Goal and moves a card", () =>
  Effect.gen(function* () {
    vi.stubGlobal("fetch", server);
    const opened = vi.fn();
    const screen = yield* sdkCall(() => render(<Harness onOpenSession={opened} />));

    // Executing Plans share the columns; each card names its conversation. A Plan not executing
    // is only named, and its cards are not even read.
    yield* sdkCall(() => expect.element(screen.getByText("결제 요청")).toBeVisible());
    yield* sdkCall(() => expect.element(screen.getByText("로그 포맷")).toBeVisible());
    expect(requests).toContain("GET /api/sessions/session-a/board");
    expect(requests).toContain("GET /api/sessions/session-b/board");
    expect(requests).not.toContain("GET /api/sessions/session-c/board");
    yield* sdkCall(() => screen.getByRole("button", { name: "알림 설계 (준비 완료)" }).click());
    expect(opened).toHaveBeenCalledWith("session-c");

    // The status panel has a line per executing conversation in the priority tree's order; the
    // arrows move a Goal, and "대화 열기" goes to that conversation.
    yield* sdkCall(() => screen.getByRole("button", { name: "대화별 상태 · 순서 · 동작" }).click());
    yield* sdkCall(() =>
      expect.element(screen.getByRole("heading", { name: "결제 모듈" })).toBeVisible(),
    );
    yield* sdkCall(() =>
      expect.element(screen.getByRole("heading", { name: "제목 없는 대화" })).toBeVisible(),
    );
    yield* sdkCall(() =>
      expect.element(screen.getByRole("button", { name: "결제 모듈 위로" })).toBeDisabled(),
    );
    yield* sdkCall(() => screen.getByRole("button", { name: "제목 없는 대화 위로" }).click());
    yield* sdkCall(() =>
      expect.poll(() => requests).toContain("POST /api/projects/project-1/kanban"),
    );
    const moves = yield* Effect.forEach(sent, (body) => decodeBody(body));
    expect(moves.find(ProjectKanbanCommand.$is("MoveGoal"))).toEqual(
      ProjectKanbanCommand.MoveGoal({ sessionId: "session-b", before: "session-a" }),
    );
    yield* sdkCall(() =>
      screen
        .getByRole("region", { name: "결제 모듈 대화" })
        .getByRole("button", { name: "대화 열기" })
        .click(),
    );
    expect(opened).toHaveBeenCalledWith("session-a");

    // Opening a card peeks it beside the board; from there it can move to another conversation.
    // The columns scroll sideways at this width, so the card's column is brought into view first.
    screen
      .getByRole("region", { name: "준비 1개" })
      .element()
      .scrollIntoView({ inline: "start", block: "nearest" });
    yield* sdkCall(() => screen.getByText("로그 포맷").click());
    yield* sdkCall(() =>
      expect.element(screen.getByRole("heading", { name: "로그 포맷" })).toBeVisible(),
    );
    yield* sdkCall(() => screen.getByRole("combobox", { name: "옮길 대화" }).click());
    yield* sdkCall(() => screen.getByRole("option", { name: "결제 모듈" }).click());
    yield* sdkCall(() => screen.getByRole("button", { name: "옮기기" }).click());
    const confirm = screen.getByRole("dialog", { name: "다른 대화로 옮길까요?" });
    yield* sdkCall(() => expect.element(confirm).toBeVisible());
    yield* sdkCall(() => confirm.getByRole("button", { name: "옮기기" }).click());
    yield* sdkCall(() =>
      expect.poll(() => requests).toContain("POST /api/sessions/session-b/kanban"),
    );
    // The card leaves its own conversation's board for the other Plan's end.
    const bodies = yield* Effect.forEach(sent, (body) => decodeBody(body));
    expect(bodies.find(BoardIntent.$is("Transfer"))).toEqual(
      BoardIntent.Transfer({ cardId: "b1", toSessionId: "session-a", at: null }),
    );
    vi.unstubAllGlobals();
  }),
);
