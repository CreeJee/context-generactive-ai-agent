import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vite-plus/test";
import { OutcomeChecklist } from "./outcome-checklist";

const render = (node: ReactNode) =>
  renderToStaticMarkup(<I18nProvider i18n={i18n}>{node}</I18nProvider>);

describe("OutcomeChecklist", () => {
  test("counts the met outcomes and says where each one stands", () => {
    const html = render(
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
    expect(html).toContain("확인 대기 · 바뀐 뒤 다시 확인합니다");
    expect(html).toContain("맡은 카드 없음");
  });
  test("shows nothing for a Goal without outcomes", () => {
    expect(render(<OutcomeChecklist outcomes={[]} />)).toBe("");
  });
});
