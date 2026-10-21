import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, test, vi } from "vite-plus/test";
import ReportPage from "../../routes/report";
import { ReportLink, reportHref } from "./report-link";
import { BundleEvent, type ReportBundle } from "memory-agent/definitions";
import { reportText, shareableText } from "./report-draft";

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
      expect(html).toContain("어떤 문제가 있었나요?");
      expect(html).toContain("report-preview");
      expect(html).toContain("자동으로");
      expect(html).toContain("제보문 복사");
      expect(html).toContain("텍스트 파일 저장");
      expect(html).toContain("민감정보를 확인하고 편집하세요");
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
    expect(text).toContain("첨부된 증거 없음");
  });

  test("summarises the bundle's failures in the draft and carries the whole bundle when shared", () => {
    const text = (value: string) => ({ text: value, cut: false });
    const bundle: ReportBundle = {
      version: 1,
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
    const evidence = { status: "collected", bundle } as const;
    const draft = reportText({
      fields: { symptom: "파일을 못 읽어요", expected: "", actual: "" },
      createdAt: "2026-10-18",
      evidence,
    });
    expect(draft).toContain("세션 #abc123, run 1/40개");
    expect(draft).toContain("- run-40 completed; 실패한 도구 run-40/call-2 read_file");
    expect(draft).toContain("MCP·외부 에이전트: 수집 실패");
    expect(draft).toContain("세션 타임라인: 오래된 항목은 상한 때문에 빠졌음");
    expect(draft).not.toContain("ENOENT x");
    expect(shareableText(draft, evidence)).toContain('"text": "ENOENT x"');
    expect(shareableText(draft, { status: "failed" })).toBe(draft);
  });

  test("labels model observations and hypotheses apart, and survives a failed diagnosis", () => {
    const fields = { symptom: "승인이 반복돼요", expected: "", actual: "" };
    const included = reportText({
      fields,
      createdAt: "2026-10-12",
      diagnosis: {
        status: "included",
        diagnosis: {
          summary: "승인 응답이 저장되지 않아 같은 요청이 반복된다.",
          observations: [{ text: "승인 요청 3회", evidenceIds: ["run-2"] }],
          hypotheses: [{ text: "응답 저장 누락 가능성" }],
        },
      },
    });
    expect(included).toContain(
      "## AI 진단 요약 (사용자가 검토함)\n승인 응답이 저장되지 않아 같은 요청이 반복된다.",
    );
    expect(included).toContain("관측 (증거 묶음에서 확인)\n- 승인 요청 3회 (근거: run-2)");
    expect(included).toContain("가설 (검증되지 않은 추정)\n- 응답 저장 누락 가능성");

    const failed = reportText({
      fields,
      createdAt: "2026-10-12",
      diagnosis: { status: "failed", reason: "model_unavailable" },
    });
    expect(failed).toContain("승인이 반복돼요");
    expect(failed).toContain("AI 진단: 실패");
  });
});
