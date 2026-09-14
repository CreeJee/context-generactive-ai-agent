import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { FileTools } from "../src/tools/files.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function project(files: ReadonlyMap<string, string | Buffer>) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "memory-agent-files-")));
  directories.push(base);
  const root = join(base, "project");
  mkdirSync(root);
  for (const [path, content] of files) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return { base, root };
}

async function fileTools(root: string) {
  const service = await Effect.runPromise(Effect.provide(FileTools, FileTools.layer));
  const [listFiles, searchFiles, readFile, writeFile, editFile, deleteFile] = service.forProject({
    id: "p1",
    root,
    name: "project",
    crossRecallExcluded: false,
    permissionMode: "ask",
    createdAt: "2026-09-14T00:00:00.000Z",
  });
  return { listFiles, searchFiles, readFile, writeFile, editFile, deleteFile };
}

/** Runs a server tool the way the chat engine does, after input validation. */
async function run<I, O>(tool: { execute?: (args: I) => O }, input: I) {
  if (!tool.execute) throw new Error("tool has no server implementation");
  return tool.execute(input);
}

/** Error code of a failed tool call (the text before the first colon), or "resolved". */
const failure = <A>(promise: Promise<A>) =>
  promise.then(
    () => "resolved",
    (error: Error) => error.message.split(":")[0],
  );

const ListPage = Schema.Struct({
  snapshot: Schema.String,
  paths: Schema.Array(Schema.String),
  nextOffset: Schema.NullOr(Schema.Number),
});
const SearchPage = Schema.Struct({
  matches: Schema.Array(Schema.Struct({ path: Schema.String, line: Schema.Number })),
  nextCursor: Schema.NullOr(Schema.String),
});
const WithSha = Schema.Struct({ sha256: Schema.String });

describe("list_files", () => {
  test("uses Git ignore rules and leaves out links, .git and credentials", async () => {
    const { root, base } = project(
      new Map([
        ["src/app.ts", "export {};\n"],
        ["dist/app.js", "built\n"],
        [".gitignore", "dist\n"],
        [".env", "SECRET=1\n"],
        ["README.md", "# app\n"],
      ]),
    );
    writeFileSync(join(base, "outside.txt"), "x");
    symlinkSync(join(base, "outside.txt"), join(root, "link.txt"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    const { listFiles } = await fileTools(root);

    expect(await run(listFiles, {})).toMatchObject({
      source: "git",
      paths: [".gitignore", "README.md", "src/app.ts"],
      excludedCredentialFiles: 1,
      nextOffset: null,
    });
    expect(await run(listFiles, { directory: "src", glob: "*.ts" })).toMatchObject({
      directory: "src",
      paths: ["src/app.ts"],
    });
  });

  test("walks projects without Git, skipping node_modules, and pages one snapshot", async () => {
    const files = new Map([["node_modules/pkg/index.js", "x"]]);
    for (let index = 0; index < 510; index++)
      files.set(`notes/${String(index).padStart(3, "0")}.md`, "note\n");
    const { root } = project(files);
    const { listFiles } = await fileTools(root);

    const first = Schema.decodeUnknownSync(ListPage)(await run(listFiles, {}));
    expect(first).toMatchObject({ nextOffset: 500 });
    writeFileSync(join(root, "notes", "000-new.md"), "added between pages\n");
    const second = Schema.decodeUnknownSync(ListPage)(
      await run(listFiles, { snapshot: first.snapshot, offset: 500 }),
    );
    expect(second.paths).toHaveLength(10);
    expect(second.nextOffset).toBeNull();
  });
});

describe("search_files", () => {
  test("returns matching lines, pages with a cursor and reports skipped files", async () => {
    const many = Array.from({ length: 150 }, (_, index) => `const TODO_${index} = 1;`).join("\n");
    const { root } = project(
      new Map<string, string | Buffer>([
        ["src/a.ts", "// todo: first\nexport const a = 1;\r\n// TODO second\n"],
        ["src/many.ts", many],
        ["src/image.bin", Buffer.from([0x89, 0x00, 0x01])],
      ]),
    );
    const { searchFiles } = await fileTools(root);

    expect(await run(searchFiles, { query: "TODO second" })).toMatchObject({
      matches: [{ path: "src/a.ts", line: 3, text: "// TODO second" }],
      skipped: [{ path: "src/image.bin", reason: "binary" }],
      nextCursor: null,
      complete: false,
    });

    const first = Schema.decodeUnknownSync(SearchPage)(
      await run(searchFiles, { query: "todo", caseSensitive: false }),
    );
    expect(first.matches).toHaveLength(100);
    const cursor = first.nextCursor ?? "";
    expect(cursor).not.toBe("");
    const second = Schema.decodeUnknownSync(SearchPage)(
      await run(searchFiles, { query: "todo", caseSensitive: false, cursor }),
    );
    expect(second.matches).toHaveLength(52);
    expect(second.nextCursor).toBeNull();
    expect(await failure(run(searchFiles, { query: "other", cursor }))).toBe("invalid_cursor");
  });
});

describe("read, write, edit and delete", () => {
  test("reads line pages exactly, including CRLF, with a sha256", async () => {
    const { root } = project(new Map([["notes.txt", "one\r\ntwo\r\nthree\r\n"]]));
    const { readFile } = await fileTools(root);
    expect(await run(readFile, { path: "notes.txt", startLine: 2, maxLines: 1 })).toMatchObject({
      content: "two\r\n",
      startLine: 2,
      endLine: 2,
      totalLines: 3,
      nextStartLine: 3,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  test("creates, replaces only the version that was read, and deletes with a sha256", async () => {
    const { root } = project(new Map());
    const { readFile, writeFile, deleteFile } = await fileTools(root);
    const plan = join(root, "docs", "plan.md");
    const shaOf = async () =>
      Schema.decodeUnknownSync(WithSha)(await run(readFile, { path: "docs/plan.md" })).sha256;

    const created = await run(writeFile, { path: "docs/plan.md", content: "v1\n" });
    expect(created).toMatchObject({ created: true, bytes: 3 });
    expect(await failure(run(writeFile, { path: "docs/plan.md", content: "x" }))).toBe("exists");

    const firstSha = await shaOf();
    writeFileSync(plan, "user edit\n");
    expect(
      await failure(
        run(writeFile, { path: "docs/plan.md", content: "v2\n", expectedSha256: firstSha }),
      ),
    ).toBe("changed");
    expect(readFileSync(plan, "utf8")).toBe("user edit\n");

    const currentSha = await shaOf();
    await run(writeFile, { path: "docs/plan.md", content: "v2\n", expectedSha256: currentSha });
    expect(readFileSync(plan, "utf8")).toBe("v2\n");

    expect(
      await failure(run(deleteFile, { path: "docs/plan.md", expectedSha256: currentSha })),
    ).toBe("changed");
    expect(
      await run(deleteFile, { path: "docs/plan.md", expectedSha256: await shaOf() }),
    ).toMatchObject({ deleted: true });
  });

  test("edits exact text once, keeps CRLF, and refuses ambiguous or missing text", async () => {
    const { root } = project(
      new Map([
        ["app.ts", "const a = 1;\r\nconst b = 1;\r\n"],
        ["twice.ts", "x\nx\n"],
      ]),
    );
    const { editFile } = await fileTools(root);

    expect(
      await run(editFile, {
        path: "app.ts",
        oldText: "const a = 1;\nconst b",
        newText: "const a = 2;\nconst b",
      }),
    ).toMatchObject({ replacements: 1 });
    expect(readFileSync(join(root, "app.ts"), "utf8")).toBe("const a = 2;\r\nconst b = 1;\r\n");

    expect(await failure(run(editFile, { path: "twice.ts", oldText: "x", newText: "y" }))).toBe(
      "ambiguous_match",
    );
    expect(
      await run(editFile, { path: "twice.ts", oldText: "x", newText: "y", replaceAll: true }),
    ).toMatchObject({ replacements: 2 });
    expect(await failure(run(editFile, { path: "twice.ts", oldText: "zzz", newText: "" }))).toBe(
      "no_match",
    );
  });

  test("refuses credentials, .git internals, links and escapes", async () => {
    const { root, base } = project(
      new Map([
        [".env", "SECRET=1\n"],
        ["ok.txt", "ok\n"],
      ]),
    );
    mkdirSync(join(root, ".git"));
    writeFileSync(join(base, "outside.txt"), "outside\n");
    symlinkSync(join(base, "outside.txt"), join(root, "link.txt"));
    const { readFile, writeFile } = await fileTools(root);

    expect(await failure(run(readFile, { path: ".env" }))).toBe("credential");
    expect(await failure(run(writeFile, { path: ".git/config", content: "x" }))).toBe(
      "git_internal",
    );
    expect(await failure(run(readFile, { path: "link.txt" }))).toBe("symlink");
    expect(await failure(run(readFile, { path: "../outside.txt" }))).toBe("invalid_path");
    expect(await failure(run(readFile, { path: "missing.txt" }))).toBe("not_found");
  });
});
