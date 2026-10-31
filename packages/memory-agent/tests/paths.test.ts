import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { isCredentialPath, resolveOutsidePath, resolveProjectPath } from "../src/files/paths.ts";
import { withTestPlatform } from "./support/platform.ts";

const layout = Effect.fn("paths.layout")(function* () {
  const context = yield* Layer.build(Layer.merge(NodeFileSystem.layer, NodePath.layer));
  return yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const base = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "memory-agent-paths-" }),
    );
    const project = path.join(base, "project");
    const outside = path.join(base, "outside");
    const storage = path.join(base, "storage");
    yield* fs.makeDirectory(path.join(project, "src"), { recursive: true });
    yield* fs.makeDirectory(path.join(project, ".git"));
    yield* fs.makeDirectory(outside);
    yield* fs.makeDirectory(storage);
    yield* fs.writeFileString(path.join(project, "src", "app.ts"), "export {};\n");
    yield* fs.writeFileString(path.join(project, ".gitignore"), "dist\n");
    yield* fs.writeFileString(path.join(outside, "notes.md"), "# notes\n");
    return { base, project, outside, storage, fs, path };
  }).pipe(Effect.provideContext(context));
});

const reason = <A, R>(
  effect: Effect.Effect<
    A,
    import("../src/files/paths.ts").PathRejected | import("effect").PlatformError.PlatformError,
    R
  >,
) =>
  effect.pipe(
    Effect.as("ok"),
    Effect.catchTag("PathRejected", (error) => Effect.succeed(error.reason)),
  );

describe("isCredentialPath", () => {
  test.each([
    "/Users/me/.ssh/config",
    "/Users/me/.aws/credentials",
    "/Users/me/.config/gh/hosts.yml",
    "/Users/me/.codex/auth.json",
    "/Users/me/.context-generactive-agent/agent.db",
    "app/.env",
    "app/.env.production",
    "deploy/server.pem",
    "config/secrets/prod.json",
    "aws-credentials.txt",
    "private_key.json",
    "home/.npmrc",
    "keys/id_ed25519",
  ])("refuses %s", (path) => expect(isCredentialPath(path)).toBe(true));

  test.each([
    "app/.env.example",
    "src/lexer/tokens.ts",
    "design-tokens.json",
    "src/auth/password-reset.tsx",
    "README.md",
    ".gitignore",
  ])("allows %s", (path) => expect(isCredentialPath(path)).toBe(false));
});

describe("resolveProjectPath", () => {
  it.live("resolves files, directories and new files below the root", () =>
    Effect.gen(function* () {
      const { project, path } = yield* layout();
      const file = yield* resolveProjectPath(project, "src/app.ts", "file");
      expect(file.absolute).toBe(path.join(project, "src", "app.ts"));
      expect(yield* reason(resolveProjectPath(project, ".", "directory"))).toBe("ok");
      expect(yield* reason(resolveProjectPath(project, ".gitignore", "file"))).toBe("ok");
      const created = yield* resolveProjectPath(project, "docs/new/plan.md", "new-or-file");
      expect(created).toMatchObject({
        absolute: path.join(project, "docs", "new", "plan.md"),
        stats: undefined,
      });
    }).pipe(withTestPlatform),
  );

  it.live("refuses escapes, .git, credentials and malformed spellings", () =>
    Effect.gen(function* () {
      const { project } = yield* layout();
      expect(yield* reason(resolveProjectPath(project, "../outside/notes.md", "file"))).toBe(
        "invalid_path",
      );
      expect(yield* reason(resolveProjectPath(project, "/etc/hosts", "file"))).toBe("invalid_path");
      expect(yield* reason(resolveProjectPath(project, "src//app.ts", "file"))).toBe(
        "invalid_path",
      );
      expect(yield* reason(resolveProjectPath(project, "src\\app.ts", "file"))).toBe(
        "invalid_path",
      );
      expect(yield* reason(resolveProjectPath(project, ".git/config", "new-or-file"))).toBe(
        "git_internal",
      );
      expect(yield* reason(resolveProjectPath(project, ".GIT/HEAD", "file"))).toBe("git_internal");
      expect(yield* reason(resolveProjectPath(project, ".env", "new-or-file"))).toBe("credential");
    }).pipe(withTestPlatform),
  );

  it.live("refuses symlinks anywhere on the path and hard-linked files", () =>
    Effect.gen(function* () {
      const { project, outside, fs, path } = yield* layout();
      yield* fs.symlink(outside, path.join(project, "linked"));
      yield* fs.symlink(path.join(outside, "notes.md"), path.join(project, "notes.md"));
      yield* fs.link(path.join(outside, "notes.md"), path.join(project, "hard.md"));
      expect(yield* reason(resolveProjectPath(project, "linked/notes.md", "file"))).toBe("symlink");
      expect(yield* reason(resolveProjectPath(project, "linked/new.md", "new-or-file"))).toBe(
        "symlink",
      );
      expect(yield* reason(resolveProjectPath(project, "notes.md", "file"))).toBe("symlink");
      expect(yield* reason(resolveProjectPath(project, "hard.md", "file"))).toBe("hard_link");
    }).pipe(withTestPlatform),
  );

  it.live("names where a refused link leads only when a file tool could use that path", () =>
    Effect.gen(function* () {
      const { project, outside, fs, path } = yield* layout();
      yield* fs.symlink(path.join(project, "src"), path.join(project, "current"));
      yield* fs.symlink(path.join(project, ".git"), path.join(project, "git-link"));
      yield* fs.symlink(outside, path.join(project, "linked"));
      const refused = (spelled: string) =>
        Effect.flip(resolveProjectPath(project, spelled, "file"));
      expect(yield* refused("current/app.ts")).toMatchObject({
        reason: "symlink",
        target: "src/app.ts",
      });
      expect(yield* refused("git-link/HEAD")).not.toHaveProperty("target");
      expect(yield* refused("linked/notes.md")).not.toHaveProperty("target");
    }).pipe(withTestPlatform),
  );

  it.live("reports kind mismatches", () =>
    Effect.gen(function* () {
      const { project } = yield* layout();
      expect(yield* reason(resolveProjectPath(project, "src", "file"))).toBe("not_file");
      expect(yield* reason(resolveProjectPath(project, "src/app.ts", "directory"))).toBe(
        "not_directory",
      );
      expect(yield* reason(resolveProjectPath(project, "src/app.ts/x", "new-or-file"))).toBe(
        "not_directory",
      );
      expect(yield* reason(resolveProjectPath(project, "missing.ts", "file"))).toBe("not_found");
    }).pipe(withTestPlatform),
  );
});

describe("resolveOutsidePath", () => {
  it.live("resolves outside files and new files to canonical paths", () =>
    Effect.gen(function* () {
      const { project, outside, storage, path } = yield* layout();
      const read = yield* resolveOutsidePath(
        project,
        storage,
        path.join(outside, "notes.md"),
        "file",
      );
      expect(read.absolute).toBe(path.join(outside, "notes.md"));
      const created = yield* resolveOutsidePath(
        project,
        storage,
        path.join(outside, "a", "b.txt"),
        "new-or-file",
      );
      expect(created).toMatchObject({
        absolute: path.join(outside, "a", "b.txt"),
        stats: undefined,
      });
    }).pipe(withTestPlatform),
  );

  it.live("refuses relative paths, the project, the storage root and credentials", () =>
    Effect.gen(function* () {
      const { project, outside, storage, path } = yield* layout();
      expect(yield* reason(resolveOutsidePath(project, storage, "notes.md", "file"))).toBe(
        "invalid_path",
      );
      expect(
        yield* reason(
          resolveOutsidePath(project, storage, path.join(project, "src/app.ts"), "file"),
        ),
      ).toBe("inside_project");
      expect(yield* reason(resolveOutsidePath(project, storage, project, "directory"))).toBe(
        "inside_project",
      );
      expect(
        yield* reason(
          resolveOutsidePath(project, storage, path.join(storage, "agent.db"), "new-or-file"),
        ),
      ).toBe("credential");
      expect(
        yield* reason(
          resolveOutsidePath(project, storage, path.join(outside, ".env"), "new-or-file"),
        ),
      ).toBe("credential");
    }).pipe(withTestPlatform),
  );

  it.live("judges a symlink by where it points", () =>
    Effect.gen(function* () {
      const { base, project, outside, storage, fs, path } = yield* layout();
      const secrets = path.join(base, ".ssh");
      yield* fs.makeDirectory(secrets);
      yield* fs.writeFileString(path.join(secrets, "id_ed25519"), "secret");
      yield* fs.symlink(path.join(secrets, "id_ed25519"), path.join(outside, "harmless.txt"));
      yield* fs.symlink(project, path.join(outside, "project-link"));
      expect(
        yield* reason(
          resolveOutsidePath(project, storage, path.join(outside, "harmless.txt"), "file"),
        ),
      ).toBe("credential");
      expect(
        yield* reason(
          resolveOutsidePath(
            project,
            storage,
            path.join(outside, "project-link", "src"),
            "directory",
          ),
        ),
      ).toBe("inside_project");
    }).pipe(withTestPlatform),
  );

  it.live("protects the directories a linked project or storage root points to", () =>
    Effect.gen(function* () {
      const { base, project, storage, fs, path } = yield* layout();
      const projectLink = path.join(base, "project-link");
      const storageLink = path.join(base, "storage-link");
      yield* fs.symlink(project, projectLink);
      yield* fs.symlink(storage, storageLink);
      yield* fs.writeFileString(path.join(storage, "state.txt"), "state");
      expect(
        yield* reason(
          resolveOutsidePath(projectLink, storage, path.join(project, "src/app.ts"), "file"),
        ),
      ).toBe("inside_project");
      expect(
        yield* reason(
          resolveOutsidePath(project, storageLink, path.join(storage, "state.txt"), "file"),
        ),
      ).toBe("credential");
    }).pipe(withTestPlatform),
  );
});
