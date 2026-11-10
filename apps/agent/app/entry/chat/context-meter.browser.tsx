import { it } from "@effect/vitest";
import { Cause, Effect } from "effect";
import { render } from "vitest-browser-react";
import { expect } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";
import "../../app.css";
import { ContextMeter } from "./context-meter";
import { chatCopy } from "./copy";

const copy = chatCopy.contextMeter;

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
    yield* sdkCall(() => screen.getByRole("button", { name: new RegExp(copy.label) }).hover());
    yield* sdkCall(() =>
      expect.element(page.getByText(copy.stages.summarize.detail)).toBeVisible(),
    );
    const card = page.getByText(copy.lastRequest).element().closest("dl");
    expect(card?.textContent).toContain(`${copy.lastRequest}${copy.tokenCount("13만")}`);
    expect(card?.textContent).toContain(`${copy.windowLimit}${copy.tokenCount("20만")}`);
    expect(card?.textContent).toContain(`${copy.cache}${copy.cacheUsage("9.1만", 70)}`);
    expect(card?.textContent).toContain(`${copy.compaction}${copy.stages.summarize.label}`);
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
    yield* sdkCall(() => screen.getByRole("button", { name: new RegExp(copy.label) }).hover());
    yield* sdkCall(() => expect.element(page.getByText(copy.noRequestYet)).toBeVisible());
    const card = page.getByText(copy.windowLimit).element().closest("dl");
    expect(card?.textContent).toBe(`${copy.windowLimit}${copy.unknown}`);
    expect(page.getByText(copy.lastRequest).query()).toBeNull();
  }),
);
