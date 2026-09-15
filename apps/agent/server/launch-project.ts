import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { Schema } from "effect";

/** The folder the app opens as a project, or why it opens none. */
export type LaunchFolder =
  | { readonly kind: "folder"; readonly root: string }
  | { readonly kind: "none" }
  | { readonly kind: "invalid"; readonly path: string };

const isInside = (child: string, parent: string) => {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};

const canonical = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/**
 * `context-agent <folder>` opens that folder; without one, the folder it was started from. A start
 * with no real working folder (a double-click starts in `/`, or the home folder) and the storage
 * root open no project: the app shows its project list as before.
 */
export function launchFolder(
  argument: string | undefined,
  cwd: string,
  storageRoot: string,
): LaunchFolder {
  const candidate = resolve(cwd, argument ?? ".");
  let root: string;
  try {
    root = realpathSync(candidate);
    if (!statSync(root).isDirectory()) throw new Error("not a directory");
  } catch {
    return argument === undefined ? { kind: "none" } : { kind: "invalid", path: candidate };
  }
  if (argument !== undefined) return { kind: "folder", root };
  if (
    root === dirname(root) ||
    root === canonical(homedir()) ||
    isInside(root, canonical(storageRoot))
  )
    return { kind: "none" };
  return { kind: "folder", root };
}

const Project = Schema.Struct({ id: Schema.String, root: Schema.String });
const Rejected = Schema.Struct({
  error: Schema.Literal("project_rejected"),
  reason: Schema.String,
});

export type OpenedProject =
  | { readonly kind: "opened"; readonly projectId: string; readonly added: boolean }
  | { readonly kind: "rejected"; readonly reason: string };

/** Whether something answering on this address is this app (it lists projects). */
export async function isThisApp(baseUrl: string) {
  try {
    const response = await fetch(`${baseUrl}/api/projects`, { signal: AbortSignal.timeout(3_000) });
    return response.ok && Schema.is(Schema.Array(Project))(await response.json());
  } catch {
    return false;
  }
}

/**
 * Registers the folder as a project on the running app, or finds it if it is registered already.
 * Goes through the app's own API, so the same path checks apply as when adding in the browser.
 */
export async function openProject(baseUrl: string, root: string): Promise<OpenedProject> {
  const response = await fetch(`${baseUrl}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ root }),
  });
  const body: unknown = await response.json();
  if (response.status === 201 && Schema.is(Project)(body))
    return { kind: "opened", projectId: body.id, added: true };
  if (!Schema.is(Rejected)(body)) return { kind: "rejected", reason: `status ${response.status}` };
  if (body.reason !== "already_registered") return { kind: "rejected", reason: body.reason };
  const projects: unknown = await (await fetch(`${baseUrl}/api/projects`)).json();
  const existing = Schema.is(Schema.Array(Project))(projects)
    ? projects.find((project) => project.root === root)
    : undefined;
  return existing
    ? { kind: "opened", projectId: existing.id, added: false }
    : { kind: "rejected", reason: "already_registered" };
}
