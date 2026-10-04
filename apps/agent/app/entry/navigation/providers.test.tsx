import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vite-plus/test";
import { AccountSection } from "./sidebar";
import { accountSummary } from "./account-model-panel";
import { isProviderId, providerOptions } from "./providers";

test("provider enumeration includes subscriptions and the separate compatible endpoint", () => {
  expect(providerOptions.map(({ value }) => value)).toEqual([
    "openai",
    "anthropic",
    "openai-compatible",
  ]);
  expect(isProviderId("openai-compatible")).toBe(true);
  expect(isProviderId("unknown")).toBe(false);
});

test("compatible provider offers settings rather than OAuth login or logout", () => {
  for (const status of ["signed-out", "signed-in"] as const) {
    const html = renderToStaticMarkup(
      <AccountSection
        provider="openai-compatible"
        auth={{ provider: "openai-compatible", status }}
        onAction={() => {}}
        onProviderChange={() => {}}
      />,
    );
    expect(html).toContain("호환 공급자 설정");
    expect(html).not.toContain("로 로그인");
    expect(html).not.toContain("연결 해제");
  }
  expect(
    accountSummary(
      "openai-compatible",
      { provider: "openai-compatible", status: "signed-out" },
      null,
      undefined,
    ).status,
  ).toBe("설정 필요");
});
