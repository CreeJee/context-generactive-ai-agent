import { expect, test } from "vite-plus/test";
import { ProviderAuthState } from "../api";
import { accountSummary } from "./account-model-panel";

test("compatible provider without a configuration reads as needing setup", () => {
  expect(
    accountSummary(
      "openai-compatible",
      ProviderAuthState["signed-out"]({ provider: "openai-compatible" }),
      null,
      undefined,
    ).status,
  ).toBe("설정 필요");
});
