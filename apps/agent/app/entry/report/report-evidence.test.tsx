import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vite-plus/test";
import type { ReportEvidence } from "../../.server/report-evidence";
import { reportText } from "./report-draft";
import { copyReportText } from "./report-copy";
import { evidenceGaps, evidenceItems, ReportEvidenceReview } from "./report-evidence";

const snapshot: ReportEvidence = {
  session: { id: "s1", projectId: "p1", title: null },
  runs: {
    status: "available",
    truncated: false,
    items: [
      {
        runId: "r1",
        status: "failed",
        startedAt: 100,
        finishedAt: 200,
        error: "failure",
        truncated: false,
      },
    ],
  },
  approvals: { status: "empty", truncated: false, items: [] },
  transcript: { status: "failed", truncated: false, items: [] },
  calls: {
    status: "available",
    truncated: true,
    items: [
      {
        id: "c1",
        kind: "tool_result",
        runId: "r1",
        toolCallId: "tool-1",
        toolName: "read",
        ok: false,
        createdAt: "2026-09-26",
        text: "sensitive",
        truncated: true,
      },
    ],
  },
  trace: { status: "empty", truncated: false, items: [] },
};

describe("report review and manual sharing", () => {
  test("starts with all sensitive evidence excluded and shows missing/truncated status", () => {
    const html = renderToStaticMarkup(
      <ReportEvidenceReview data={snapshot} selected={{}} onChange={() => {}} />,
    );
    expect(html).toContain("증거는 기본적으로 제보문에 포함되지 않습니다");
    expect(html).not.toContain('checked=""');
    expect(html).toContain("도구 호출/결과 상세 확인 (최대 8,000자)");
    expect(evidenceGaps(snapshot)).toContain("대화: 조회 실패");
    expect(evidenceGaps(snapshot)).toContain("도구 호출: 최근 항목 일부만 수집됨");
    const minimal = reportText({ symptom: "승인 반복", expected: "", actual: "" }, "오늘");
    expect(minimal).not.toContain("sensitive");
  });

  test("only explicitly included, edited evidence enters the shareable text", () => {
    const item = evidenceItems(snapshot).find((entry) => entry.id === "call:c1");
    if (!item) throw new Error("missing fixture call");
    const text = reportText(
      { symptom: "승인 반복", expected: "", actual: "" },
      "오늘",
      [{ label: item.label, source: item.source, text: "redacted by user" }],
      evidenceGaps(snapshot),
      { projectId: snapshot.session.projectId, sessionId: snapshot.session.id },
    );
    expect(text).toContain("증거 출처: 프로젝트 p1 / 원본 세션 s1");
    expect(text).toContain("nodes/c1");
    expect(text).toContain("redacted by user");
    expect(text).not.toContain("sensitive");
    expect(text).toContain("대화: 조회 실패");
    expect(text).toContain("AI 진단: 수행하지 않음");
  });

  test("clipboard denial preserves a manually selectable draft", async () => {
    expect(
      await copyReportText("draft", async () => {
        throw new Error("denied");
      }),
    ).toBe(false);
    const captured: string[] = [];
    expect(
      await copyReportText("draft", async (text) => {
        captured.push(text);
      }),
    ).toBe(true);
    expect(captured).toEqual(["draft"]);
  });
});
