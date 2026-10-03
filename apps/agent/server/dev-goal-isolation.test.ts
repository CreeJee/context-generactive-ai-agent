import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { acquireStorageLock } from "./dev-safety.ts";

const temporaryRoots: string[] = [];
const temporaryRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "agent-goal-isolation-"));
  temporaryRoots.push(root);
  return root;
};

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("a worktree needs an explicit dirty/untracked snapshot for Goal-scoped late imports", () => {
  const root = temporaryRoot();
  const repo = join(root, "repo");
  const previousGoal = join(root, "previous-goal");
  const nextGoal = join(root, "next-goal");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-q");
  writeFileSync(join(repo, "late.mjs"), 'export const revision = "committed";\n');
  git("add", "late.mjs");
  git("-c", "user.name=Probe", "-c", "user.email=probe@example.invalid", "commit", "-qm", "base");

  writeFileSync(join(repo, "late.mjs"), 'export const revision = "first";\n');
  writeFileSync(join(repo, "untracked.mjs"), 'export const revision = "first";\n');
  git("worktree", "add", "--detach", "-q", previousGoal, "HEAD");
  expect(readFileSync(join(previousGoal, "late.mjs"), "utf8")).toContain("committed");
  expect(existsSync(join(previousGoal, "untracked.mjs"))).toBe(false);
  for (const file of ["late.mjs", "untracked.mjs"])
    cpSync(join(repo, file), join(previousGoal, file));

  writeFileSync(join(repo, "late.mjs"), 'export const revision = "second";\n');
  writeFileSync(join(repo, "untracked.mjs"), 'export const revision = "second";\n');
  git("worktree", "add", "--detach", "-q", nextGoal, "HEAD");
  for (const file of ["late.mjs", "untracked.mjs"]) cpSync(join(repo, file), join(nextGoal, file));

  // Late imports must resolve in each Goal's code folder, not the mutable project root.
  const lateImports = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const [oldRoot, newRoot] = process.argv.slice(1);\n` +
        `const old = await import(oldRoot + "/untracked.mjs");\n` +
        `const fresh = await import(newRoot + "/untracked.mjs");\n` +
        `console.log(JSON.stringify([old.revision, fresh.revision]));`,
      previousGoal,
      nextGoal,
    ],
    { encoding: "utf8" },
  );
  expect(JSON.parse(lateImports)).toEqual(["first", "second"]);
  expect(readFileSync(join(repo, "late.mjs"), "utf8")).toContain("second");
});

test("Goal processes cannot share the existing storage owner lock", () => {
  const root = temporaryRoot();
  const shared = join(root, "shared-storage");
  const isolated = join(root, "separate-storage");
  const releasePrevious = acquireStorageLock(shared, 5180, "previous-goal");
  try {
    expect(() => acquireStorageLock(shared, 5181, "next-goal")).toThrow(
      "backend already owns this storage root",
    );
    const releaseNext = acquireStorageLock(isolated, 5181, "next-goal");
    releaseNext();
  } finally {
    releasePrevious();
  }
  const releaseAfter = acquireStorageLock(shared, 5181, "next-goal");
  releaseAfter();
});
