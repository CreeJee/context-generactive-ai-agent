import { expect, test } from "vite-plus/test";
import { mcpToolName } from "./servers.ts";

test("tool names stay within the model's limits", () => {
  expect(mcpToolName("fs", "read file")).toBe("mcp_fs__read_file");
  const long = mcpToolName("server", "x".repeat(80));
  expect(long).toHaveLength(64);
  expect(long).toMatch(/^mcp_server__x+_[0-9a-f]{8}$/);
});
