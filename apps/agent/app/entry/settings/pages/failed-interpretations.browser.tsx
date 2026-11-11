import { it } from "@effect/vitest";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Cause, Effect } from "effect";
import { render } from "vitest-browser-react";
import { expect, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "../../../app.css";
import { AppEventsProvider } from "../../events/providers";
import { appQueryKeys } from "../../queries/keys";
import { FailedInterpretations } from "./failed-interpretations";

/** How many failed statements the server reports, and the retries the page sent. */
const served = { failed: 0, retries: 0 };

const server = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const request = new Request(input, init);
  const { pathname } = new URL(request.url);
  if (pathname === "/api/settings/interpretation")
    return Promise.resolve(Response.json({ failed: served.failed }));
  if (pathname === "/api/settings/interpretation/retry" && request.method === "POST") {
    served.retries += 1;
    served.failed = 0;
    return Promise.resolve(Response.json({ failed: 0 }));
  }
  return Promise.resolve(Response.json({ error: "not_found" }, { status: 404 }));
};

/** The app's event stream, which the test speaks for. */
class TestEventSource extends EventTarget {
  static current: TestEventSource | null = null;
  constructor() {
    super();
    TestEventSource.current = this;
  }
  close() {}
}
const interpretationChanged = (revision: number) =>
  TestEventSource.current?.dispatchEvent(
    new MessageEvent("changed", {
      data: JSON.stringify({ scope: "global", topic: "interpretation", revision }),
    }),
  );

const sdkCall = Effect.fn("BrowserTest.sdkCall")(<A,>(call: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(call()),
    catch: (cause) => new Cause.UnknownError(cause),
  }),
);

it.live("failed statements show with a retry button only while some remain", () =>
  Effect.gen(function* () {
    served.failed = 0;
    served.retries = 0;
    TestEventSource.current = null;
    const client = new QueryClient();
    vi.stubGlobal("fetch", server);
    vi.stubGlobal("EventSource", TestEventSource);
    const screen = yield* sdkCall(() =>
      render(
        <I18nProvider i18n={i18n}>
          <QueryClientProvider client={client}>
            <AppEventsProvider>
              <p>기억 설정</p>
              <FailedInterpretations />
            </AppEventsProvider>
          </QueryClientProvider>
        </I18nProvider>,
      ),
    );
    // Nothing is shown once the count is read as none. An event while the first read is under
    // way joins that read, so the test waits for it.
    yield* sdkCall(() =>
      expect
        .poll(() => client.getQueryState(appQueryKeys.global.interpretation)?.status)
        .toBe("success"),
    );
    yield* sdkCall(() => expect.element(screen.getByText("기억 설정")).toBeVisible());
    yield* sdkCall(() =>
      expect.element(screen.getByText(/해석하지 못한 발언/u)).not.toBeInTheDocument(),
    );

    // A run left statements failed; the server says so and the page reads the count again.
    served.failed = 12;
    interpretationChanged(1);
    yield* sdkCall(() => expect.element(screen.getByText("해석하지 못한 발언 12개")).toBeVisible());

    yield* sdkCall(() => userEvent.click(screen.getByRole("button", { name: "다시 시도" })));
    yield* sdkCall(() =>
      expect.element(screen.getByText(/해석하지 못한 발언/u)).not.toBeInTheDocument(),
    );
    expect(served.retries).toBe(1);

    yield* sdkCall(() => screen.unmount());
    vi.unstubAllGlobals();
  }),
);
