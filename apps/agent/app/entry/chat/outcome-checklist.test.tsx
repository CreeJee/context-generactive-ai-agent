import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vite-plus/test";
import { OutcomeChecklist } from "./outcome-checklist";

describe("OutcomeChecklist", () => {
  test("counts the met outcomes and says where each one stands", () => {
    const html = renderToStaticMarkup(
      <OutcomeChecklist
        outcomes={[
          { id: "O1", text: "Search returns results", status: { _tag: "Met", summary: "checked" } },
          { id: "O2", text: "Docs updated", status: { _tag: "InProgress", pending: ["c2", "c3"] } },
          { id: "O3", text: "No regressions", status: { _tag: "AwaitingCheck", stale: true } },
          { id: "O4", text: "Fast", status: { _tag: "Unplanned" } },
        ]}
      />,
    );
    expect(html).toContain("결과 1/4 충족");
    expect(html).toContain("충족 · checked");
    expect(html).toContain("진행 중 · 카드 2개 남음");
    expect(html).toContain("확인 대기 · 바뀐 뒤 다시 확인해요");
    expect(html).toContain("맡은 카드 없음");
  });
  test("shows nothing for a Goal without outcomes", () => {
    expect(renderToStaticMarkup(<OutcomeChecklist outcomes={[]} />)).toBe("");
  });
});
