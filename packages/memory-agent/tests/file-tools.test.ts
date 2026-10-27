import { it } from "@effect/vitest";
import { withTestPlatform } from "./support/platform.ts";
import { NodeServices } from "@effect/platform-node";
import { Context, FileSystem, Layer, MutableHashMap, Effect, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { describe, expect } from "vite-plus/test";
import type { JsonValue } from "../src/json.ts";
import { FileTools } from "../src/tools/files.ts";
import { callTool, failureCode } from "./support/run-tools.ts";

const isText = Schema.is(Schema.String);
const gitFixture = Effect.fn("fileToolsTest.gitFixture")(function* (root: string, args: string[]) {
  const platform = yield* Layer.build(NodeServices.layer);
  const spawner = Context.get(platform, ChildProcessSpawner.ChildProcessSpawner);
  const child = yield* spawner.spawn(
    ChildProcess.make("git", args, { cwd: root, stdin: "ignore" }),
  );
  const [, , exitCode] = yield* Effect.all(
    [
      Stream.runDrain(child.stdout),
      child.stderr.pipe(Stream.decodeText(), Stream.mkString),
      child.exitCode,
    ],
    { concurrency: "unbounded" },
  );
  expect(exitCode).toBe(0);
});
const project = Effect.fn("fileToolsTest.project")(function* (
  files: MutableHashMap.MutableHashMap<string, string | Buffer>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const base = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "memory-agent-files-" }),
  );
  const root = path.join(base, "project");
  yield* fs.makeDirectory(root);
  for (const [relative, content] of files) {
    const target = path.join(root, relative);
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    if (isText(content)) yield* fs.writeFileString(target, content);
    else yield* fs.writeFile(target, content);
  }
  return { base, root };
});
const fileTools = Effect.fn("fileToolsTest.tools")(function* (root: string) {
  const service = yield* Effect.provideContext(FileTools, yield* Layer.build(FileTools.layer));
  const tools = service.runToolsFor({
    id: "p1",
    root,
    name: "project",
    crossRecallExcluded: false,
    permissionMode: "ask",
    createdAt: "2026-09-14T00:00:00.000Z",
    hiddenAt: null,
  });
  const named = (name: string) => (input: JsonValue) => callTool(tools, name, input);
  return {
    listFiles: named("list_files"),
    searchFiles: named("search_files"),
    readFile: named("read_file"),
    writeFile: named("write_file"),
    editFile: named("edit_file"),
    deleteFile: named("delete_file"),
  };
});

const ListPage = Schema.Struct({
  snapshot: Schema.String,
  paths: Schema.Array(Schema.String),
  nextOffset: Schema.NullOr(Schema.Finite),
});
const SearchPage = Schema.Struct({
  matches: Schema.Array(Schema.Struct({ path: Schema.String, line: Schema.Finite })),
  nextCursor: Schema.NullOr(Schema.String),
});
const WithSha = Schema.Struct({ sha256: Schema.String });

describe("list_files", () => {
  it.live("uses Git ignore rules and leaves out links, .git and credentials", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, base } = yield* project(
        MutableHashMap.fromIterable([
          ["src/app.ts", "export {};\n"],
          ["dist/app.js", "built\n"],
          [".gitignore", "dist\n"],
          [".env", "SECRET=1\n"],
          ["README.md", "# app\n"],
        ]),
      );
      yield* fs.writeFileString(path.join(base, "outside.txt"), "x");
      yield* fs.symlink(path.join(base, "outside.txt"), path.join(root, "link.txt"));
      yield* gitFixture(root, ["init", "-q"]);
      const { listFiles } = yield* fileTools(root);
      expect(yield* listFiles({})).toMatchObject({
        source: "git",
        paths: [".gitignore", "README.md", "src/app.ts"],
        excludedCredentialFiles: 1,
        nextOffset: null,
      });
      expect(yield* listFiles({ directory: "src", glob: "*.ts" })).toMatchObject({
        directory: "src",
        paths: ["src/app.ts"],
      });
      // An empty optional snapshot in model-generated arguments means the first page.
      expect(
        yield* listFiles({ directory: "src", glob: "*.ts", snapshot: "", offset: 0 }),
      ).toMatchObject({
        paths: ["src/app.ts"],
      });
    }).pipe(withTestPlatform),
  );

  it.live("walks projects without Git, skipping node_modules, and pages one snapshot", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const files = MutableHashMap.fromIterable([["node_modules/pkg/index.js", "x"]]);
      for (let index = 0; index < 510; index++)
        MutableHashMap.set(files, `notes/${String(index).padStart(3, "0")}.md`, "note\n");
      const { root } = yield* project(files);
      const { listFiles } = yield* fileTools(root);
      const first = yield* Schema.decodeUnknownEffect(ListPage)(yield* listFiles({}));
      expect(first).toMatchObject({ nextOffset: 500 });
      yield* fs.writeFileString(path.join(root, "notes", "000-new.md"), "added between pages\n");
      const second = yield* Schema.decodeUnknownEffect(ListPage)(
        yield* listFiles({ snapshot: first.snapshot, offset: 500 }),
      );
      expect(second.paths).toHaveLength(10);
      expect(second.nextOffset).toBeNull();
    }).pipe(withTestPlatform),
  );
});

describe("search_files", () => {
  it.live("returns matching lines, pages with a cursor and reports skipped files", () =>
    Effect.gen(function* () {
      const many = Array.from({ length: 150 }, (_, index) => `const TODO_${index} = 1;`).join("\n");
      const { root } = yield* project(
        MutableHashMap.fromIterable<string, string | Buffer>([
          ["src/a.ts", "// todo: first\nexport const a = 1;\r\n// TODO second\n"],
          ["src/many.ts", many],
          ["src/image.bin", Buffer.from([0x89, 0x00, 0x01])],
          ["src/data.bin", Buffer.concat([Buffer.from([0x00]), Buffer.from("TODO second")])],
        ]),
      );
      const { searchFiles } = yield* fileTools(root);
      // A binary file is reported only when its bytes contain the text, so it might have matched.
      expect(yield* searchFiles({ query: "TODO second" })).toMatchObject({
        matches: [{ path: "src/a.ts", line: 3, text: "// TODO second" }],
        skipped: [{ path: "src/data.bin", reason: "binary" }],
        nextCursor: null,
        complete: false,
      });
      expect(yield* searchFiles({ query: "first" })).toMatchObject({
        matches: [{ path: "src/a.ts", line: 1 }],
        skipped: [],
        complete: true,
      });
      // An empty optional cursor in model-generated arguments also starts a fresh search.
      expect(yield* searchFiles({ query: "first", cursor: "" })).toMatchObject({
        matches: [{ path: "src/a.ts", line: 1 }],
        complete: true,
      });
      const first = yield* Schema.decodeUnknownEffect(SearchPage)(
        yield* searchFiles({ query: "todo", caseSensitive: false }),
      );
      expect(first.matches).toHaveLength(100);
      const cursor = first.nextCursor ?? "";
      expect(cursor).not.toBe("");
      const second = yield* Schema.decodeUnknownEffect(SearchPage)(
        yield* searchFiles({ query: "todo", caseSensitive: false, cursor }),
      );
      expect(second.matches).toHaveLength(52);
      expect(second.nextCursor).toBeNull();
      expect(yield* failureCode(searchFiles({ query: "other", cursor }))).toBe("invalid_cursor");
    }).pipe(withTestPlatform),
  );
});

describe("search_files in a Git work tree", () => {
  it.live(
    "narrows files with git grep but keeps untracked, ignore rules, credentials and case rules",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { root } = yield* project(
          MutableHashMap.fromIterable<string, string | Buffer>([
            ["src/tracked.ts", "const Needle = 1;\nconst other = 2;\n"],
            ["src/untracked.ts", "// needle in a new file\n"],
            ["dist/built.js", "needle in an ignored file\n"],
            [".gitignore", "dist\n"],
            [".env", "needle=secret\n"],
            ["src/한글.md", "첫 줄\n바늘 needle 둘째 줄\n"],
          ]),
        );
        yield* gitFixture(root, ["init", "-q"]);
        yield* gitFixture(root, ["add", "src/tracked.ts", ".gitignore"]);
        const { searchFiles } = yield* fileTools(root);
        expect(yield* searchFiles({ query: "needle" })).toMatchObject({
          matches: [
            { path: "src/untracked.ts", line: 1 },
            { path: "src/한글.md", line: 2, text: "바늘 needle 둘째 줄" },
          ],
          skipped: [],
          complete: true,
        });
        expect(yield* searchFiles({ query: "NEEDLE", caseSensitive: false })).toMatchObject({
          matches: [
            { path: "src/tracked.ts", line: 1 },
            { path: "src/untracked.ts", line: 1 },
            { path: "src/한글.md", line: 2 },
          ],
        });
        // Non-ASCII case-insensitive queries are searched without git grep.
        expect(yield* searchFiles({ query: "바늘", caseSensitive: false })).toMatchObject({
          matches: [{ path: "src/한글.md", line: 2 }],
        });
        // Git reads the files as they are on disk now, not as committed.
        yield* fs.writeFileString(path.join(root, "src/tracked.ts"), "const needle = 3;\n");
        expect(yield* searchFiles({ query: "needle" })).toMatchObject({
          matches: [
            { path: "src/tracked.ts", line: 1 },
            { path: "src/untracked.ts", line: 1 },
            { path: "src/한글.md", line: 2 },
          ],
        });
      }).pipe(withTestPlatform),
  );
});

describe("read, write, edit and delete", () => {
  it.live("paging a file reuses the read only while the file is unchanged", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root } = yield* project(MutableHashMap.fromIterable([["log.txt", "a\nb\nc\n"]]));
      const { readFile } = yield* fileTools(root);
      const first = yield* Schema.decodeUnknownEffect(WithSha)(
        yield* readFile({ path: "log.txt", maxLines: 1 }),
      );
      // Same size, different content: the second page must see the new file.
      yield* fs.writeFileString(path.join(root, "log.txt"), "x\ny\nz\n");
      const second = yield* readFile({ path: "log.txt", startLine: 2, maxLines: 1 });
      expect(second).toMatchObject({ content: "y\n" });
      expect((yield* Schema.decodeUnknownEffect(WithSha)(second)).sha256).not.toBe(first.sha256);
    }).pipe(withTestPlatform),
  );

  it.live("reads line pages exactly, including CRLF, with a sha256", () =>
    Effect.gen(function* () {
      const { root } = yield* project(
        MutableHashMap.fromIterable([["notes.txt", "one\r\ntwo\r\nthree\r\n"]]),
      );
      const { readFile } = yield* fileTools(root);
      expect(yield* readFile({ path: "notes.txt", startLine: 2, maxLines: 1 })).toMatchObject({
        content: "two\r\n",
        startLine: 2,
        endLine: 2,
        totalLines: 3,
        nextStartLine: 3,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
    }).pipe(withTestPlatform),
  );

  it.live("creates, replaces only the version that was read, and deletes with a sha256", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root } = yield* project(MutableHashMap.empty());
      const { readFile, writeFile, deleteFile } = yield* fileTools(root);
      const plan = path.join(root, "docs", "plan.md");
      const shaOf = () =>
        Effect.gen(function* () {
          return (yield* Schema.decodeUnknownEffect(WithSha)(
            yield* readFile({ path: "docs/plan.md" }),
          )).sha256;
        });
      const created = yield* writeFile({ path: "docs/plan.md", content: "v1\n" });
      expect(created).toMatchObject({ created: true, bytes: 3 });
      expect(yield* failureCode(writeFile({ path: "docs/plan.md", content: "x" }))).toBe("exists");
      const firstSha = yield* shaOf();
      yield* fs.writeFileString(plan, "user edit\n");
      expect(
        yield* failureCode(
          writeFile({ path: "docs/plan.md", content: "v2\n", expectedSha256: firstSha }),
        ),
      ).toBe("changed");
      expect(yield* fs.readFileString(plan)).toBe("user edit\n");
      const currentSha = yield* shaOf();
      yield* writeFile({ path: "docs/plan.md", content: "v2\n", expectedSha256: currentSha });
      expect(yield* fs.readFileString(plan)).toBe("v2\n");
      expect(
        yield* failureCode(deleteFile({ path: "docs/plan.md", expectedSha256: currentSha })),
      ).toBe("changed");
      expect(
        yield* deleteFile({ path: "docs/plan.md", expectedSha256: yield* shaOf() }),
      ).toMatchObject({ deleted: true });
    }).pipe(withTestPlatform),
  );

  it.live("edits exact text once, keeps CRLF, and refuses ambiguous or missing text", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root } = yield* project(
        MutableHashMap.fromIterable([
          ["app.ts", "const a = 1;\r\nconst b = 1;\r\n"],
          ["twice.ts", "x\nx\n"],
        ]),
      );
      const { editFile } = yield* fileTools(root);
      expect(
        yield* editFile({
          path: "app.ts",
          oldText: "const a = 1;\nconst b",
          newText: "const a = 2;\nconst b",
        }),
      ).toMatchObject({ replacements: 1 });
      expect(yield* fs.readFileString(path.join(root, "app.ts"))).toBe(
        "const a = 2;\r\nconst b = 1;\r\n",
      );
      expect(yield* failureCode(editFile({ path: "twice.ts", oldText: "x", newText: "y" }))).toBe(
        "ambiguous_match",
      );
      expect(
        yield* editFile({ path: "twice.ts", oldText: "x", newText: "y", replaceAll: true }),
      ).toMatchObject({ replacements: 2 });
      expect(yield* failureCode(editFile({ path: "twice.ts", oldText: "zzz", newText: "" }))).toBe(
        "no_match",
      );
    }).pipe(withTestPlatform),
  );

  it.live("edits and rewrites around a hidden value without writing its placeholder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const original = 'const url = "a";\nconst API_KEY = "kq83jd92kslw01";\n';
      const { root } = yield* project(MutableHashMap.fromIterable([["config.ts", original]]));
      const target = path.join(root, "config.ts");
      const { readFile, editFile, writeFile } = yield* fileTools(root);
      // The model reads `const API_KEY = "[redacted:credential]";` and edits that line.
      expect(
        yield* editFile({
          path: "config.ts",
          oldText: 'const url = "a";\nconst API_KEY = "[redacted:credential]";',
          newText: 'const url = "b";\nexport const API_KEY = "[redacted:credential]";',
        }),
      ).toMatchObject({ replacements: 1 });
      expect(yield* fs.readFileString(target)).toBe(
        'const url = "b";\nexport const API_KEY = "kq83jd92kslw01";\n',
      );
      expect(
        yield* failureCode(
          editFile({
            path: "config.ts",
            oldText: 'API_KEY = "[redacted:cred',
            newText: "x",
          }),
        ),
      ).toBe("hidden_value_split");

      const { sha256 } = yield* Schema.decodeUnknownEffect(WithSha)(
        yield* readFile({ path: "config.ts" }),
      );
      yield* writeFile({
        path: "config.ts",
        expectedSha256: sha256,
        content: '// rewritten\nexport const API_KEY = "[redacted:credential]";\n',
      });
      expect(yield* fs.readFileString(target)).toBe(
        '// rewritten\nexport const API_KEY = "kq83jd92kslw01";\n',
      );
    }).pipe(withTestPlatform),
  );

  it.live("refuses credentials, .git internals, links and escapes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, base } = yield* project(
        MutableHashMap.fromIterable([
          [".env", "SECRET=1\n"],
          ["ok.txt", "ok\n"],
        ]),
      );
      yield* fs.makeDirectory(path.join(root, ".git"));
      yield* fs.writeFileString(path.join(base, "outside.txt"), "outside\n");
      yield* fs.symlink(path.join(base, "outside.txt"), path.join(root, "link.txt"));
      const { readFile, writeFile } = yield* fileTools(root);
      expect(yield* failureCode(readFile({ path: ".env" }))).toBe("credential");
      expect(yield* failureCode(writeFile({ path: ".git/config", content: "x" }))).toBe(
        "git_internal",
      );
      expect(yield* failureCode(readFile({ path: "link.txt" }))).toBe("symlink");
      expect(yield* failureCode(readFile({ path: "../outside.txt" }))).toBe("invalid_path");
      expect(yield* failureCode(readFile({ path: "missing.txt" }))).toBe("not_found");
    }).pipe(withTestPlatform),
  );
});
