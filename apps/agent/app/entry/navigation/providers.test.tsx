import { expect, test } from "vite-plus/test";
import { accountSummary } from "./account-model-panel";

test("compatible provider without a configuration reads as needing setup", () => {
  expect(
    accountSummary(
      "openai-compatible",
      { provider: "openai-compatible", status: "signed-out" },
      null,
      undefined,
    ).status,
  ).toBe("설정 필요");
});
