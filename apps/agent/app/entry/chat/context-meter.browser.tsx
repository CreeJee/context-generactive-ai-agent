import { it } from "@effect/vitest";
import { Cause, Effect } from "effect";
import { render } from "vitest-browser-react";
import { expect } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";
import "../../app.css";
import { ContextMeter } from "./context-meter";

const sdkCall = Effect.fn("ContextMeterTest.sdkCall")(<A,>(call: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(call()),
    catch: (cause) => new Cause.UnknownError(cause),
  }),
);

it.live("context meter lays out the latest request's numbers on hover", () =>
  Effect.gen(function* () {
    const screen = yield* sdkCall(() =>
      render(
        <div className="flex justify-end p-80">
          <ContextMeter
            context={{
              usedTokens: 130_000,
              cachedTokens: 91_000,
              cacheRatio: 0.7,
              compactionStage: "summarize",
              windowTokens: 200_000,
              windowKnown: true,
              compactAtTokens: 0,
            }}
          />
        </div>,
      ),
    );
    yield* sdkCall(() => screen.getByRole("button", { name: /컨텍스트/ }).hover());
    yield* sdkCall(() =>
      expect.element(page.getByText("지난 대화 일부를 요약으로 바꿔 보냈어요.")).toBeVisible(),
    );
    const card = page.getByText("마지막 요청").element().closest("dl");
    expect(card?.textContent).toContain("마지막 요청13만 토큰");
    expect(card?.textContent).toContain("모델 한도20만 토큰");
    expect(card?.textContent).toContain("캐시9.1만 토큰 · 70%");
    expect(card?.textContent).toContain("압축요약");
  }),
);

it.live("context meter says no request was made yet", () =>
  Effect.gen(function* () {
    const screen = yield* sdkCall(() =>
      render(
        <div className="flex justify-end p-80">
          <ContextMeter
            context={{
              usedTokens: null,
              cachedTokens: null,
              cacheRatio: null,
              compactionStage: null,
              windowTokens: 128_000,
              windowKnown: false,
              compactAtTokens: 0,
            }}
          />
        </div>,
      ),
    );
    yield* sdkCall(() => screen.getByRole("button", { name: /컨텍스트/ }).hover());
    yield* sdkCall(() =>
      expect.element(page.getByText("이 대화로 아직 모델에 요청하지 않았어요.")).toBeVisible(),
    );
    const card = page.getByText("모델 한도").element().closest("dl");
    expect(card?.textContent).toBe("모델 한도알 수 없음");
    expect(page.getByText("마지막 요청").query()).toBeNull();
  }),
);
