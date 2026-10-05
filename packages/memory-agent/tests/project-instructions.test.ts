import { chat, toolDefinition } from "@tanstack/ai";
import { readFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { afterEach, expect, test } from "vite-plus/test";
import { projectInstructions } from "../src/agent/project-instructions.ts";
import { ScriptedTextAdapter } from "../src/testing/scripted-adapter.ts";
import { toToolSchema } from "../src/tools/schema.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "project-instructions-"));
  roots.push(root);
  mkdirSync(join(root, "packages", "memory", "src"), { recursive: true });
  mkdirSync(join(root, "apps"));
  writeFileSync(join(root, "AGENTS.md"), "ROOT RULE");
  writeFileSync(join(root, "packages", "AGENTS.md"), "PACKAGES RULE");
  writeFileSync(join(root, "packages", "memory", "AGENTS.md"), "EFFECT RULE");
  writeFileSync(join(root, "apps", "AGENTS.md"), "SIBLING RULE");
  return root;
}
const inputSchema = toToolSchema(Schema.Struct({ path: Schema.String }));
const call = (id: string, name: string, path: string) => ({
  id,
  name,
  arguments: JSON.stringify({ path }),
});

test("loads root guidance and a recursive catalog; scoped content uses the existing file tool", async () => {
  const root = fixture();
  for (const directory of ["node_modules/dependency", ".git", ".ssh"]) {
    mkdirSync(join(root, directory), { recursive: true });
    writeFileSync(join(root, directory, "AGENTS.md"), "EXCLUDED RULE");
  }
  symlinkSync(
    join(root, "apps", "AGENTS.md"),
    join(root, "packages", "memory", "src", "AGENTS.md"),
  );
  const reads: string[] = [];
  const adapter = new ScriptedTextAdapter([
    { toolCalls: [call("read", "read_file", "packages/memory/AGENTS.md")] },
    { text: "done" },
  ]);
  await chat({
    adapter,
    messages: [{ role: "user", content: "go" }],
    stream: false,
    tools: [
      toolDefinition({ name: "read_file", description: "read", inputSchema }).server(({ path }) => {
        reads.push(path);
        return readFileSync(join(root, path), "utf8");
      }),
    ],
    middleware: [projectInstructions(root)],
  });
  const initial = adapter.invocations[0]!.systemPrompts.join("\n");
  expect(initial).toContain("ROOT RULE");
  expect(initial).toContain('"packages/AGENTS.md"');
  expect(initial).toContain('"packages/memory/AGENTS.md"');
  expect(initial).toContain('"apps/AGENTS.md"');
  expect(initial).not.toContain("EFFECT RULE");
  expect(initial).not.toContain("SIBLING RULE");
  expect(initial).not.toContain("node_modules/dependency/AGENTS.md");
  expect(initial).not.toContain(".git/AGENTS.md");
  expect(initial).not.toContain(".ssh/AGENTS.md");
  expect(initial).not.toContain("packages/memory/src/AGENTS.md");
  expect(reads).toEqual(["packages/memory/AGENTS.md"]);
  expect(adapter.invocations[1]!.messages).toEqual(
    expect.arrayContaining([expect.objectContaining({ role: "tool", content: "EFFECT RULE" })]),
  );
  expect(adapter.invocations[1]!.systemPrompts.join("\n")).toBe(initial);
});

test("each run refreshes the root and catalog without blocking tool execution", async () => {
  const root = fixture();
  let writes = 0;
  const first = new ScriptedTextAdapter([
    { toolCalls: [call("write", "write_file", "packages/memory/src/a.ts")] },
    { text: "done" },
  ]);
  await chat({
    adapter: first,
    messages: [],
    stream: false,
    tools: [
      toolDefinition({ name: "write_file", description: "write", inputSchema }).server(() => {
        writes++;
        return "written";
      }),
    ],
    middleware: [projectInstructions(root)],
  });
  expect(writes).toBe(1);
  writeFileSync(join(root, "AGENTS.md"), "UPDATED ROOT");
  mkdirSync(join(root, "new"));
  writeFileSync(join(root, "new", "AGENTS.md"), "NEW SCOPED CONTENT");
  const next = new ScriptedTextAdapter([{ text: "done" }]);
  await chat({
    adapter: next,
    messages: [],
    stream: false,
    middleware: [projectInstructions(root)],
  });
  const prompt = next.invocations[0]!.systemPrompts.join("\n");
  expect(prompt).toContain("UPDATED ROOT");
  expect(prompt).toContain('"new/AGENTS.md"');
  expect(prompt).not.toContain("NEW SCOPED CONTENT");
});

test("linked instruction files are refused before their content reaches the model", async () => {
  const root = fixture();
  rmSync(join(root, "AGENTS.md"));
  symlinkSync(join(root, "apps", "AGENTS.md"), join(root, "AGENTS.md"));
  const adapter = new ScriptedTextAdapter([{ text: "done" }]);
  await expect(
    chat({ adapter, messages: [], stream: false, middleware: [projectInstructions(root)] }),
  ).rejects.toMatchObject({ reason: "symlink" });
  expect(adapter.invocations).toHaveLength(0);
});
