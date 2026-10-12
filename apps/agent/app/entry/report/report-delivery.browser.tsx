import { it } from "@effect/vitest";
import { Cause, Effect, Schema } from "effect";
import { render } from "vitest-browser-react";
import { describe, expect, vi } from "vite-plus/test";
import "../../app.css";
import { ReportDelivery } from "./report-delivery";
import { ReportDiagnosisReview, type DiagnosisState } from "./report-diagnosis";

describe("report review and delivery", () => {
  it.live("configures a webhook, sends the reviewed text and falls back on failure", () =>
    Effect.gen(function* () {
      const replies = [
        Response.json({ configured: false, webhookIdSuffix: null }),
        Response.json({ configured: true, webhookIdSuffix: "5678" }),
        new Response(null, { status: 504 }),
        Response.json({ status: "uncertain_duplicate", attemptedAt: "2026-10-12T00:00:00.000Z" }),
      ];
      const bodies: string[] = [];
      const fetch = vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
        const body = init?.body;
        if (Schema.is(Schema.String)(body)) bodies.push(body);
        return Promise.resolve(replies.shift() ?? new Response(null, { status: 500 }));
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => fetch.mockRestore()));
      const screen = yield* sdkCall(() => render(<ReportDelivery text="# 제보 문안" />));

      yield* sdkCall(() =>
        screen
          .getByLabelText("개발자 Discord 웹훅 주소")
          .fill("https://discord.com/api/webhooks/1/x"),
      );
      yield* sdkCall(() => screen.getByRole("button", { name: "저장" }).click());
      yield* sdkCall(() => expect.element(screen.getByText(/웹훅 …5678 설정됨/)).toBeVisible());
      expect(screen.container.textContent).not.toContain("discord.com/api/webhooks");

      yield* sdkCall(() => screen.getByRole("button", { name: "Discord로 보내기" }).click());
      yield* sdkCall(() =>
        expect.element(screen.getByText(/채널에 이미 올라갔을 수 있어요/)).toBeVisible(),
      );
      yield* sdkCall(() =>
        expect.element(screen.getByText(/복사·텍스트 파일 저장으로 직접 게시/)).toBeVisible(),
      );
      yield* sdkCall(() => screen.getByRole("button", { name: "Discord로 보내기" }).click());
      yield* sdkCall(() =>
        expect.element(screen.getByRole("button", { name: "그래도 다시 보내기" })).toBeVisible(),
      );
      expect(bodies.at(-1)).toBe('{"action":"send","text":"# 제보 문안","resend":false}');
    }).pipe(Effect.scoped),
  );

  it.live("keeps observations and hypotheses apart and lets the user remove one", () =>
    Effect.gen(function* () {
      const states: DiagnosisState[] = [];
      const screen = yield* sdkCall(() =>
        render(
          <ReportDiagnosisReview
            state={{
              status: "ready",
              included: true,
              diagnosis: {
                observations: [{ text: "승인 요청 3회", evidenceIds: ["approval:1"] }],
                hypotheses: [{ text: "응답 저장 누락 가능성" }],
              },
            }}
            onRequest={() => {}}
            onChange={(next) => states.push(next)}
          />,
        ),
      );
      yield* sdkCall(() =>
        expect.element(screen.getByRole("group", { name: "관측 (증거에서 확인)" })).toBeVisible(),
      );
      yield* sdkCall(() => expect.element(screen.getByText("근거: approval:1")).toBeVisible());
      yield* sdkCall(() =>
        screen
          .getByRole("group", { name: "가설 (검증되지 않음)" })
          .getByRole("button", { name: "이 항목 빼기" })
          .click(),
      );
      expect(states.at(-1)).toMatchObject({ diagnosis: { hypotheses: [] } });
    }),
  );
});

const sdkCall = Effect.fn("BrowserTest.sdkCall")(<A,>(call: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(call()),
    catch: (cause) => new Cause.UnknownError(cause),
  }),
);
