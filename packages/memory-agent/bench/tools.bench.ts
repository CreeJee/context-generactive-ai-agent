// Tool latency at the tool-execution seam (no model, HTTP or UI): `vp test bench`.
// A synthetic repository is generated once per process in the OS temp directory.
import { execFileSync } from "node:child_process";
import { optionalProperty } from "../src/optional-property.ts";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnyServerTool } from "@tanstack/ai";
import { Effect, ManagedRuntime } from "effect";
import { test, describe } from "vite-plus/test";
import { SecretStore } from "../src/config/secrets.ts";
import { memoryAgentLayer } from "../src/layers.ts";
import { MorphAnalyzer } from "../src/memory/morph/analyzer.ts";
import { Projects } from "../src/projects/projects.ts";
import { fakeEmbedderLayer } from "../src/testing/fake-embedder.ts";
import { ApprovedTools } from "../src/tools/approved.ts";
import { FileTools } from "../src/tools/files.ts";

const directories = 40;
const filesPerDirectory = 75;
const needleFiles = 60;

function makeRepository(root: string, git: boolean) {
  mkdirSync(root, { recursive: true });
  for (let d = 0; d < directories; d++) {
    const directory = join(root, "src", `module-${d}`);
    mkdirSync(directory, { recursive: true });
    for (let f = 0; f < filesPerDirectory; f++) {
      const index = d * filesPerDirectory + f;
      const lines = Array.from({ length: 120 }, (_, line) =>
        index < needleFiles && line % 10 === 0
          ? `  const needle${line} = compute(${index}, ${line}); // 한글 주석 needle`
          : `  export function helper${index}_${line}(value: number) { return value * ${line}; }`,
      );
      writeFileSync(join(directory, `file-${f}.ts`), `${lines.join("\n")}\n`);
    }
  }
  const big = Array.from({ length: 6000 }, (_, line) => `line ${line}: ${"x".repeat(60)} 😀\r`);
  writeFileSync(join(root, "big.txt"), big.join("\n"));
  if (git) {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
    execFileSync("git", ["init", "-q"], { cwd: root, env });
    execFileSync("git", ["add", "-A"], { cwd: root, env });
    execFileSync(
      "git",
      ["-c", "user.email=b@e", "-c", "user.name=bench", "commit", "-qm", "fixture"],
      { cwd: root, env },
    );
  }
}

const base = realpathSync(mkdtempSync(join(tmpdir(), "memory-agent-bench-")));
makeRepository(join(base, "plain"), false);
makeRepository(join(base, "git"), true);

const runtime = ManagedRuntime.make(
  memoryAgentLayer(join(base, "storage"), {
    embedder: fakeEmbedderLayer,
    morphAnalyzer: MorphAnalyzer.disabled,
    interpretAutomatically: false,
    secrets: SecretStore.memory,
    skillsHome: join(base, "home"),
  }),
);

const tools = await runtime.runPromise(
  Effect.gen(function* () {
    const projects = yield* Projects;
    const files = yield* FileTools;
    const approved = yield* ApprovedTools;
    const plain = yield* projects.add(join(base, "plain"));
    const git = yield* projects.add(join(base, "git"));
    const pick = (list: readonly AnyServerTool[], name: string) => {
      const execute = list.find((tool) => tool.name === name)?.execute;
      if (!execute) throw new Error(name);
      return execute;
    };
    return {
      plain: {
        list: pick(files.forProject(plain), "list_files"),
        search: pick(files.forProject(plain), "search_files"),
        read: pick(files.forProject(plain), "read_file"),
      },
      git: {
        list: pick(files.forProject(git), "list_files"),
        search: pick(files.forProject(git), "search_files"),
      },
      shell: pick(approved.forProject(plain, "gate"), "run_shell"),
    };
  }),
);

type Page = { nextOffset?: number | null; snapshot?: string; nextCursor?: string | null };
interface ListInput {
  readonly snapshot?: string;
  readonly offset?: number;
}
interface SearchInput {
  readonly query: string;
  readonly cursor?: string;
}
interface ReadInput {
  readonly path: string;
  readonly startLine?: number;
  readonly maxLines: number;
}

/** Every page of a listing, as a model paging through it would. */
async function listAll(list: (input: ListInput) => Promise<Page>) {
  let page = await list({});
  while (page.nextOffset)
    page = await list({
      ...optionalProperty("snapshot", page.snapshot),
      offset: page.nextOffset,
    });
}

/** Every page of a search. */
async function searchAll(search: (input: SearchInput) => Promise<Page>, query: string) {
  let page = await search({ query });
  while (page.nextCursor) page = await search({ query, cursor: page.nextCursor });
}

async function readAll(read: (input: ReadInput) => Promise<{ nextStartLine?: number | null }>) {
  let page = await read({ path: "big.txt", maxLines: 2000 });
  let pages = 1;
  while (page.nextStartLine) {
    page = await read({ path: "big.txt", startLine: page.nextStartLine, maxLines: 2000 });
    pages++;
  }
  if (pages < 10) throw new Error(`expected many pages, got ${pages}`);
}

describe("file tools (3,000 files)", () => {
  test("list_files, plain directory", async ({ bench }) => {
    await bench("list_files, plain directory", () => listAll(tools.plain.list)).run();
  });
  test("list_files, Git work tree", async ({ bench }) => {
    await bench("list_files, Git work tree", () => listAll(tools.git.list)).run();
  });
  test("search_files all pages, plain (600 matches)", async ({ bench }) => {
    await bench("search_files all pages, plain (600 matches)", () =>
      searchAll(tools.plain.search, "needle")).run();
  });
  test("search_files all pages, Git (600 matches)", async ({ bench }) => {
    await bench("search_files all pages, Git (600 matches)", () =>
      searchAll(tools.git.search, "needle")).run();
  });
  test("search_files no match, plain", async ({ bench }) => {
    await bench("search_files no match, plain", () =>
      searchAll(tools.plain.search, "absent-text-xyz")).run();
  });
  test("search_files no match, Git", async ({ bench }) => {
    await bench("search_files no match, Git", () =>
      searchAll(tools.git.search, "absent-text-xyz")).run();
  });
  test("search_files one directory, plain", async ({ bench }) => {
    await bench("search_files one directory, plain", () =>
      searchAll(
        (input) => tools.plain.search({ ...input, directory: "src/module-3" }),
        "needle",
      )).run();
  });
  test("read_file 6,000 lines, all pages", async ({ bench }) => {
    await bench("read_file 6,000 lines, all pages", () => readAll(tools.plain.read)).run();
  });
});

describe("shell", () => {
  test("run_shell printf", async ({ bench }) => {
    await bench("run_shell printf", () => tools.shell({ command: "printf ok" })).run();
  });
});
