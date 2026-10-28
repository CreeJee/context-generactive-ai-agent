import { it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Path } from "effect";
import { expect } from "vite-plus/test";
import { projectInstructionsHook } from "../src/agent/project-instructions.ts";
import type { RunScope } from "../src/loop/run.ts";
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

const scope: RunScope = { threadId: "thread", runId: "run", emit: () => Effect.void };

/** The system prompts one model step of a new run in `root` is asked with. */
const stepSystem = (root: string, system: ReadonlyArray<string> = []) =>
  Effect.flatMap(projectInstructionsHook(root), (hook) =>
    Effect.map(hook.request!(scope, { system, history: [] }), (request) => request.system),
  );

it.live("loads root guidance and a recursive catalog, not the scoped files' content", () =>
  Effect.gen(function* () {
    const { root, fs, path } = yield* fixture();
    yield* Effect.forEach(
      ["node_modules/dependency", ".git", ".ssh"],
      Effect.fnUntraced(function* (directory) {
        yield* fs.makeDirectory(path.join(root, directory), { recursive: true });
        yield* fs.writeFileString(path.join(root, directory, "AGENTS.md"), "EXCLUDED RULE");
      }),
      { discard: true },
    );
    yield* fs.symlink(
      path.join(root, "apps", "AGENTS.md"),
      path.join(root, "packages", "memory", "src", "AGENTS.md"),
    );
    const hook = yield* projectInstructionsHook(root);
    const first = yield* hook.request!(scope, { system: ["BASE"], history: [] });
    const prompt = first.system.join("\n");
    expect(first.system[0]).toBe("BASE");
    expect(prompt).toContain("ROOT RULE");
    expect(prompt).toContain('"packages/AGENTS.md"');
    expect(prompt).toContain('"packages/memory/AGENTS.md"');
    expect(prompt).toContain('"apps/AGENTS.md"');
    expect(prompt).not.toContain("EFFECT RULE");
    expect(prompt).not.toContain("SIBLING RULE");
    expect(prompt).not.toContain("node_modules/dependency/AGENTS.md");
    expect(prompt).not.toContain(".git/AGENTS.md");
    expect(prompt).not.toContain(".ssh/AGENTS.md");
    expect(prompt).not.toContain("packages/memory/src/AGENTS.md");
    // Read once per run: a later step of the same run is asked with the same instructions.
    yield* fs.writeFileString(path.join(root, "AGENTS.md"), "UPDATED ROOT");
    const next = yield* hook.request!(scope, { system: ["BASE"], history: [] });
    expect(next.system).toEqual(first.system);
  }).pipe(withTestPlatform),
);

it.live("each run refreshes the root and catalog", () =>
  Effect.gen(function* () {
    const { root, fs, path } = yield* fixture();
    yield* stepSystem(root);
    yield* fs.writeFileString(path.join(root, "AGENTS.md"), "UPDATED ROOT");
    yield* fs.makeDirectory(path.join(root, "new"));
    yield* fs.writeFileString(path.join(root, "new", "AGENTS.md"), "NEW SCOPED CONTENT");
    const prompt = (yield* stepSystem(root)).join("\n");
    expect(prompt).toContain("UPDATED ROOT");
    expect(prompt).toContain('"new/AGENTS.md"');
    expect(prompt).not.toContain("NEW SCOPED CONTENT");
  }).pipe(withTestPlatform),
);

it.live("a project without any AGENTS.md adds no prompt", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "project-instructions-" });
    expect(yield* stepSystem(root, ["BASE"])).toEqual(["BASE"]);
  }).pipe(withTestPlatform),
);

it.live("linked instruction files are refused before their content reaches the model", () =>
  Effect.gen(function* () {
    const { root, fs, path } = yield* fixture();
    yield* fs.remove(path.join(root, "AGENTS.md"));
    yield* fs.symlink(path.join(root, "apps", "AGENTS.md"), path.join(root, "AGENTS.md"));
    expect(Exit.isFailure(yield* Effect.exit(stepSystem(root)))).toBe(true);
  }).pipe(withTestPlatform),
);
