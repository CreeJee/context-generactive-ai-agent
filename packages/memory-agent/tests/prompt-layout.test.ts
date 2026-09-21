import { describe, expect, test } from "vite-plus/test";
import { promptLayout } from "../src/agent/prompt-layout.ts";

describe("prompt layout", () => {
  test("keeps stable standing and role blocks ahead of variable run context without sorting", () => {
    expect(
      promptLayout(
        ["standing-b", "standing-a"],
        ["date", "workflow", "notifications"],
        ["role", "project"],
      ),
    ).toEqual(["standing-b", "standing-a", "role", "project", "date", "workflow", "notifications"]);
  });
});
