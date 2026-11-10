import { it } from "@effect/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import { Cause, Effect } from "effect";
import { render } from "vitest-browser-react";
import { expect, vi } from "vite-plus/test";
import "../../app.css";
import { BtwPanel } from "./btw-panel";
import { chatCopy } from "./copy";

const copy = chatCopy.btw;

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
const messages = [
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
];

/** The server behind the real API client and transport. */
const server = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const request = new Request(input, init);
  const { pathname } = new URL(request.url);
  requests.push(`${request.method} ${pathname}`);
  if (pathname === "/api/sessions/session-1/btw") return Promise.resolve(Response.json(threads));
  if (pathname === "/api/btw/btw-1/messages") return Promise.resolve(Response.json(messages));
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
    yield* sdkCall(() => screen.getByRole("button", { name: copy.open }).click());
    yield* sdkCall(() => expect.element(screen.getByText(copy.separate)).toBeVisible());

    yield* sdkCall(() => screen.getByRole("button", { name: /이전 질문/ }).click());
    yield* sdkCall(() => expect.element(screen.getByText("이전 답변")).toBeVisible());
    yield* sdkCall(() => expect.element(screen.getByText(copy.tools.find_memory)).toBeVisible());
    yield* sdkCall(() =>
      expect.element(screen.getByRole("button", { name: copy.backToChat })).toBeVisible(),
    );

    yield* sdkCall(() => screen.getByRole("button", { name: copy.deleteLabel }).click());
    yield* sdkCall(() => expect.element(screen.getByText(copy.deleteConfirm.body)).toBeVisible());
    yield* sdkCall(() =>
      screen.getByRole("button", { name: copy.deleteConfirm.choices.delete, exact: true }).click(),
    );
    yield* sdkCall(() => expect.element(screen.getByText(copy.deleted)).toBeVisible());
    expect(requests).toContain("DELETE /api/btw/btw-1");
    yield* sdkCall(() =>
      expect.element(screen.getByRole("button", { name: /이전 질문/ })).not.toBeInTheDocument(),
    );
    vi.unstubAllGlobals();
  }),
);
