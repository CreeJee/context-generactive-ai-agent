import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { join, posix } from "node:path";
import { promisify } from "node:util";
import { findExecutable } from "../runtime/host.ts";
import { gitEnvironment } from "./git-grep.ts";
import { isCredentialPath } from "./paths.ts";

const run = promisify(execFile);

/** File checks run at once when listing a Git work tree. */
const statConcurrency = 64;

/** Maps items with at most `limit` running at once, keeping the input order. */
async function mapLimit<A, B>(
  items: readonly A[],
  limit: number,
  work: (item: A) => Promise<B>,
): Promise<B[]> {
  const results: B[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Directories skipped when walking a project that is not a Git work tree. */
const walkSkips = new Set([".git", "node_modules"]);

/** Files a walk collects before it stops and reports itself truncated. */
export const walkLimit = 50_000;

export interface FileListing {
  /** Sorted file paths: project-relative for project listings, absolute for outside listings. */
  readonly paths: readonly string[];
  /** `git` when Git decided (tracked plus untracked, honouring ignore rules), else `walk`. */
  readonly source: "git" | "walk";
  /** Files and directories left out because they look like credentials. */
  readonly excluded: number;
  /** True when a walk stopped at {@link walkLimit} files. */
  readonly truncated: boolean;
}

async function gitFiles(root: string, directory: string): Promise<string[] | null> {
  const git = findExecutable("git");
  if (!git) return null;
  try {
    const { stdout } = await run(
      git,
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", directory],
      { cwd: root, maxBuffer: 256 * 1024 * 1024, windowsHide: true, env: gitEnvironment(git) },
    );
    return stdout.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * Regular files below `directory` (relative to `base`), not following links and not descending
 * into `.git`, `node_modules` or credential-looking directories. Directory names are judged as
 * `credentialPrefix` joined with the relative path: empty for a project, whose root may itself sit
 * under an unusual name, and the absolute base outside, where `~/.config` + `gh` must still match.
 */
async function walkFiles(base: string, directory: string, credentialPrefix: string) {
  const files: string[] = [];
  let excluded = 0;
  let truncated = false;
  const visit = async (relative: string) => {
    const entries = await readdir(join(base, relative), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files.length >= walkLimit) {
        truncated = true;
        return;
      }
      const path = relative === "." ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (walkSkips.has(entry.name)) continue;
        if (isCredentialPath(join(credentialPrefix, path))) excluded++;
        else await visit(path);
      } else if (entry.isFile()) files.push(path);
    }
  };
  await visit(directory);
  return { files, excluded, truncated };
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
  const walked = fromGit ? undefined : await walkFiles(root, directory, "");
  const prefix = directory === "." ? "" : `${directory}/`;
  let excluded = walked?.excluded ?? 0;
  const kept: string[] = [];
  for (const path of new Set(fromGit ?? walked?.files)) {
    if (!path.startsWith(prefix)) continue;
    if (glob !== undefined && !posix.matchesGlob(path.slice(prefix.length), glob)) continue;
    if (path.split("/").some((segment) => segment.toLowerCase() === ".git")) continue;
    if (isCredentialPath(path)) {
      excluded++;
      continue;
    }
    kept.push(path);
  }
  // A walk already saw regular files only. Git lists links and deleted files too, so check those,
  // many at a time.
  const paths = fromGit
    ? (
        await mapLimit(kept, statConcurrency, async (path) =>
          (await lstat(join(root, path)).catch(() => undefined))?.isFile() ? path : null,
        )
      ).filter((path) => path !== null)
    : kept;
  paths.sort();
  return {
    paths,
    source: fromGit ? "git" : "walk",
    excluded,
    truncated: walked?.truncated ?? false,
  };
}

/**
 * Every regular file below an outside `directory` (canonical, already validated), as absolute
 * paths, optionally filtered by a glob relative to it. Never uses Git ignore rules: outside
 * listings show what is on disk, minus links, `.git`, `node_modules` and credentials.
 */
export async function listOutsideFiles(
  directory: string,
  glob: string | undefined,
): Promise<FileListing> {
  const walked = await walkFiles(directory, ".", directory);
  let excluded = walked.excluded;
  const paths: string[] = [];
  for (const relative of walked.files) {
    if (glob !== undefined && !posix.matchesGlob(relative, glob)) continue;
    const absolute = join(directory, relative);
    if (isCredentialPath(absolute)) excluded++;
    else paths.push(absolute);
  }
  paths.sort();
  return { paths, source: "walk", excluded, truncated: walked.truncated };
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
