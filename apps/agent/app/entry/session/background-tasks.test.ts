import { describe, expect, test } from "vite-plus/test";
import { backgroundKindLabel } from "./background-tasks";

describe("background task kinds", () => {
  test("are labelled in the UI's words", () => {
    expect([backgroundKindLabel("shell"), backgroundKindLabel("external_agent")]).toEqual([
      "스킬",
      "외부 에이전트",
    ]);
  });
});
