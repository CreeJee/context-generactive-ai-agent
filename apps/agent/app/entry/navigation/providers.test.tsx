import { expect, test } from "vite-plus/test";
import { ProviderAuthState } from "../api";
import { accountSummary } from "./account-model-panel";
import { navigationCopy } from "./copy";

test("compatible provider without a configuration reads as needing setup", () => {
  expect(
    accountSummary(
      "openai-compatible",
      ProviderAuthState["signed-out"]({ provider: "openai-compatible" }),
      null,
      undefined,
    ).status,
  ).toBe(navigationCopy.accountModel.status.setupNeeded);
});
