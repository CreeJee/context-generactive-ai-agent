// Vitest benchmark entry points return Promises and use native process/filesystem fixtures.
import { isTruthy } from "../src/truthy.ts";
// Tool latency at the tool-execution seam (no model, HTTP or UI): `vp test bench`.
// A synthetic repository is generated once per process in the OS temp directory.
import { NodeServices } from "@effect/platform-node";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { optionalProperty } from "../src/optional-property.ts";

import { path } from "../src/runtime/synchronous-path.ts";
const { join } = path;
import type { AnyServerTool } from "@tanstack/ai";
import { Cause, Effect, FileSystem, Stream, ManagedRuntime } from "effect";
import { test, describe, afterAll } from "vite-plus/test";
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

const platformRuntime = ManagedRuntime.make(NodeServices.layer);
const fs = await platformRuntime.runPromise(FileSystem.FileSystem);
const makeRepository = Effect.fn("ToolBench.makeRepository")(function* (
  root: string,
  git: boolean,
) {
  yield* fs.makeDirectory(root, { recursive: true });
  for (let d = 0; d < directories; d++) {
    const directory = join(root, "src", `module-${d}`);
    yield* fs.makeDirectory(directory, { recursive: true });
    for (let f = 0; f < filesPerDirectory; f++) {
      const index = d * filesPerDirectory + f;
      const lines = Array.from({ length: 120 }, (_, line) =>
        index < needleFiles && line % 10 === 0
          ? `  const needle${line} = compute(${index}, ${line}); // 한글 주석 needle`
          : `  export function helper${index}_${line}(value: number) { return value * ${line}; }`,
      );
      yield* fs.writeFileString(join(directory, `file-${f}.ts`), `${lines.join("\n")}\n`);
    }
  }
  const big = Array.from({ length: 6000 }, (_, line) => `line ${line}: ${"x".repeat(60)} 😀\r`);
  yield* fs.writeFileString(join(root, "big.txt"), big.join("\n"));
  if (git) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const env = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
    for (const args of [
      ["init", "-q"],
      ["add", "-A"],
      ["-c", "user.email=b@e", "-c", "user.name=bench", "commit", "-qm", "fixture"],
    ]) {
      const child = yield* spawner.spawn(
        ChildProcess.make("git", args, { cwd: root, env, extendEnv: true, stdin: "ignore" }),
      );
      const [, , code] = yield* Effect.all(
        [Stream.runDrain(child.stdout), Stream.runDrain(child.stderr), child.exitCode],
        { concurrency: "unbounded" },
      );
      if (code !== 0)
        return yield* new Cause.UnknownError(new Error(`Git fixture failed: ${code}`));
    }
  }
});

const base = await platformRuntime.runPromise(
  fs.makeTempDirectory({ prefix: "memory-agent-bench-" }).pipe(Effect.flatMap(fs.realPath)),
);
await platformRuntime.runPromise(Effect.scoped(makeRepository(join(base, "plain"), false)));
await platformRuntime.runPromise(Effect.scoped(makeRepository(join(base, "git"), true)));

const runtime = ManagedRuntime.make(
  memoryAgentLayer(join(base, "storage"), {
    embedder: fakeEmbedderLayer,
    morphAnalyzer: MorphAnalyzer.disabled,
    interpretAutomatically: false,
    secrets: SecretStore.memory,
    skillsHome: join(base, "home"),
  }),
);

afterAll(() =>
  runtime
    .dispose()
    .finally(() =>
      platformRuntime
        .runPromise(fs.remove(base, { recursive: true, force: true }))
        .finally(() => platformRuntime.dispose()),
    ),
);

const runtimeServices = await runtime.context();
const runNative = Effect.runPromiseWith(runtimeServices);
const tools = await runNative(
  Effect.gen(function* () {
    const projects = yield* Projects;
    const files = yield* FileTools;
    const approved = yield* ApprovedTools;
    const plain = yield* projects.add(join(base, "plain"));
    const git = yield* projects.add(join(base, "git"));
    const pick = (list: readonly AnyServerTool[], name: string) => {
      const execute = list.find((tool) => tool.name === name)?.execute;
      if (!isTruthy(execute)) throw new Error(name);
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
const listAll = Effect.fn("ToolBench.listAll")(function* (
  list: (input: ListInput) => Promise<Page>,
) {
  let page = yield* sdkCall(() => list({}));
  while (isTruthy(page.nextOffset)) {
    const input = {
      ...optionalProperty("snapshot", page.snapshot),
      offset: page.nextOffset,
    };
    page = yield* sdkCall(() => list(input));
  }
});

/** Every page of a search. */
const searchAll = Effect.fn("ToolBench.searchAll")(function* (
  search: (input: SearchInput) => Promise<Page>,
  query: string,
) {
  let page = yield* sdkCall(() => search({ query }));
  while (isTruthy(page.nextCursor)) {
    const input = { query, cursor: page.nextCursor };
    page = yield* sdkCall(() => search(input));
  }
});

const readAll = Effect.fn("ToolBench.readAll")(function* (
  read: (input: ReadInput) => Promise<{ nextStartLine?: number | null }>,
) {
  let page = yield* sdkCall(() => read({ path: "big.txt", maxLines: 2000 }));
  let pages = 1;
  while (isTruthy(page.nextStartLine)) {
    const input = { path: "big.txt", startLine: page.nextStartLine, maxLines: 2000 };
    page = yield* sdkCall(() => read(input));
    pages++;
  }
  if (pages < 10) throw new Error(`expected many pages, got ${pages}`);
});

describe("file tools (3,000 files)", () => {
  test("list_files, plain directory", ({ bench }) =>
    bench("list_files, plain directory", () => runNative(listAll(tools.plain.list))).run());
  test("list_files, Git work tree", ({ bench }) =>
    bench("list_files, Git work tree", () => runNative(listAll(tools.git.list))).run());
  test("search_files all pages, plain (600 matches)", ({ bench }) =>
    bench("search_files all pages, plain (600 matches)", () =>
      runNative(searchAll(tools.plain.search, "needle"))).run());
  test("search_files all pages, Git (600 matches)", ({ bench }) =>
    bench("search_files all pages, Git (600 matches)", () =>
      runNative(searchAll(tools.git.search, "needle"))).run());
  test("search_files no match, plain", ({ bench }) =>
    bench("search_files no match, plain", () =>
      runNative(searchAll(tools.plain.search, "absent-text-xyz"))).run());
  test("search_files no match, Git", ({ bench }) =>
    bench("search_files no match, Git", () =>
      runNative(searchAll(tools.git.search, "absent-text-xyz"))).run());
  test("search_files one directory, plain", ({ bench }) =>
    bench("search_files one directory, plain", () =>
      runNative(
        searchAll((input) => tools.plain.search({ ...input, directory: "src/module-3" }), "needle"),
      )).run());
  test("read_file 6,000 lines, all pages", ({ bench }) =>
    bench("read_file 6,000 lines, all pages", () => runNative(readAll(tools.plain.read))).run());
});

describe("shell", () => {
  test("run_shell printf", ({ bench }) =>
    bench("run_shell printf", () => tools.shell({ command: "printf ok" })).run());
});

const sdkCall = Effect.fn("ToolBench.sdkCall")(<A>(call: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(call()),
    catch: (cause) => new Cause.UnknownError(cause),
  }),
);
