import { it } from "@effect/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import { Cause, Effect } from "effect";
import { render } from "vitest-browser-react";
import { expect, vi } from "vite-plus/test";
import "../../app.css";
import { BtwPanel } from "./btw-panel";

const requests: string[] = [];
const earlier = {
  id: "btw-1",
  parentSessionId: "session-1",
  projectId: "project-1",
  title: "이전 질문",
  createdAt: "2026-10-12T01:00:00.000Z",
  updatedAt: 1,
};
let threads = [earlier];
const transcript = {
  messages: [
    { id: "u1", role: "user", parts: [{ type: "text", content: "이전 질문" }] },
    {
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          id: "c1",
          name: "find_memory",
          arguments: "{}",
          state: "input-complete",
        },
        { type: "text", content: "이전 답변" },
      ],
    },
  ],
  activeRun: null,
  interrupts: null,
};

/** The server behind the real API client and transport. */
const server = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const request = new Request(input, init);
  const { pathname } = new URL(request.url);
  requests.push(`${request.method} ${pathname}`);
  if (pathname === "/api/sessions/session-1/btw") return Promise.resolve(Response.json(threads));
  if (pathname === "/api/btw/btw-1/chat") return Promise.resolve(Response.json(transcript));
  if (pathname === "/api/btw/btw-1" && request.method === "DELETE") {
    threads = [];
    return Promise.resolve(Response.json({ deleted: true, filesPending: false }));
  }
  return Promise.resolve(Response.json({ error: "not_found" }, { status: 404 }));
};

const sdkCall = Effect.fn("BrowserTest.sdkCall")(<A,>(call: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(call()),
    catch: (cause) => new Cause.UnknownError(cause),
  }),
);

it.live("BTW panel opens apart, reopens a saved thread and explains what delete keeps", () =>
  Effect.gen(function* () {
    vi.stubGlobal("fetch", server);
    const screen = yield* sdkCall(() =>
      render(
        <QueryClientProvider client={new QueryClient()}>
          <NuqsTestingAdapter>
            <BtwPanel projectId="project-1" sessionId="session-1" />
          </NuqsTestingAdapter>
        </QueryClientProvider>,
      ),
    );
    yield* sdkCall(() => screen.getByRole("button", { name: "BTW 열기" }).click());
    yield* sdkCall(() =>
      expect.element(screen.getByText(/메인 대화나 검색 기억에 들어가지 않고/)).toBeVisible(),
    );

    yield* sdkCall(() => screen.getByRole("button", { name: /이전 질문/ }).click());
    yield* sdkCall(() => expect.element(screen.getByText("이전 답변")).toBeVisible());
    yield* sdkCall(() => expect.element(screen.getByText("기억 검색")).toBeVisible());
    yield* sdkCall(() =>
      expect.element(screen.getByRole("button", { name: "원래 대화로 돌아가기" })).toBeVisible(),
    );

    yield* sdkCall(() => screen.getByRole("button", { name: "BTW 삭제" }).click());
    yield* sdkCall(() =>
      expect
        .element(screen.getByText(/백업, 데이터베이스 파일에 남은 빈 공간이나 WAL/))
        .toBeVisible(),
    );
    yield* sdkCall(() => screen.getByRole("button", { name: "삭제", exact: true }).click());
    yield* sdkCall(() => expect.element(screen.getByText("BTW를 삭제했어요.")).toBeVisible());
    expect(requests).toContain("DELETE /api/btw/btw-1");
    yield* sdkCall(() =>
      expect.element(screen.getByRole("button", { name: /이전 질문/ })).not.toBeInTheDocument(),
    );
    vi.unstubAllGlobals();
  }),
);
