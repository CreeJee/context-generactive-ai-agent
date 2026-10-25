import { expect, test } from "vite-plus/test";
import {
  maxMcpGuideCharacters,
  mcpInstructions,
  mcpInstructionsForMode,
  mcpToolName,
} from "./servers.ts";

test("tool names stay within the model's limits", () => {
  expect(mcpToolName("fs", "read file")).toBe("mcp_fs__read_file");
  const long = mcpToolName("server", "x".repeat(80));
  expect(long).toHaveLength(64);
  expect(long).toMatch(/^mcp_server__x+_[0-9a-f]{8}$/);
});

test("server guides are quoted by server and cut to a bounded length", () => {
  expect(mcpInstructionsForMode("ask", [])).toBe(mcpInstructions);
  const prompt = mcpInstructionsForMode("ask", [
    { server: "graph", text: "Use trace for call paths." },
    { server: "docs", text: "y".repeat(maxMcpGuideCharacters + 5) },
  ]);
  expect(prompt).toContain('<server name="graph">\nUse trace for call paths.\n</server>');
  expect(prompt).toContain(`${"y".repeat(maxMcpGuideCharacters)}\n… [cut: 5 more characters]`);
  expect(prompt).not.toContain("y".repeat(maxMcpGuideCharacters + 1));
});
