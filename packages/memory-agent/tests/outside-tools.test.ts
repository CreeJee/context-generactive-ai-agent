import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Schema } from "effect";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { StorageRoot } from "../src/config/storage-root.ts";
import { OutsideTools } from "../src/tools/outside.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function layout() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "memory-agent-outside-")));
  directories.push(base);
  const project = join(base, "project");
  const storage = join(base, "storage");
  const docs = join(base, "docs");
  for (const directory of [project, storage, join(docs, "guide"), join(docs, ".ssh")])
    mkdirSync(directory, { recursive: true });
  writeFileSync(join(project, "app.ts"), "export {};\n");
  writeFileSync(join(docs, "guide", "intro.md"), "# Intro\nDeploy with care.\n");
  writeFileSync(join(docs, "notes.txt"), "deploy on friday\r\nnothing else\r\n");
  writeFileSync(join(docs, ".env"), "TOKEN=1\n");
  writeFileSync(join(docs, ".ssh", "id_ed25519"), "secret\n");
  writeFileSync(join(storage, "agent.db"), "db");
  return { base, project, storage, docs };
}

async function outsideTools(project: string, storage: string) {
  const service = await Effect.runPromise(
    Effect.provide(
      OutsideTools,
      OutsideTools.layer.pipe(Layer.provide(StorageRoot.layer(storage))),
    ),
  );
  const [listOutside, readOutside, searchOutside] = service.forProject({
    id: "p1",
    root: project,
    name: "project",
    crossRecallExcluded: false,
    permissionMode: "ask",
    createdAt: "2026-09-14T00:00:00.000Z",
    hiddenAt: null,
  });
  return { listOutside, readOutside, searchOutside };
}

async function run<I, O>(tool: { execute?: (args: I) => O }, input: I) {
  if (!tool.execute) throw new Error("tool has no server implementation");
  return tool.execute(input);
}

const failure = <A>(promise: Promise<A>) =>
  promise.then(
    () => "resolved",
    (error: Error) => error.message.split(":")[0],
  );

const Matches = Schema.Struct({
  matches: Schema.Array(
    Schema.Struct({ path: Schema.String, line: Schema.Number, text: Schema.String }),
  ),
});

describe("outside tools", () => {
  test("list leaves out credentials and links", async () => {
    const { project, storage, docs, base } = layout();
    symlinkSync(join(base, "project"), join(docs, "project-link"));
    const { listOutside } = await outsideTools(project, storage);
    expect(await run(listOutside, { directory: docs })).toMatchObject({
      directory: docs,
      paths: [join(docs, "guide", "intro.md"), join(docs, "notes.txt")],
      excludedCredentialFiles: 2,
      truncated: false,
      nextOffset: null,
    });
  });

  test("reads by line with CRLF kept and searches a file or a directory", async () => {
    const { project, storage, docs } = layout();
    const { readOutside, searchOutside } = await outsideTools(project, storage);

    expect(await run(readOutside, { path: join(docs, "notes.txt"), maxLines: 1 })).toMatchObject({
      path: join(docs, "notes.txt"),
      content: "deploy on friday\r\n",
      nextStartLine: 2,
    });

    const inDirectory = Schema.decodeUnknownSync(Matches)(
      await run(searchOutside, { path: docs, query: "deploy", caseSensitive: false }),
    );
    expect(inDirectory.matches).toEqual([
      { path: join(docs, "guide", "intro.md"), line: 2, text: "Deploy with care." },
      { path: join(docs, "notes.txt"), line: 1, text: "deploy on friday" },
    ]);
    expect(
      await run(searchOutside, { path: join(docs, "notes.txt"), query: "else" }),
    ).toMatchObject({ matches: [{ line: 2, text: "nothing else" }], complete: true });
  });

  test("refuses credentials, the project, the storage root and relative paths", async () => {
    const { project, storage, docs } = layout();
    const { readOutside, searchOutside, listOutside } = await outsideTools(project, storage);

    expect(await failure(run(readOutside, { path: join(docs, ".env") }))).toBe("credential");
    expect(await failure(run(readOutside, { path: join(docs, ".ssh", "id_ed25519") }))).toBe(
      "credential",
    );
    expect(await failure(run(readOutside, { path: join(project, "app.ts") }))).toBe(
      "inside_project",
    );
    expect(await failure(run(listOutside, { directory: storage }))).toBe("credential");
    expect(await failure(run(searchOutside, { path: "docs", query: "x" }))).toBe("invalid_path");
    expect(await failure(run(readOutside, { path: join(docs, "missing.txt") }))).toBe("not_found");
  });
});
