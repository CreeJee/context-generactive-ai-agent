import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { StorageRoot } from "../src/config/storage-root.ts";
import type { JsonValue } from "../src/json.ts";
import type { ToolFence } from "../src/files/paths.ts";
import { FileTools } from "../src/tools/files.ts";
import { OutsideTools } from "../src/tools/outside.ts";
import { withTestPlatform } from "./support/platform.ts";
import { callTool, failureCode } from "./support/run-tools.ts";

const layout = Effect.fn("outsideTools.layout")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "memory-agent-outside-" });
  const base = yield* fs.realPath(temporary);
  const project = path.join(base, "project");
  const storage = path.join(base, "storage");
  const docs = path.join(base, "docs");
  yield* Effect.forEach(
    [project, storage, path.join(docs, "guide"), path.join(docs, ".ssh")],
    (directory) => fs.makeDirectory(directory, { recursive: true }),
    { discard: true },
  );
  yield* fs.makeDirectory(path.join(project, "src"));
  yield* fs.writeFileString(path.join(project, "app.ts"), "export {};\n");
  yield* fs.writeFileString(path.join(project, "src", "deploy.ts"), "// deploy here\n");
  yield* fs.writeFileString(path.join(project, ".env"), "TOKEN=1\n");
  yield* fs.writeFileString(path.join(docs, "guide", "intro.md"), "# Intro\nDeploy with care.\n");
  yield* fs.writeFileString(path.join(docs, "notes.txt"), "deploy on friday\r\nnothing else\r\n");
  yield* fs.writeFileString(path.join(docs, ".env"), "TOKEN=1\n");
  yield* fs.writeFileString(path.join(docs, ".ssh", "id_ed25519"), "secret\n");
  yield* fs.writeFileString(path.join(storage, "agent.db"), "db");
  return { base, project, storage, docs, fs, path };
});

const outsideTools = Effect.fn("outsideTools")(function* (
  project: string,
  storage: string,
  toolFence?: ToolFence,
) {
  const services = yield* Layer.build(
    OutsideTools.layer.pipe(Layer.provide([StorageRoot.layer(storage), FileTools.layer])),
  );
  const service = yield* Effect.provideContext(OutsideTools, services);
  const tools = service.toolsFor({
    id: "p1",
    root: project,
    toolFence,
    name: "project",
    crossRecallExcluded: false,
    permissionMode: "ask",
    createdAt: "2026-09-14T00:00:00.000Z",
    hiddenAt: null,
  });
  const caller = (name: string) => (params: JsonValue) => callTool(tools, name, params);
  return {
    listOutside: caller("list_outside_files"),
    readOutside: caller("read_outside_file"),
    searchOutside: caller("search_outside_file"),
  };
});

const Matches = Schema.Struct({
  matches: Schema.Array(
    Schema.Struct({ path: Schema.String, line: Schema.Finite, text: Schema.String }),
  ),
});

describe("outside tools", () => {
  it.live("list leaves out credentials and links", () =>
    Effect.gen(function* () {
      const { project, storage, docs, base, fs, path } = yield* layout();
      yield* fs.symlink(path.join(base, "project"), path.join(docs, "project-link"));
      const { listOutside } = yield* outsideTools(project, storage);
      expect(yield* listOutside({ directory: docs })).toMatchObject({
        directory: docs,
        paths: [path.join(docs, "guide", "intro.md"), path.join(docs, "notes.txt")],
        excludedCredentialFiles: 2,
        truncated: false,
        nextOffset: null,
      });
    }).pipe(withTestPlatform),
  );

  it.live("reads by line with CRLF kept and searches a file or a directory", () =>
    Effect.gen(function* () {
      const { project, storage, docs, path } = yield* layout();
      const { readOutside, searchOutside } = yield* outsideTools(project, storage);
      expect(yield* readOutside({ path: path.join(docs, "notes.txt"), maxLines: 1 })).toMatchObject(
        {
          path: path.join(docs, "notes.txt"),
          content: "deploy on friday\r\n",
          nextStartLine: 2,
        },
      );
      const inDirectory = yield* Schema.decodeUnknownEffect(Matches)(
        yield* searchOutside({ path: docs, query: "deploy", caseSensitive: false }),
      );
      expect(inDirectory.matches).toEqual([
        { path: path.join(docs, "guide", "intro.md"), line: 2, text: "Deploy with care." },
        { path: path.join(docs, "notes.txt"), line: 1, text: "deploy on friday" },
      ]);
      expect(
        yield* searchOutside({ path: path.join(docs, "notes.txt"), query: "else" }),
      ).toMatchObject({ matches: [{ line: 2, text: "nothing else" }], complete: true });
    }).pipe(withTestPlatform),
  );

  it.live("run a path in the project as the file tools do, with the project's rules", () =>
    Effect.gen(function* () {
      const { project, storage, path } = yield* layout();
      const { readOutside, searchOutside, listOutside } = yield* outsideTools(project, storage);
      expect(yield* readOutside({ path: path.join(project, "app.ts") })).toMatchObject({
        path: "app.ts",
        content: "export {};\n",
        insideProject: expect.stringContaining("read_file"),
      });
      expect(yield* listOutside({ directory: project })).toMatchObject({
        directory: ".",
        paths: ["app.ts", "src/deploy.ts"],
        excludedCredentialFiles: 1,
        insideProject: expect.stringContaining("list_files"),
      });
      // A directory is searched as search_files does, and one file in it as well.
      expect(yield* searchOutside({ path: project, query: "deploy" })).toMatchObject({
        matches: [{ path: "src/deploy.ts", line: 1 }],
        insideProject: expect.stringContaining("search_files"),
      });
      expect(
        yield* searchOutside({ path: path.join(project, "src", "deploy.ts"), query: "deploy" }),
      ).toMatchObject({ matches: [{ line: 1, text: "// deploy here" }], complete: true });
      expect(yield* failureCode(readOutside({ path: path.join(project, ".env") }))).toBe(
        "credential",
      );
      expect(yield* failureCode(readOutside({ path: path.join(project, ".git", "HEAD") }))).toBe(
        "git_internal",
      );
    }).pipe(withTestPlatform),
  );

  it.live("in a card, read the user's project folder in the card's worktree", () =>
    Effect.gen(function* () {
      const { base, project, storage, fs, path } = yield* layout();
      const card = path.join(base, "worktrees", "g1", "c1");
      yield* fs.makeDirectory(card, { recursive: true });
      yield* fs.writeFileString(path.join(card, "app.ts"), "card copy\n");
      const { readOutside } = yield* outsideTools(card, storage, {
        deniedRoots: [project, path.join(base, "worktrees")],
        userRoot: project,
      });
      expect(yield* readOutside({ path: path.join(project, "app.ts") })).toMatchObject({
        path: "app.ts",
        content: "card copy\n",
        pathMapped: expect.stringContaining("app.ts"),
      });
    }).pipe(withTestPlatform),
  );

  it.live("refuses credentials, the storage root and missing paths", () =>
    Effect.gen(function* () {
      const { project, storage, docs, path } = yield* layout();
      const { readOutside, searchOutside, listOutside } = yield* outsideTools(project, storage);
      expect(yield* failureCode(readOutside({ path: path.join(docs, ".env") }))).toBe("credential");
      expect(yield* failureCode(readOutside({ path: path.join(docs, ".ssh", "id_ed25519") }))).toBe(
        "credential",
      );
      expect(yield* failureCode(listOutside({ directory: storage }))).toBe("credential");
      // A relative path is a project path, as the file tools read it.
      expect(yield* failureCode(searchOutside({ path: "docs", query: "x" }))).toBe("not_found");
      expect(yield* failureCode(readOutside({ path: path.join(docs, "missing.txt") }))).toBe(
        "not_found",
      );
    }).pipe(withTestPlatform),
  );
});
