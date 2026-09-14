import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Either } from "effect";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { isCredentialPath, resolveOutsidePath, resolveProjectPath } from "../src/files/paths.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function layout() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "memory-agent-paths-")));
  directories.push(base);
  const project = join(base, "project");
  const outside = join(base, "outside");
  const storage = join(base, "storage");
  mkdirSync(join(project, "src"), { recursive: true });
  mkdirSync(join(project, ".git"));
  mkdirSync(outside);
  mkdirSync(storage);
  writeFileSync(join(project, "src", "app.ts"), "export {};\n");
  writeFileSync(join(project, ".gitignore"), "dist\n");
  writeFileSync(join(outside, "notes.md"), "# notes\n");
  return { base, project, outside, storage };
}

const reason = <A>(result: Either.Either<A, { reason: string }>) =>
  Either.isLeft(result) ? result.left.reason : "ok";

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
  test("resolves files, directories and new files below the root", () => {
    const { project } = layout();
    const file = resolveProjectPath(project, "src/app.ts", "file");
    expect(Either.getOrThrow(file).absolute).toBe(join(project, "src", "app.ts"));
    expect(reason(resolveProjectPath(project, ".", "directory"))).toBe("ok");
    expect(reason(resolveProjectPath(project, ".gitignore", "file"))).toBe("ok");
    const created = Either.getOrThrow(
      resolveProjectPath(project, "docs/new/plan.md", "new-or-file"),
    );
    expect(created).toMatchObject({
      absolute: join(project, "docs", "new", "plan.md"),
      stats: undefined,
    });
  });

  test("refuses escapes, .git, credentials and malformed spellings", () => {
    const { project } = layout();
    expect(reason(resolveProjectPath(project, "../outside/notes.md", "file"))).toBe("invalid_path");
    expect(reason(resolveProjectPath(project, "/etc/hosts", "file"))).toBe("invalid_path");
    expect(reason(resolveProjectPath(project, "src//app.ts", "file"))).toBe("invalid_path");
    expect(reason(resolveProjectPath(project, "src\\app.ts", "file"))).toBe("invalid_path");
    expect(reason(resolveProjectPath(project, ".git/config", "new-or-file"))).toBe("git_internal");
    expect(reason(resolveProjectPath(project, ".GIT/HEAD", "file"))).toBe("git_internal");
    expect(reason(resolveProjectPath(project, ".env", "new-or-file"))).toBe("credential");
  });

  test("refuses symlinks anywhere on the path and hard-linked files", () => {
    const { project, outside } = layout();
    symlinkSync(outside, join(project, "linked"));
    symlinkSync(join(outside, "notes.md"), join(project, "notes.md"));
    linkSync(join(outside, "notes.md"), join(project, "hard.md"));
    expect(reason(resolveProjectPath(project, "linked/notes.md", "file"))).toBe("symlink");
    expect(reason(resolveProjectPath(project, "linked/new.md", "new-or-file"))).toBe("symlink");
    expect(reason(resolveProjectPath(project, "notes.md", "file"))).toBe("symlink");
    expect(reason(resolveProjectPath(project, "hard.md", "file"))).toBe("hard_link");
  });

  test("reports kind mismatches", () => {
    const { project } = layout();
    expect(reason(resolveProjectPath(project, "src", "file"))).toBe("not_file");
    expect(reason(resolveProjectPath(project, "src/app.ts", "directory"))).toBe("not_directory");
    expect(reason(resolveProjectPath(project, "src/app.ts/x", "new-or-file"))).toBe(
      "not_directory",
    );
    expect(reason(resolveProjectPath(project, "missing.ts", "file"))).toBe("not_found");
  });
});

describe("resolveOutsidePath", () => {
  test("resolves outside files and new files to canonical paths", () => {
    const { project, outside, storage } = layout();
    const read = Either.getOrThrow(
      resolveOutsidePath(project, storage, join(outside, "notes.md"), "file"),
    );
    expect(read.absolute).toBe(join(outside, "notes.md"));
    const created = Either.getOrThrow(
      resolveOutsidePath(project, storage, join(outside, "a", "b.txt"), "new-or-file"),
    );
    expect(created).toMatchObject({ absolute: join(outside, "a", "b.txt"), stats: undefined });
  });

  test("refuses relative paths, the project, the storage root and credentials", () => {
    const { project, outside, storage } = layout();
    expect(reason(resolveOutsidePath(project, storage, "notes.md", "file"))).toBe("invalid_path");
    expect(reason(resolveOutsidePath(project, storage, join(project, "src/app.ts"), "file"))).toBe(
      "inside_project",
    );
    expect(reason(resolveOutsidePath(project, storage, project, "directory"))).toBe(
      "inside_project",
    );
    expect(
      reason(resolveOutsidePath(project, storage, join(storage, "agent.db"), "new-or-file")),
    ).toBe("credential");
    expect(reason(resolveOutsidePath(project, storage, join(outside, ".env"), "new-or-file"))).toBe(
      "credential",
    );
  });

  test("judges a symlink by where it points", () => {
    const { base, project, outside, storage } = layout();
    const secrets = join(base, ".ssh");
    mkdirSync(secrets);
    writeFileSync(join(secrets, "id_ed25519"), "secret");
    symlinkSync(join(secrets, "id_ed25519"), join(outside, "harmless.txt"));
    symlinkSync(project, join(outside, "project-link"));
    expect(
      reason(resolveOutsidePath(project, storage, join(outside, "harmless.txt"), "file")),
    ).toBe("credential");
    expect(
      reason(
        resolveOutsidePath(project, storage, join(outside, "project-link", "src"), "directory"),
      ),
    ).toBe("inside_project");
  });
});
