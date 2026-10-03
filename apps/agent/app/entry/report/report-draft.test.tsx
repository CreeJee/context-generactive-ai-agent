import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, test, vi } from "vite-plus/test";
import ReportPage from "../../routes/report";
import { ReportLink, reportHref } from "./report-link";
import { reportText } from "./report-draft";

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
    const text = reportText(
      { symptom: "승인이 반복돼요", expected: "채팅 계속", actual: "승인 대기" },
      "2026-09-26",
    );
    expect(text).toContain("승인이 반복돼요");
    expect(text).toContain("첨부된 증거 없음");
  });
});
