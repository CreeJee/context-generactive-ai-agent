import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { homedir, tmpdir } from "node:os";
import { Effect, FileSystem, Layer, Option, Path } from "effect";
import { describe, expect } from "vite-plus/test";
import {
  folderMentions,
  resolveOutsideToolPath,
  resolveRootPath,
  resolveWorkingDirectory,
  writableRoots,
  type ToolRoots,
} from "../src/files/path-policy.ts";
import type { PathRejected } from "../src/files/paths.ts";
import { withTestPlatform } from "./support/platform.ts";

/** A user's project, a card worktree copy of it, a folder outside both, and the storage root. */
const layout = Effect.fn("pathPolicy.layout")(function* () {
  const context = yield* Layer.build(Layer.merge(NodeFileSystem.layer, NodePath.layer));
  return yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const base = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "memory-agent-path-policy-" }),
    );
    const user = path.join(base, "user");
    const card = path.join(base, "worktrees", "g1", "c1");
    const outside = path.join(base, "outside");
    const storage = path.join(base, "storage");
    yield* Effect.forEach(
      [path.join(user, "src"), path.join(card, "src"), outside, storage],
      (directory) => fs.makeDirectory(directory, { recursive: true }),
      { discard: true },
    );
    yield* fs.writeFileString(path.join(user, "src", "app.ts"), "user\n");
    yield* fs.writeFileString(path.join(card, "src", "app.ts"), "card\n");
    yield* fs.writeFileString(path.join(outside, "notes.md"), "# notes\n");
    const project: ToolRoots = { root: user };
    const cardRun: ToolRoots = {
      root: card,
      toolFence: { deniedRoots: [user, path.join(base, "worktrees")], userRoot: user },
    };
    return { base, user, card, outside, storage, project, cardRun, fs, path };
  }).pipe(Effect.provideContext(context));
});

const reason = <A, R>(
  effect: Effect.Effect<A, PathRejected | import("effect").PlatformError.PlatformError, R>,
) =>
  effect.pipe(
    Effect.as("ok"),
    Effect.catchTag("PathRejected", (error) => Effect.succeed(error.reason)),
  );

describe("project file tool paths", () => {
  it.live("take an absolute path inside the root as the relative path it spells", () =>
    Effect.gen(function* () {
      const { user, project, path } = yield* layout();
      expect(
        yield* resolveRootPath(project, path.join(user, "src", "app.ts"), "file"),
      ).toMatchObject({
        absolute: path.join(user, "src", "app.ts"),
        relative: "src/app.ts",
        mappedNote: Option.none(),
      });
      expect(yield* resolveRootPath(project, user, "directory")).toMatchObject({ relative: "." });
      expect((yield* resolveRootPath(project, "src/app.ts", "file")).relative).toBe("src/app.ts");
    }).pipe(withTestPlatform),
  );

  it.live("compare real paths, so a root or a path spelled through a link lands in the root", () =>
    Effect.gen(function* () {
      const { base, user, project, fs, path } = yield* layout();
      // Like macOS's /tmp, a link to /private/tmp, above the project.
      const link = path.join(base, "base-link");
      yield* fs.symlink(base, link);
      expect(
        (yield* resolveRootPath(
          { root: path.join(link, "user") },
          path.join(user, "src", "app.ts"),
          "file",
        )).relative,
      ).toBe("src/app.ts");
      expect(
        (yield* resolveRootPath(project, path.join(link, "user", "src", "app.ts"), "file"))
          .relative,
      ).toBe("src/app.ts");
    }).pipe(withTestPlatform),
  );

  it.live(
    "refuse absolute paths outside the root, escapes with .., and keep the project rules",
    () =>
      Effect.gen(function* () {
        const { user, outside, project, fs, path } = yield* layout();
        yield* fs.makeDirectory(path.join(user, ".git"));
        expect(
          yield* reason(resolveRootPath(project, path.join(outside, "notes.md"), "file")),
        ).toBe("outside_project");
        expect(yield* reason(resolveRootPath(project, `${user}/../outside/notes.md`, "file"))).toBe(
          "outside_project",
        );
        expect(yield* reason(resolveRootPath(project, "../outside/notes.md", "file"))).toBe(
          "invalid_path",
        );
        expect(
          yield* reason(resolveRootPath(project, path.join(user, ".git", "config"), "new-or-file")),
        ).toBe("git_internal");
        expect(
          yield* reason(resolveRootPath(project, path.join(user, ".env"), "new-or-file")),
        ).toBe("credential");
      }).pipe(withTestPlatform),
  );

  it.live("map a path in the user's project folder to the same place in a card's worktree", () =>
    Effect.gen(function* () {
      const { user, card, cardRun, path } = yield* layout();
      const given = path.join(user, "src", "app.ts");
      const resolved = yield* resolveRootPath(cardRun, given, "file");
      expect(resolved).toMatchObject({
        absolute: path.join(card, "src", "app.ts"),
        relative: "src/app.ts",
      });
      expect(Option.getOrThrow(resolved.mappedNote)).toContain(`${given} is in the user's`);
      // The card's own spelling is not a mapping.
      expect(
        (yield* resolveRootPath(cardRun, path.join(card, "src", "app.ts"), "file")).mappedNote,
      ).toEqual(Option.none());
    }).pipe(withTestPlatform),
  );
});

describe("outside tool paths", () => {
  it.live("refuse a project path with the relative path the file tools take", () =>
    Effect.gen(function* () {
      const { user, outside, storage, project, cardRun, path } = yield* layout();
      const refusal = (roots: ToolRoots, given: string) =>
        resolveOutsideToolPath(roots, storage, given, "file").pipe(
          Effect.as({ reason: "ok", target: undefined }),
          Effect.catchTag("PathRejected", ({ reason, target }) =>
            Effect.succeed({ reason, target }),
          ),
        );
      expect(yield* refusal(project, path.join(user, "src", "app.ts"))).toEqual({
        reason: "inside_project",
        target: "src/app.ts",
      });
      expect(yield* refusal(cardRun, path.join(user, "src", "app.ts"))).toEqual({
        reason: "inside_project",
        target: "src/app.ts",
      });
      expect(yield* refusal(project, path.join(user, ".env"))).toEqual({
        reason: "credential",
        target: undefined,
      });
      expect(yield* refusal(project, "notes.md")).toEqual({
        reason: "invalid_path",
        target: undefined,
      });
      expect(
        (yield* resolveOutsideToolPath(project, storage, path.join(outside, "notes.md"), "file"))
          .absolute,
      ).toBe(path.join(outside, "notes.md"));
    }).pipe(withTestPlatform),
  );
});

describe("run_skill working directory", () => {
  it.live("takes project paths as the file tools do, temporary folders, and nothing else", () =>
    Effect.gen(function* () {
      const { user, card, storage, project, cardRun, path } = yield* layout();
      expect(
        yield* resolveWorkingDirectory(project, storage, path.join(user, "src")),
      ).toMatchObject({ absolute: path.join(user, "src"), relative: "src" });
      const mapped = yield* resolveWorkingDirectory(cardRun, storage, user);
      expect(mapped).toMatchObject({ absolute: card, relative: "." });
      expect(Option.isSome(mapped.mappedNote)).toBe(true);
      // A temporary folder outside the project, spelled as the host gives it.
      expect((yield* resolveWorkingDirectory(project, storage, tmpdir())).relative).not.toBe(".");
      expect(yield* reason(resolveWorkingDirectory(project, storage, "/usr"))).toBe(
        "outside_project",
      );
    }).pipe(withTestPlatform),
  );
});

describe("sh skill sandbox", () => {
  it.live("may write the run's root and the temporary folders as real paths", () =>
    Effect.gen(function* () {
      const { base, card, fs, path } = yield* layout();
      const link = path.join(base, "card-link");
      yield* fs.symlink(card, link);
      const writable = yield* writableRoots(link);
      expect(writable).toContain(card);
      expect(writable).toContain(yield* fs.realPath(tmpdir()));
      expect(writable).toContain(yield* fs.realPath("/tmp"));
    }).pipe(withTestPlatform),
  );
});

describe("saved programs", () => {
  it.live("find the run's folders named by absolute path, as a whole path only", () =>
    Effect.gen(function* () {
      const { user, card, cardRun, path } = yield* layout();
      expect(yield* folderMentions(cardRun, `cd ${user} && pnpm test`)).toEqual([
        { folder: "user", spelling: user },
      ]);
      expect(
        yield* folderMentions(cardRun, `node "${path.join(card, "scripts", "a.js")}"`),
      ).toEqual([{ folder: "root", spelling: card }]);
      expect(yield* folderMentions(cardRun, `cd ${user}-old && ls ${user}2`)).toEqual([]);
      expect(yield* folderMentions(cardRun, "cd ./src && pnpm test")).toEqual([]);
    }).pipe(withTestPlatform),
  );

  it.live("find a folder below the home folder spelled from ~ or $HOME", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.realPath(homedir());
      // Only the spelling is compared; the folder need not exist.
      const roots: ToolRoots = { root: path.join(home, "work", "app") };
      expect(yield* folderMentions(roots, "cd ~/work/app/src")).toEqual([
        { folder: "root", spelling: "~/work/app" },
      ]);
      expect(yield* folderMentions(roots, 'cd "$HOME/work/app"')).toEqual([
        { folder: "root", spelling: "$HOME/work/app" },
      ]);
    }).pipe(withTestPlatform),
  );
});
