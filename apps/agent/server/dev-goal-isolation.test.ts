import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { expect } from "vite-plus/test";
import { NodeServices } from "@effect/platform-node";
// Native Git/Node commands test real worktree and module-loading behavior; Scope owns their fixture files.
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { acquireStorageLock } from "./dev-safety.ts";

const withTestPlatform = Effect.fn("devGoalIsolationTest.platform")(function* <A, E, R>(
  program: Effect.Effect<A, E, R>,
) {
  const services = yield* Layer.build(NodeServices.layer);
  return yield* Effect.provideContext(program, services);
});

it.live("a worktree needs an explicit dirty/untracked snapshot for Goal-scoped late imports", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "agent-goal-isolation-" });
    const repo = path.join(root, "repo");
    const previousGoal = path.join(root, "previous-goal");
    const nextGoal = path.join(root, "next-goal");
    yield* fs.makeDirectory(repo);
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const git = (...args: string[]) =>
      spawner
        .exitCode(ChildProcess.make("git", args, { cwd: repo }))
        .pipe(
          Effect.flatMap((code) =>
            code === 0 ? Effect.void : Effect.die(new Error(`git failed with ${code}`)),
          ),
        );
    yield* git("init", "-q");
    yield* fs.writeFileString(
      path.join(repo, "late.mjs"),
      'export const revision = "committed";\n',
    );
    yield* git("add", "late.mjs");
    yield* git(
      "-c",
      "user.name=Probe",
      "-c",
      "user.email=probe@example.invalid",
      "commit",
      "-qm",
      "base",
    );
    yield* fs.writeFileString(path.join(repo, "late.mjs"), 'export const revision = "first";\n');
    yield* fs.writeFileString(
      path.join(repo, "untracked.mjs"),
      'export const revision = "first";\n',
    );
    yield* git("worktree", "add", "--detach", "-q", previousGoal, "HEAD");
    expect(yield* fs.readFileString(path.join(previousGoal, "late.mjs"))).toContain("committed");
    expect(yield* fs.exists(path.join(previousGoal, "untracked.mjs"))).toBe(false);
    for (const file of ["late.mjs", "untracked.mjs"])
      yield* fs.copyFile(path.join(repo, file), path.join(previousGoal, file));
    yield* fs.writeFileString(path.join(repo, "late.mjs"), 'export const revision = "second";\n');
    yield* fs.writeFileString(
      path.join(repo, "untracked.mjs"),
      'export const revision = "second";\n',
    );
    yield* git("worktree", "add", "--detach", "-q", nextGoal, "HEAD");
    for (const file of ["late.mjs", "untracked.mjs"])
      yield* fs.copyFile(path.join(repo, file), path.join(nextGoal, file));
    // Late imports must resolve in each Goal's code folder, not the mutable project root.
    const lateImports = yield* spawner.string(
      ChildProcess.make(process.execPath, [
        "--input-type=module",
        "-e",
        `const [oldRoot, newRoot] = process.argv.slice(1);\n` +
          `const old = await import(oldRoot + "/untracked.mjs");\n` +
          `const fresh = await import(newRoot + "/untracked.mjs");\n` +
          `console.log(JSON.stringify([old.revision, fresh.revision]));`,
        previousGoal,
        nextGoal,
      ]),
    );
    expect(
      yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))(lateImports),
    ).toEqual(["first", "second"]);
    expect(yield* fs.readFileString(path.join(repo, "late.mjs"))).toContain("second");
  }).pipe(withTestPlatform),
);

it.live("Goal processes cannot share the existing storage owner lock", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "agent-goal-isolation-" });
    const shared = path.join(root, "shared-storage");
    const isolated = path.join(root, "separate-storage");
    const releasePrevious = yield* Effect.tryPromise(() =>
      acquireStorageLock(shared, 5180, "previous-goal"),
    );
    try {
      yield* Effect.tryPromise(() =>
        expect(acquireStorageLock(shared, 5181, "next-goal")).rejects.toThrow(
          "backend already owns this storage root",
        ),
      );
      const releaseNext = yield* Effect.tryPromise(() =>
        acquireStorageLock(isolated, 5181, "next-goal"),
      );
      yield* Effect.promise(releaseNext);
    } finally {
      yield* Effect.promise(releasePrevious);
    }
    const releaseAfter = yield* Effect.tryPromise(() =>
      acquireStorageLock(shared, 5181, "next-goal"),
    );
    yield* Effect.promise(releaseAfter);
  }).pipe(withTestPlatform),
);
