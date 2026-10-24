import { chat, toolDefinition } from "@tanstack/ai";
import { it } from "@effect/vitest";
import { Cause, Effect, FileSystem, Path, Result, Schema } from "effect";
import { expect } from "vite-plus/test";
import { projectInstructions } from "../src/agent/project-instructions.ts";
import { ScriptedTextAdapter } from "../src/testing/scripted-adapter.ts";
import { toToolSchema } from "../src/tools/schema.ts";
import { withTestPlatform } from "./support/platform.ts";

const fixture = Effect.fn("projectInstructions.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "project-instructions-" });
  yield* fs.makeDirectory(path.join(root, "packages", "memory", "src"), { recursive: true });
  yield* fs.makeDirectory(path.join(root, "apps"));
  yield* fs.writeFileString(path.join(root, "AGENTS.md"), "ROOT RULE");
  yield* fs.writeFileString(path.join(root, "packages", "AGENTS.md"), "PACKAGES RULE");
  yield* fs.writeFileString(path.join(root, "packages", "memory", "AGENTS.md"), "EFFECT RULE");
  yield* fs.writeFileString(path.join(root, "apps", "AGENTS.md"), "SIBLING RULE");
  return { root, fs, path };
});
const sdkCall = Effect.fn("projectInstructions.sdkCall")(<A>(operation: () => Promise<A>) =>
  Effect.tryPromise({ try: operation, catch: (cause) => new Cause.UnknownError(cause) }),
);
const inputSchema = toToolSchema(Schema.Struct({ path: Schema.String }));
const call = (id: string, name: string, path: string) => ({
  id,
  name,
  arguments: JSON.stringify({ path }),
});

it.live(
  "loads root guidance and a recursive catalog; scoped content uses the existing file tool",
  () =>
    Effect.gen(function* () {
      const run = Effect.runPromiseWith(yield* Effect.context());
      const { root, fs, path } = yield* fixture();
      for (const directory of ["node_modules/dependency", ".git", ".ssh"]) {
        yield* fs.makeDirectory(path.join(root, directory), { recursive: true });
        yield* fs.writeFileString(path.join(root, directory, "AGENTS.md"), "EXCLUDED RULE");
      }
      yield* fs.symlink(
        path.join(root, "apps", "AGENTS.md"),
        path.join(root, "packages", "memory", "src", "AGENTS.md"),
      );
      const reads: string[] = [];
      const adapter = new ScriptedTextAdapter([
        { toolCalls: [call("read", "read_file", "packages/memory/AGENTS.md")] },
        { text: "done" },
      ]);
      yield* sdkCall(() =>
        chat({
          threadId: "thread",
          adapter,
          messages: [{ role: "user", content: "go" }],
          stream: false,
          tools: [
            toolDefinition({ name: "read_file", description: "read", inputSchema }).server(
              ({ path: relativePath }) => {
                reads.push(relativePath);
                return run(fs.readFileString(path.join(root, relativePath)));
              },
            ),
          ],
          middleware: [projectInstructions(root)],
        }),
      );
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
    }).pipe(withTestPlatform),
);

it.live("each run refreshes the root and catalog without blocking tool execution", () =>
  Effect.gen(function* () {
    const { root, fs, path } = yield* fixture();
    let writes = 0;
    const first = new ScriptedTextAdapter([
      { toolCalls: [call("write", "write_file", "packages/memory/src/a.ts")] },
      { text: "done" },
    ]);
    yield* sdkCall(() =>
      chat({
        threadId: "thread",
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
      }),
    );
    expect(writes).toBe(1);
    yield* fs.writeFileString(path.join(root, "AGENTS.md"), "UPDATED ROOT");
    yield* fs.makeDirectory(path.join(root, "new"));
    yield* fs.writeFileString(path.join(root, "new", "AGENTS.md"), "NEW SCOPED CONTENT");
    const next = new ScriptedTextAdapter([{ text: "done" }]);
    yield* sdkCall(() =>
      chat({
        threadId: "thread",
        adapter: next,
        messages: [],
        stream: false,
        middleware: [projectInstructions(root)],
      }),
    );
    const prompt = next.invocations[0]!.systemPrompts.join("\n");
    expect(prompt).toContain("UPDATED ROOT");
    expect(prompt).toContain('"new/AGENTS.md"');
    expect(prompt).not.toContain("NEW SCOPED CONTENT");
  }).pipe(withTestPlatform),
);

it.live("a project without any AGENTS.md adds no prompt", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "project-instructions-" });
    const adapter = new ScriptedTextAdapter([{ text: "done" }]);
    yield* sdkCall(() =>
      chat({
        threadId: "thread",
        adapter,
        messages: [],
        systemPrompts: ["BASE"],
        stream: false,
        middleware: [projectInstructions(root)],
      }),
    );
    expect(adapter.invocations[0]!.systemPrompts).toEqual(["BASE"]);
  }).pipe(withTestPlatform),
);

it.live("linked instruction files are refused before their content reaches the model", () =>
  Effect.gen(function* () {
    const { root, fs, path } = yield* fixture();
    yield* fs.remove(path.join(root, "AGENTS.md"));
    yield* fs.symlink(path.join(root, "apps", "AGENTS.md"), path.join(root, "AGENTS.md"));
    const adapter = new ScriptedTextAdapter([{ text: "done" }]);
    const outcome = yield* Effect.result(
      sdkCall(() =>
        chat({
          threadId: "thread",
          adapter,
          messages: [],
          stream: false,
          middleware: [projectInstructions(root)],
        }),
      ),
    );
    Result.match(outcome, {
      onFailure: (error) => expect(error.cause).toMatchObject({ reason: "symlink" }),
      onSuccess: () => expect.fail("Expected symlink instructions to be rejected"),
    });
    expect(adapter.invocations).toHaveLength(0);
  }).pipe(withTestPlatform),
);
