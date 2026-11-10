import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vite-plus/test";
import { ProviderAuthState, type ModelSelection } from "../api";
import { AccountModelPanel, accountSummary } from "./account-model-panel";

// The Base UI disclosure starts closed, reserving only the compact trigger's height.
describe("compact sidebar controls", () => {
  test("summary exposes selected provider/model and errors without expanding settings", () => {
    const selection: ModelSelection = {
      provider: "openai",
      model: "a-very-long-model-name",
      reasoningEffort: "high",
    };
    const error = ProviderAuthState.error({ provider: "anthropic", message: "연결 실패" });
    expect(accountSummary("anthropic", error, selection, "Very Long Model")).toMatchObject({
      status: "연결 오류",
      model: "ChatGPT / Very Long Model",
      hasError: true,
    });
    const html = renderToStaticMarkup(
      <I18nProvider i18n={i18n}>
        <AccountModelPanel
          provider="anthropic"
          auth={error}
          selection={selection}
          modelName="Very Long Model"
        >
          <button type="button">계정 연결 해제</button>
        </AccountModelPanel>
      </I18nProvider>,
    );
    expect(html).toContain('data-slot="collapsible"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("truncate");
    expect(html).toContain("연결 오류");
    expect(html).not.toContain("계정 연결 해제");
  });

  test("signed-in collapsed profile shows provider and model only once", () => {
    const html = renderToStaticMarkup(
      <I18nProvider i18n={i18n}>
        <AccountModelPanel
          provider="openai"
          auth={ProviderAuthState["signed-in"]({ provider: "openai" })}
          selection={{ provider: "openai", model: "gpt", reasoningEffort: "high" }}
          modelName="GPT"
        >
          <button type="button">계정 변경</button>
        </AccountModelPanel>
      </I18nProvider>,
    );
    const summary = (html.split("</button>")[0] ?? "").replace(/title="[^"]*"/, "");
    expect(summary).toContain("ChatGPT / GPT");
    expect(summary).not.toContain("ChatGPT · 연결됨");
    expect(summary.match(/ChatGPT \/ GPT/g)).toHaveLength(1);
  });
});
