import { describe, expect, test } from "vite-plus/test";
import { codexRequestPrefix } from "../src/codex/request.ts";
import { promptLayout } from "../src/agent/prompt-layout.ts";

describe("request prefix", () => {
  test("tool discovery order does not change the payload or mutate the caller", () => {
    const tools = [
      { name: "z_tool", description: "Last", inputSchema: { type: "object", properties: {} } },
      { name: "a_tool", description: "First", inputSchema: { type: "object", properties: {} } },
    ];
    const first = codexRequestPrefix({ tools });
    expect(JSON.stringify(first)).toBe(
      JSON.stringify(codexRequestPrefix({ tools: tools.toReversed() })),
    );
    expect(tools.map((tool) => tool.name)).toEqual(["z_tool", "a_tool"]);
    expect(first.dynamicTools.map((tool) => tool.name)).toEqual(["a_tool", "z_tool"]);
    expect(first.dynamicTools[0]?.inputSchema).toEqual(tools[1]?.inputSchema);
  });

  test("context changes leave the standing and role prefix intact", () => {
    const standing = ["memory rules", "tool rules"];
    const role = ["parent rules"];
    const before = promptLayout(standing, ["project A", "date A"], role);
    const after = promptLayout(standing, ["project B", "date B"], role);
    expect(before.slice(0, 3)).toEqual(after.slice(0, 3));
    expect(before).toEqual([...standing, ...role, "project A", "date A"]);
    expect(standing).toEqual(["memory rules", "tool rules"]);
    expect(codexRequestPrefix({ systemPrompts: before }).baseInstructions).toBe(
      before.join("\n\n"),
    );
  });

  test("empty requests retain the default and explicit instructions retain their order", () => {
    expect(codexRequestPrefix({})).toEqual({
      baseInstructions: "You are a helpful assistant.",
      dynamicTools: [],
    });
    expect(codexRequestPrefix({ systemPrompts: ["z", "a"] }).baseInstructions).toBe("z\n\na");
  });
});
