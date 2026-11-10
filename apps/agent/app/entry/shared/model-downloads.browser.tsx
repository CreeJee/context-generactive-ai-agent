import { it } from "@effect/vitest";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Cause, Effect } from "effect";
import type { ReactNode } from "react";
import { render } from "vitest-browser-react";
import { expect, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "../../app.css";
import type { ModelDownload } from "../api";
import { AppEventsProvider } from "../events/providers";
import { ModelDownloadList, TurnWaitsForModel } from "./model-downloads";

const embedding = (loaded: number, total: number, secondsLeft: number | null): ModelDownload => ({
  _tag: "downloading",
  purpose: "embedding",
  model: "onnx-community/embeddinggemma-2-ONNX",
  loaded,
  total,
  secondsLeft,
});

/** What the server answers for the downloads, and the changes the page sent. */
interface Served {
  downloads: readonly ModelDownload[];
}
const served: Served = { downloads: [] };
const sent: string[] = [];

const server = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const request = new Request(input, init);
  const { pathname } = new URL(request.url);
  if (pathname === "/api/settings/model-downloads")
    return Promise.resolve(Response.json(served.downloads));
  if (request.method === "POST")
    return request.text().then((body) => {
      sent.push(`${pathname} ${body}`);
      return Response.json(served.downloads);
    });
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
const downloadsChanged = (revision: number) =>
  TestEventSource.current?.dispatchEvent(
    new MessageEvent("changed", {
      data: JSON.stringify({ scope: "global", topic: "downloads", revision }),
    }),
  );

const sdkCall = Effect.fn("BrowserTest.sdkCall")(<A,>(call: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(call()),
    catch: (cause) => new Cause.UnknownError(cause),
  }),
);

const show = (ui: ReactNode, downloads: readonly ModelDownload[]) =>
  Effect.gen(function* () {
    served.downloads = downloads;
    sent.length = 0;
    vi.stubGlobal("fetch", server);
    vi.stubGlobal("EventSource", TestEventSource);
    return yield* sdkCall(() =>
      render(
        <I18nProvider i18n={i18n}>
          <QueryClientProvider client={new QueryClient()}>
            <AppEventsProvider>{ui}</AppEventsProvider>
          </QueryClientProvider>
        </I18nProvider>,
      ),
    );
  });

const done = (screen: { unmount: () => void }) =>
  Effect.sync(() => {
    screen.unmount();
    vi.unstubAllGlobals();
  });

it.live("each download shows which model, how much of it, and the time left, live", () =>
  Effect.gen(function* () {
    const screen = yield* show(<ModelDownloadList />, [
      embedding(115_000_000, 575_000_000, 170),
      { ...embedding(0, 0, null), purpose: "rerank", model: "CreeJee/KURE-Reranker-nano-ONNX" },
    ]);
    const list = screen.getByRole("region", { name: "모델 내려받기" });
    yield* sdkCall(() => expect.element(list.getByText("임베딩 모델 내려받는 중")).toBeVisible());
    yield* sdkCall(() =>
      expect.element(list.getByText("115MB / 575MB (20%) · 남은 시간 약 3분")).toBeVisible(),
    );
    yield* sdkCall(() =>
      expect
        .element(list.getByRole("progressbar", { name: "임베딩 모델 내려받는 중" }))
        .toHaveAttribute("aria-valuenow", "20"),
    );
    yield* sdkCall(() =>
      expect.element(list.getByText("검색 결과 정렬 모델 내려받는 중")).toBeVisible(),
    );
    yield* sdkCall(() =>
      expect.element(list.getByText("내려받을 크기를 확인하는 중")).toBeVisible(),
    );

    // The server says the downloads moved on; the page reads them again.
    served.downloads = [embedding(575_000_000, 575_000_000, null)];
    downloadsChanged(1);
    yield* sdkCall(() => expect.element(list.getByText("다 내려받아 불러오는 중")).toBeVisible());
    yield* sdkCall(() =>
      expect.element(list.getByText("검색 결과 정렬 모델 내려받는 중")).not.toBeInTheDocument(),
    );

    // Once the model has loaded the list is gone.
    served.downloads = [];
    downloadsChanged(2);
    yield* sdkCall(() => expect.element(list).not.toBeInTheDocument());
    yield* done(screen);
  }),
);

it.live("a failed download says so and downloads the model again on retry", () =>
  Effect.gen(function* () {
    const screen = yield* show(<ModelDownloadList />, [
      { _tag: "failed", purpose: "embedding", model: "onnx-community/embeddinggemma-2-ONNX" },
    ]);
    const alert = screen.getByRole("alert");
    yield* sdkCall(() =>
      expect
        .element(
          alert.getByText(
            "임베딩 모델을 내려받지 못했습니다. 네트워크를 확인한 뒤 다시 시도해 주십시오.",
          ),
        )
        .toBeVisible(),
    );
    yield* sdkCall(() => userEvent.click(alert.getByRole("button", { name: "다시 시도" })));
    yield* sdkCall(() =>
      expect
        .poll(() => sent)
        .toEqual(['/api/settings/model-downloads/retry {"purpose":"embedding"}']),
    );
    yield* done(screen);
  }),
);

it.live("a waiting turn says the embedding model's download may hold up the answer", () =>
  Effect.gen(function* () {
    const screen = yield* show(<TurnWaitsForModel />, [embedding(287_500_000, 575_000_000, 45)]);
    yield* sdkCall(() =>
      expect
        .element(
          screen.getByText(
            "기억을 찾는 임베딩 모델을 내려받는 중이라 답이 늦어질 수 있습니다: 288MB / 575MB (50%) · 남은 시간 1분 이내",
          ),
        )
        .toBeVisible(),
    );
    yield* sdkCall(() =>
      expect
        .element(screen.getByRole("progressbar", { name: "임베딩 모델 내려받기" }))
        .toHaveAttribute("aria-valuenow", "50"),
    );
    // The files are in; the model loads before the turn goes on.
    served.downloads = [embedding(575_000_000, 575_000_000, null)];
    downloadsChanged(1);
    yield* sdkCall(() =>
      expect
        .element(
          screen.getByText("기억을 찾는 임베딩 모델을 불러오는 중이라 답이 늦어질 수 있습니다."),
        )
        .toBeVisible(),
    );
    yield* done(screen);
  }),
);

it.live("a turn does not wait for the reranker, so its download is not shown there", () =>
  Effect.gen(function* () {
    const screen = yield* show(
      <>
        <TurnWaitsForModel />
        <ModelDownloadList />
      </>,
      [{ ...embedding(1, 10, null), purpose: "rerank", model: "CreeJee/KURE-Reranker-nano-ONNX" }],
    );
    // The list was read: the reranker's download is known, and the turn says nothing of it.
    yield* sdkCall(() =>
      expect.element(screen.getByText("검색 결과 정렬 모델 내려받는 중")).toBeVisible(),
    );
    expect(screen.container.textContent).not.toContain("답이 늦어질");
    yield* done(screen);
  }),
);
