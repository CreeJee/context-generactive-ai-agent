import { it } from "@effect/vitest";
import { Cause, Effect, Schema } from "effect";
import { render } from "vitest-browser-react";
import { ReportDeliveryCommand as DeliveryCommand } from "memory-agent/app-api";
import { ReportDeliveryResult } from "memory-agent/definitions";
import { describe, expect, vi } from "vite-plus/test";
import "../../app.css";
import { reportCopy } from "./copy";
import { ReportDelivery } from "./report-delivery";

const DeliveryCommandJson = Schema.fromJsonString(DeliveryCommand);
import { DiagnosisState, ReportDiagnosisReview } from "./report-diagnosis";

describe("report review and delivery", () => {
  it.live("sends the reviewed text to the server's webhook and falls back on failure", () =>
    Effect.gen(function* () {
      const replies = [
        Response.json({ configured: true, webhookIdSuffix: "5678", defectReports: true }),
        new Response(null, { status: 504 }),
        Response.json(
          ReportDeliveryResult.cases.uncertain_duplicate.make({
            attemptedAt: "2026-10-12T00:00:00.000Z",
          }),
        ),
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

      const copy = reportCopy.delivery;
      yield* sdkCall(() =>
        expect.element(screen.getByText(copy.configured("5678", false))).toBeVisible(),
      );

      yield* sdkCall(() => screen.getByRole("button", { name: copy.send }).click());
      yield* sdkCall(() =>
        expect.element(screen.getByText(copy.outcome.failed(copy.failure.uncertain))).toBeVisible(),
      );
      yield* sdkCall(() => screen.getByRole("button", { name: copy.send }).click());
      yield* sdkCall(() =>
        expect.element(screen.getByRole("button", { name: copy.resend })).toBeVisible(),
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
      const copy = reportCopy.diagnosis;
      yield* sdkCall(() =>
        expect.element(screen.getByRole("group", { name: copy.observations })).toBeVisible(),
      );
      yield* sdkCall(() => expect.element(screen.getByText(copy.evidence("run-2"))).toBeVisible());
      yield* sdkCall(() =>
        screen
          .getByRole("group", { name: copy.hypotheses })
          .getByRole("button", { name: copy.remove })
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
