import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vite-plus/test";
import type { ModelSelection, ProviderAuthState } from "../api";
import { AccountModelPanel, accountSummary } from "./account-model-panel";
import { ReportLink } from "../report/report-link";
import { ThemeSelect, themes } from "../shared/theme";

// The Base UI disclosure starts closed, reserving only the compact trigger's height.
describe("compact sidebar controls", () => {
  test("summary exposes selected provider/model and errors without expanding settings", () => {
    const selection: ModelSelection = {
      provider: "openai",
      model: "a-very-long-model-name",
      reasoningEffort: "high",
    };
    const error: ProviderAuthState = {
      provider: "anthropic",
      status: "error",
      message: "연결 실패",
    };
    expect(accountSummary("anthropic", error, selection, "Very Long Model")).toMatchObject({
      status: "연결 오류",
      model: "ChatGPT · Very Long Model",
      hasError: true,
    });
    const html = renderToStaticMarkup(
      <AccountModelPanel
        provider="anthropic"
        auth={error}
        selection={selection}
        modelName="Very Long Model"
      >
        <button type="button">계정 연결 해제</button>
      </AccountModelPanel>,
    );
    expect(html).toContain('data-slot="collapsible"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("truncate");
    expect(html).toContain("연결 오류");
    expect(html).not.toContain("계정 연결 해제");
  });

  test("signed-in collapsed profile shows provider and model only once", () => {
    const html = renderToStaticMarkup(
      <AccountModelPanel
        provider="openai"
        auth={{ provider: "openai", status: "signed-in" }}
        selection={{ provider: "openai", model: "gpt", reasoningEffort: "high" }}
        modelName="GPT"
      >
        <button type="button">계정 변경</button>
      </AccountModelPanel>,
    );
    const summary = (html.split("</button>")[0] ?? "").replace(/title="[^"]*"/, "");
    expect(summary).toContain("ChatGPT · GPT");
    expect(summary).not.toContain("ChatGPT · 연결됨");
    expect(summary.match(/ChatGPT · GPT/g)).toHaveLength(1);
  });

  test("report entry remains a labelled, focusable icon with the selected source", () => {
    const html = renderToStaticMarkup(<ReportLink projectId="p" sessionId="s" />);
    expect(html).toContain('href="/report?project=p&amp;session=s"');
    expect(html).toContain('aria-label="리포트하기"');
    expect(html).toContain("focus-visible:outline");
    expect(html).toContain("sr-only");
  });

  test("theme selection exposes system/light/dark options with current accessible name", () => {
    const html = renderToStaticMarkup(<ThemeSelect />);
    expect(html).toContain("화면 테마: 시스템 테마");
    expect(themes.map((theme) => theme.label)).toEqual(["시스템 테마", "라이트 모드", "다크 모드"]);
  });
});
