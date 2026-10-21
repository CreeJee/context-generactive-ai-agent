import { it } from "@effect/vitest";
import { Cause, Effect, Schema } from "effect";
import { render } from "vitest-browser-react";
import { describe, expect, vi } from "vite-plus/test";
import "../../app.css";
import { ReportDelivery } from "./report-delivery";
import { DeliveryCommand } from "./report-client";

const DeliveryCommandJson = Schema.fromJsonString(DeliveryCommand);
import { DiagnosisState, ReportDiagnosisReview } from "./report-diagnosis";

describe("report review and delivery", () => {
  it.live("sends the reviewed text to the server's webhook and falls back on failure", () =>
    Effect.gen(function* () {
      const replies = [
        Response.json({ configured: true, webhookIdSuffix: "5678", defectReports: true }),
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
      const screen = yield* sdkCall(() =>
        render(<ReportDelivery text="# 제보 문안" evidence={null} />),
      );

      yield* sdkCall(() => expect.element(screen.getByText(/개발자 웹훅 …5678/)).toBeVisible());

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
      expect(yield* Schema.decodeEffect(DeliveryCommandJson)(bodies.at(-1) ?? "null")).toEqual(
        DeliveryCommand.cases.send.make({ text: "# 제보 문안", evidence: null, resend: false }),
      );
    }).pipe(Effect.scoped),
  );

  it.live("keeps observations and hypotheses apart and lets the user remove one", () =>
    Effect.gen(function* () {
      const states: DiagnosisState[] = [];
      const screen = yield* sdkCall(() =>
        render(
          <ReportDiagnosisReview
            state={DiagnosisState.ready({
              included: true,
              diagnosis: {
                summary: "승인 응답이 저장되지 않았다.",
                observations: [{ text: "승인 요청 3회", evidenceIds: ["run-2"] }],
                hypotheses: [{ text: "응답 저장 누락 가능성" }],
              },
            })}
            onRequest={() => {}}
            onChange={(next) => states.push(next)}
          />,
        ),
      );
      yield* sdkCall(() =>
        expect
          .element(screen.getByRole("group", { name: "관측 (증거 묶음에서 확인)" }))
          .toBeVisible(),
      );
      yield* sdkCall(() => expect.element(screen.getByText("근거: run-2")).toBeVisible());
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
