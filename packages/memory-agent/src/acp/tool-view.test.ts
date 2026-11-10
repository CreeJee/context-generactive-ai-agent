import { describe, expect, it } from "@effect/vitest";
import { toolTitle } from "./tool-view.ts";

describe("toolTitle", () => {
  it("keeps run_skill's title and adds the skill it runs", () => {
    expect(toolTitle("run_skill", '{"name":"test-failures","args":["src"]}')).toBe(
      "코드 스킬 실행 · test-failures",
    );
    expect(toolTitle("run_skill", "{")).toBe("코드 스킬 실행");
  });

  it("shows another call's path, or the tool's title without one", () => {
    expect(toolTitle("read_file", '{"path":"src/index.ts"}')).toBe("src/index.ts");
    expect(toolTitle("list_files", "{}")).toBe("파일 목록");
  });
});
