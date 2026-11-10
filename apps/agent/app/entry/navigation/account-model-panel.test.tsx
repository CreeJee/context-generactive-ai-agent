import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vite-plus/test";
import { ProviderAuthState, type ModelSelection } from "../api";
import { AccountModelPanel, accountSummary } from "./account-model-panel";
import { navigationCopy } from "./copy";

const status = navigationCopy.accountModel.status;

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
      status: status.error,
      model: "ChatGPT / Very Long Model",
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
    expect(html).toContain(status.error);
    expect(html).not.toContain("계정 연결 해제");
  });

  test("signed-in collapsed profile shows provider and model only once", () => {
    const html = renderToStaticMarkup(
      <AccountModelPanel
        provider="openai"
        auth={ProviderAuthState["signed-in"]({ provider: "openai" })}
        selection={{ provider: "openai", model: "gpt", reasoningEffort: "high" }}
        modelName="GPT"
      >
        <button type="button">계정 변경</button>
      </AccountModelPanel>,
    );
    const summary = (html.split("</button>")[0] ?? "").replace(/title="[^"]*"/, "");
    expect(summary).toContain("ChatGPT / GPT");
    expect(summary).not.toContain(`ChatGPT · ${status.signedIn}`);
    expect(summary.match(/ChatGPT \/ GPT/g)).toHaveLength(1);
  });
});
