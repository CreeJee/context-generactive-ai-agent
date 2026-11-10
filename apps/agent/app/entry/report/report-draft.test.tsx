import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, test, vi } from "vite-plus/test";
import ReportPage from "../../routes/report";
import { ReportLink, reportHref } from "./report-link";
import { BundleEvent, type ReportBundle } from "memory-agent/definitions";
import { reportCopy } from "./copy";
import { DiagnosisText } from "./report-diagnosis";
import { DraftEvidence, reportText, shareableText } from "./report-draft";

describe("independent report entry", () => {
  test("report link does not require a session or a working composer", () => {
    expect(reportHref(null, null)).toBe("/report");
    expect(reportHref("project &1", "session/2")).toBe(
      "/report?project=project+%261&session=session%2F2",
    );
    expect(renderToStaticMarkup(<ReportLink projectId={null} sessionId={null} />)).toContain(
      'href="/report"',
    );
  });

  test("renders a draft without fetching session, run, or AI data", () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected fetch"));
    // Framework mode wraps the route in WithComponentProps, which reads data-router context.
    const router = createMemoryRouter([{ path: "/report", Component: ReportPage }], {
      initialEntries: ["/report"],
    });
    try {
      const html = renderToStaticMarkup(<RouterProvider router={router} />);
      expect(html).toContain(reportCopy.draft.symptom);
      expect(html).toContain("report-preview");
      expect(html).toContain(reportCopy.page.intro);
      expect(html).toContain(reportCopy.page.copy);
      expect(html).toContain(reportCopy.page.download);
      expect(html).toContain(reportCopy.draft.text);
      expect(html).not.toContain('id="report-preview" readonly');
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      router.dispose();
      fetch.mockRestore();
    }
  });

  test("keeps a usable statement when evidence is unavailable", () => {
    const text = reportText({
      fields: { symptom: "승인이 반복돼요", expected: "채팅 계속", actual: "승인 대기" },
      createdAt: "2026-09-26",
    });
    expect(text).toContain("승인이 반복돼요");
    expect(text).toContain(reportCopy.report.noEvidence);
  });

  test("summarises the bundle's failures in the draft and carries the whole bundle when shared", () => {
    const text = (value: string) => ({ text: value, cut: false });
    const bundle: ReportBundle = {
      version: 3,
      collectedAt: "2026-10-18T00:00:00Z",
      limits: { runs: 30, eventsPerRun: 60, textChars: 1_500, failureChars: 6_000 },
      environment: {
        release: "1.2.3",
        platform: "darwin-arm64",
        runtime: "node 24",
        provider: "openai",
        model: "gpt",
        kanbanConcurrency: null,
      },
      session: { ref: "abc123", title: null, runCount: 40 },
      integrations: { status: "failed", items: [], truncated: false },
      loops: { status: "empty", items: [], truncated: false },
      boards: { status: "empty", items: [], truncated: false },
      defects: { status: "empty", items: [], truncated: false },
      unlinked: { status: "empty", items: [], truncated: false },
      timeline: {
        status: "available",
        truncated: true,
        items: [
          {
            seq: 40,
            ref: "r40",
            status: "completed",
            startedAt: "2026-10-18T00:00:00Z",
            finishedAt: null,
            error: null,
            eventsCut: false,
            failedSpans: [],
            spanTotals: [],
            spanTotalsCut: false,
            events: [
              BundleEvent.cases.ToolCall.make({
                seq: 2,
                name: "read_file",
                at: "2026-10-18T00:00:01Z",
                input: text('{"path":"x"}'),
                result: { ok: false, at: "2026-10-18T00:00:02Z", text: text("ENOENT x") },
              }),
            ],
          },
        ],
      },
    };
    const evidence = DraftEvidence.collected({ bundle });
    const draft = reportText({
      fields: { symptom: "파일을 못 읽어요", expected: "", actual: "" },
      createdAt: "2026-10-18",
      evidence,
    });
    expect(draft).toContain(reportCopy.report.attachment("abc123", 1, 40));
    expect(draft).toContain(
      `- run-40 completed; ${reportCopy.report.failedTools("run-40/call-2 read_file")}`,
    );
    expect(draft).toContain(reportCopy.bundle.gapFailed(reportCopy.bundle.sections.integrations));
    expect(draft).toContain(reportCopy.bundle.gapTruncated(reportCopy.bundle.sections.timeline));
    expect(draft).not.toContain("ENOENT x");
    expect(shareableText(draft, evidence)).toContain('"text": "ENOENT x"');
    expect(shareableText(draft, DraftEvidence.failed())).toBe(draft);
  });

  test("labels model observations and hypotheses apart, and survives a failed diagnosis", () => {
    const fields = { symptom: "승인이 반복돼요", expected: "", actual: "" };
    const included = reportText({
      fields,
      createdAt: "2026-10-12",
      diagnosis: DiagnosisText.included({
        diagnosis: {
          summary: "승인 응답이 저장되지 않아 같은 요청이 반복된다.",
          observations: [{ text: "승인 요청 3회", evidenceIds: ["run-2"] }],
          hypotheses: [{ text: "응답 저장 누락 가능성" }],
        },
      }),
    });
    const copy = reportCopy.report;
    expect(included).toContain(
      `${copy.summaryHeading}\n승인 응답이 저장되지 않아 같은 요청이 반복된다.`,
    );
    expect(included).toContain(
      `${copy.observationsHeading}\n- 승인 요청 3회 (${reportCopy.diagnosis.evidence("run-2")})`,
    );
    expect(included).toContain(`${copy.hypothesesHeading}\n- 응답 저장 누락 가능성`);

    const failed = reportText({
      fields,
      createdAt: "2026-10-12",
      diagnosis: DiagnosisText.failed({ reason: "model_unavailable" }),
    });
    expect(failed).toContain("승인이 반복돼요");
    expect(failed).toContain(copy.diagnosisFailed(reportCopy.diagnosis.failure.model_unavailable));
  });
});
