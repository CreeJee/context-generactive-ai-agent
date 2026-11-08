import os from "node:os";
import { Effect, FileSystem, Option, Schema } from "effect";
import { Projects, type Project } from "../projects/projects.ts";
import { path } from "../runtime/synchronous-path.ts";

/**
 * Which project a CLI read starts from. Another agent calling this CLI knows a working directory,
 * not a project id, so a project is named by id, by path or by name, and otherwise found from the
 * directory the command runs in.
 */

/** A refused command: one tagged code the entry point prints and turns into an exit status. */
export class CliFailure extends Schema.TaggedError<CliFailure, { readonly brand: unique symbol }>()(
  "CliFailure",
  {
    code: Schema.String,
    detail: Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
  },
) {}

/** What a caller that cannot resolve a project should try next. */
export const projectHint =
  "run `projects` to list registered projects, then pass --project-id <id> or --project <root path>";

/**
 * A stored project root is a `realPath`, so a path is compared the same way: `~` expanded, made
 * absolute against the working directory and resolved through its links. A path that does not
 * exist keeps its absolute form, which simply matches no project.
 */
export const canonicalPath = Effect.fn("cli.canonicalPath")(function* (requested: string) {
  const fs = yield* FileSystem.FileSystem;
  const expanded = requested.startsWith("~")
    ? path.join(os.homedir(), requested.slice(1))
    : requested;
  const absolute = path.resolve(expanded);
  return yield* fs.realPath(absolute).pipe(Effect.orElseSucceed(() => absolute));
});

/** Anything that names a place rather than a project: absolute, relative, `~` or with separators. */
export const looksLikePath = (value: string) =>
  value === "." ||
  value === ".." ||
  value.startsWith("/") ||
  value.startsWith("~") ||
  value.startsWith(`.${path.sep}`) ||
  value.startsWith(`..${path.sep}`) ||
  value.includes(path.sep);

/**
 * The registered project a path belongs to. Projects can nest, so the deepest root that contains
 * the path wins: a folder inside a registered project resolves to that project, not its parent.
 */
const deepestContaining = (projects: ReadonlyArray<Project>, candidate: string) => {
  let best: Project | undefined;
  for (const project of projects) {
    const contains =
      candidate === project.root || candidate.startsWith(`${project.root}${path.sep}`);
    if (contains && (best === undefined || project.root.length > best.root.length)) {
      best = project;
    }
  }
  return best;
};

/** How a command names the project it reads from. */
export interface ProjectSelection {
  readonly projectId: Option.Option<string>;
  readonly project: Option.Option<string>;
  /** The directory the command runs in, used when neither flag names a project. */
  readonly cwd: string;
}

/**
 * `--project-id` exactly, else `--project` as a root path or a name, else the registered project
 * the working directory sits in. None of those resolving refuses the command: without a project
 * there is no scope that says which memory may be read.
 */
export const resolveProjectId = Effect.fn("cli.resolveProjectId")(function* (
  selection: ProjectSelection,
) {
  const projects = yield* Projects;
  // Hidden projects keep their memory and stay searchable, so they stay addressable here.
  const all = yield* projects.listAll;

  if (Option.isSome(selection.projectId)) {
    const wanted = selection.projectId.value;
    const byId = all.find((project) => project.id === wanted);
    if (byId !== undefined) return byId.id;
    return yield* CliFailure.make({
      code: "project_not_found",
      detail: { projectId: wanted, hint: projectHint },
    });
  }

  if (Option.isSome(selection.project)) {
    const reference = selection.project.value;
    if (looksLikePath(reference)) {
      const candidate = yield* canonicalPath(reference);
      const byRoot = deepestContaining(all, candidate);
      if (byRoot !== undefined) return byRoot.id;
      return yield* CliFailure.make({
        code: "project_not_found",
        detail: { project: reference, resolvedPath: candidate, hint: projectHint },
      });
    }
    const byName = all.find((project) => project.name === reference);
    if (byName !== undefined) return byName.id;
    return yield* CliFailure.make({
      code: "project_not_found",
      detail: { project: reference, hint: projectHint },
    });
  }

  const here = deepestContaining(all, yield* canonicalPath(selection.cwd));
  if (here !== undefined) return here.id;
  return yield* CliFailure.make({
    code: "project_not_found",
    detail: { cwd: selection.cwd, hint: projectHint },
  });
});
