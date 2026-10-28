import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { StorageRoot } from "../src/config/storage-root.ts";
import type { JsonValue } from "../src/json.ts";
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
  yield* fs.writeFileString(path.join(project, "app.ts"), "export {};\n");
  yield* fs.writeFileString(path.join(docs, "guide", "intro.md"), "# Intro\nDeploy with care.\n");
  yield* fs.writeFileString(path.join(docs, "notes.txt"), "deploy on friday\r\nnothing else\r\n");
  yield* fs.writeFileString(path.join(docs, ".env"), "TOKEN=1\n");
  yield* fs.writeFileString(path.join(docs, ".ssh", "id_ed25519"), "secret\n");
  yield* fs.writeFileString(path.join(storage, "agent.db"), "db");
  return { base, project, storage, docs, fs, path };
});

const outsideTools = Effect.fn("outsideTools")(function* (project: string, storage: string) {
  const services = yield* Layer.build(
    OutsideTools.layer.pipe(Layer.provide(StorageRoot.layer(storage))),
  );
  const service = yield* Effect.provideContext(OutsideTools, services);
  const tools = service.toolsFor({
    id: "p1",
    root: project,
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

  it.live("refuses credentials, the project, the storage root and relative paths", () =>
    Effect.gen(function* () {
      const { project, storage, docs, path } = yield* layout();
      const { readOutside, searchOutside, listOutside } = yield* outsideTools(project, storage);
      expect(yield* failureCode(readOutside({ path: path.join(docs, ".env") }))).toBe("credential");
      expect(yield* failureCode(readOutside({ path: path.join(docs, ".ssh", "id_ed25519") }))).toBe(
        "credential",
      );
      expect(yield* failureCode(readOutside({ path: path.join(project, "app.ts") }))).toBe(
        "inside_project",
      );
      expect(yield* failureCode(listOutside({ directory: storage }))).toBe("credential");
      expect(yield* failureCode(searchOutside({ path: "docs", query: "x" }))).toBe("invalid_path");
      expect(yield* failureCode(readOutside({ path: path.join(docs, "missing.txt") }))).toBe(
        "not_found",
      );
    }).pipe(withTestPlatform),
  );
});
