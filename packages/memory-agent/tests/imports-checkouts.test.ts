import { it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { Context, Effect, FileSystem, Layer, Path, Stream, type Scope } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { expect } from "vite-plus/test";
import { Checkouts } from "../src/imports/checkouts.ts";

/**
 * What types cannot show about placing a recorded working directory that lies in a linked git
 * worktree: that a position the main checkout does not have falls back to the recorded folder
 * unless a registered project holds the repository, and that a registered one keeps the mapping.
 */

const git = Effect.fnUntraced(function* (cwd: string, args: readonly string[]) {
  const platform = yield* Layer.build(NodeServices.layer);
  const spawner = Context.get(platform, ChildProcessSpawner.ChildProcessSpawner);
  const child = yield* spawner.spawn(ChildProcess.make("git", args, { cwd, stdin: "ignore" }));
  const [, , code] = yield* Effect.all(
    [Stream.runDrain(child.stdout), Stream.runDrain(child.stderr), child.exitCode],
    { concurrency: "unbounded" },
  );
  expect(code).toBe(0);
});

/** A repository with one commit and a linked worktree beside it, holding one folder. */
const repositoryWithWorktree = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const base = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
  const repository = path.join(base, "repo");
  const worktree = path.join(base, "worktrees", "repo", "live");
  yield* fs.makeDirectory(repository, { recursive: true });
  yield* git(repository, ["init", "-q"]);
  yield* git(repository, [
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  ]);
  yield* git(repository, ["worktree", "add", "-q", "-b", "live", worktree]);
  const cwd = path.join(worktree, "apps");
  yield* fs.makeDirectory(cwd, { recursive: true });
  return {
    repository: yield* fs.realPath(repository),
    cwd: yield* fs.realPath(cwd),
    worktree: yield* fs.realPath(worktree),
  };
});

const live = <A, E>(
  name: string,
  body: () => Effect.Effect<A, E, Scope.Scope | FileSystem.FileSystem | Path.Path>,
) =>
  it.live(
    name,
    () =>
      Effect.flatMap(Layer.build(NodeServices.layer), (context) =>
        Effect.provideContext(body(), context),
      ).pipe(Effect.scoped),
    30_000,
  );

live(
  "a worktree position the main checkout lacks stays as recorded without a registered root",
  () =>
    Effect.gen(function* () {
      const { cwd } = yield* repositoryWithWorktree();
      const services = yield* Layer.build(
        Checkouts.layer.pipe(Layer.provideMerge(NodeServices.layer)),
      );
      const placement = yield* Context.get(services, Checkouts).forRoots([]);
      expect(yield* placement.resolve(cwd, null)).toEqual({ path: cwd, worktree: null });
    }),
);

live("a worktree position maps into a registered repository's main checkout", () =>
  Effect.gen(function* () {
    const { repository, cwd, worktree } = yield* repositoryWithWorktree();
    const services = yield* Layer.build(
      Checkouts.layer.pipe(Layer.provideMerge(NodeServices.layer)),
    );
    const placement = yield* Context.get(services, Checkouts).forRoots([
      { root: repository, worktreeParents: [] },
    ]);
    const placed = yield* placement.resolve(cwd, null);
    expect(placed.path).toBe(`${repository}/apps`);
    expect(placed.worktree).toBe(worktree);
  }),
);
