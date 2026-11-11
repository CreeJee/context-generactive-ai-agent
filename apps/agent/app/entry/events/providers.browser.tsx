import { it } from "@effect/vitest";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Cause, Effect } from "effect";
import { render } from "vitest-browser-react";
import { expect, vi } from "vite-plus/test";
import "../../app.css";
import { AppEventsProvider } from "./providers";

/** The server's event stream, which the test speaks for: it opens while the server is up. */
class TestEventSource extends EventTarget {
  static up = false;
  static opened: TestEventSource[] = [];
  constructor() {
    super();
    TestEventSource.opened.push(this);
    // The real stream answers after a network round trip, never in the step that opens it.
    Effect.runFork(
      Effect.sleep("10 millis").pipe(
        Effect.andThen(
          Effect.sync(() => this.dispatchEvent(new Event(TestEventSource.up ? "open" : "error"))),
        ),
      ),
    );
  }
  close() {}
}

const sdkCall = Effect.fn("BrowserTest.sdkCall")(<A,>(call: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(call()),
    catch: (cause) => new Cause.UnknownError(cause),
  }),
);

const lost =
  "서버와 연결이 끊겨 다시 연결하는 중입니다. 그동안 화면이 최신 상태가 아닐 수 있습니다.";
const unreachable = "서버에 연결할 수 없습니다. 앱이 실행 중인지 확인해 주십시오.";

it.live("says the stream is lost, then that the server is out of reach, and reconnects", () =>
  Effect.gen(function* () {
    // Fake timers that still move on their own, so the page runs while the test skips ahead.
    vi.useFakeTimers({
      shouldAdvanceTime: true,
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    TestEventSource.up = true;
    TestEventSource.opened = [];
    vi.stubGlobal("EventSource", TestEventSource);
    const screen = yield* sdkCall(() =>
      render(
        <I18nProvider i18n={i18n}>
          <QueryClientProvider client={new QueryClient()}>
            <AppEventsProvider>
              <p>화면</p>
            </AppEventsProvider>
          </QueryClientProvider>
        </I18nProvider>,
      ),
    );
    const spinner = () => screen.container.querySelector("[data-slot=spinner]");
    yield* sdkCall(() => expect.element(screen.getByText("화면")).toBeVisible());
    yield* sdkCall(() => vi.advanceTimersByTimeAsync(100));
    yield* sdkCall(() => expect.element(screen.getByText(lost)).not.toBeInTheDocument());

    // The server goes away; the stream fails and every try fails too.
    TestEventSource.up = false;
    TestEventSource.opened.at(-1)?.dispatchEvent(new Event("error"));
    yield* sdkCall(() => expect.element(screen.getByText(lost)).toBeVisible());
    expect(spinner()).not.toBeNull();
    expect(screen.getByRole("button", { name: "지금 다시 연결" }).query()).toBeNull();

    // After 30 s the banner says so, stops the spinner, and counts down to the next try.
    yield* sdkCall(() => vi.advanceTimersByTimeAsync(30_000));
    yield* sdkCall(() => expect.element(screen.getByText(unreachable)).toBeVisible());
    yield* sdkCall(() => expect.element(screen.getByText(/^다음 시도 \d+초 뒤$/)).toBeVisible());
    expect(screen.getByText(lost).query()).toBeNull();
    expect(spinner()).toBeNull();

    // The server is back; the button tries at once instead of waiting for the countdown.
    TestEventSource.up = true;
    const tries = TestEventSource.opened.length;
    yield* sdkCall(() => screen.getByRole("button", { name: "지금 다시 연결" }).click());
    expect(TestEventSource.opened).toHaveLength(tries + 1);
    yield* sdkCall(() => vi.advanceTimersByTimeAsync(100));
    yield* sdkCall(() => expect.element(screen.getByText(unreachable)).not.toBeInTheDocument());

    yield* sdkCall(() => screen.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }),
);
