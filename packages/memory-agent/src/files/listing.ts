import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { join, posix } from "node:path";
import { promisify } from "node:util";
import { isCredentialPath } from "./paths.ts";

const run = promisify(execFile);

/** Directories skipped when walking a project that is not a Git work tree. */
const walkSkips = new Set([".git", "node_modules"]);

export interface FileListing {
  /** Project-relative file paths, sorted. */
  readonly paths: readonly string[];
  /** `git` when Git decided (tracked plus untracked, honouring ignore rules), else `walk`. */
  readonly source: "git" | "walk";
  /** Files left out because they look like credentials. */
  readonly excluded: number;
}

async function gitFiles(root: string, directory: string): Promise<string[] | null> {
  try {
    const { stdout } = await run(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", directory],
      { cwd: root, maxBuffer: 256 * 1024 * 1024, env: { PATH: "/usr/bin:/bin:/usr/local/bin" } },
    );
    return stdout.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

async function walkFiles(root: string, directory: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (relative: string) => {
    const entries = await readdir(join(root, relative), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = relative === "." ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory() && !walkSkips.has(entry.name)) await visit(path);
      else if (entry.isFile()) found.push(path);
    }
  };
  await visit(directory);
  return found;
}

/**
 * Every regular file below `directory` (project-relative, already validated), optionally filtered
 * by a glob relative to that directory. Symlinks, `.git` and credential-looking files are left out;
 * a tracked file deleted from disk is not listed.
 */
export async function listProjectFiles(
  root: string,
  directory: string,
  glob: string | undefined,
): Promise<FileListing> {
  const fromGit = await gitFiles(root, directory);
  const candidates = fromGit ?? (await walkFiles(root, directory));
  const prefix = directory === "." ? "" : `${directory}/`;
  let excluded = 0;
  const paths: string[] = [];
  for (const path of new Set(candidates)) {
    if (!path.startsWith(prefix)) continue;
    if (glob !== undefined && !posix.matchesGlob(path.slice(prefix.length), glob)) continue;
    if (path.split("/").some((segment) => segment.toLowerCase() === ".git")) continue;
    if (isCredentialPath(path)) {
      excluded++;
      continue;
    }
    const stats = await lstat(join(root, path)).catch(() => undefined);
    if (stats?.isFile()) paths.push(path);
  }
  paths.sort();
  return { paths, source: fromGit ? "git" : "walk", excluded };
}

export interface Snapshot extends FileListing {
  readonly id: string;
  readonly root: string;
  readonly directory: string;
  readonly glob: string | undefined;
}

/**
 * Recent listings, so paging through `list_files` or `search_files` walks one fixed set of files
 * instead of a tree that shifts between pages. Old snapshots are dropped first.
 */
export class Snapshots {
  readonly #entries = new Map<string, Snapshot>();

  constructor(readonly capacity = 32) {}

  add(root: string, directory: string, glob: string | undefined, listing: FileListing) {
    const snapshot: Snapshot = { id: randomUUID(), root, directory, glob, ...listing };
    this.#entries.set(snapshot.id, snapshot);
    for (const id of this.#entries.keys()) {
      if (this.#entries.size <= this.capacity) break;
      this.#entries.delete(id);
    }
    return snapshot;
  }

  /** A snapshot taken for this project root, or undefined when unknown or evicted. */
  get(id: string, root: string) {
    const snapshot = this.#entries.get(id);
    return snapshot?.root === root ? snapshot : undefined;
  }
}
