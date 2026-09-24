import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import type { SQLOutputValue } from "node:sqlite";
import { basename, resolve } from "node:path";
import { Context, Data, Effect, Layer, Schema } from "effect";
import { StorageRoot } from "../config/storage-root.ts";
import { Database } from "../db/database.ts";
import { canonicalPath, pathsOverlap } from "../files/paths.ts";

/**
 * How approval-gated tools (shell, writes outside the project) are allowed.
 * `ask`: the user answers every call. `auto`: a classifier allows, asks or blocks each call first.
 * `full`: approval-gated calls run immediately under the app's path and credential restrictions.
 */
export const PermissionMode = Schema.Literals(["ask", "auto", "full"]);
export type PermissionMode = typeof PermissionMode.Type;

export const Project = Schema.Struct({
  id: Schema.String,
  root: Schema.String,
  name: Schema.String,
  crossRecallExcluded: Schema.Boolean,
  permissionMode: PermissionMode,
  createdAt: Schema.String,
  /** When it was taken out of the sidebar; its memory is still there and still searched. */
  hiddenAt: Schema.NullOr(Schema.String),
});
export type Project = typeof Project.Type;

const ProjectRow = Schema.Struct({
  id: Schema.String,
  root: Schema.String,
  name: Schema.String,
  cross_recall_excluded: Schema.Literals([0, 1]),
  permission_mode: Schema.Literals(["ask", "auto"]),
  permission_full: Schema.Literals([0, 1]),
  created_at: Schema.String,
  hidden_at: Schema.NullOr(Schema.String),
});
const decodeProjectRow = Schema.decodeUnknownSync(ProjectRow);

function toProject(row: Record<string, SQLOutputValue>): Project {
  const decoded = decodeProjectRow(row);
  return {
    id: decoded.id,
    root: decoded.root,
    name: decoded.name,
    crossRecallExcluded: decoded.cross_recall_excluded === 1,
    permissionMode: decoded.permission_full === 1 ? "full" : decoded.permission_mode,
    createdAt: decoded.created_at,
    hiddenAt: decoded.hidden_at,
  };
}

export class ProjectRootRejected extends Data.TaggedError("ProjectRootRejected")<{
  readonly root: string;
  readonly reason: "not_found" | "not_directory" | "overlaps_storage" | "already_registered";
}> {}

export class ProjectNotFound extends Data.TaggedError("ProjectNotFound")<{
  readonly id: string;
}> {}

const make = Effect.gen(function* () {
  const db = yield* Database;
  const storage = yield* StorageRoot;
  const storageRoot = canonicalPath(storage.path);

  const find = (id: string) =>
    Effect.sync(() => db.sqlite.prepare("SELECT * FROM projects WHERE id = ?").get(id)).pipe(
      Effect.flatMap((row) =>
        row ? Effect.succeed(toProject(row)) : Effect.fail(new ProjectNotFound({ id })),
      ),
    );

  return {
    /** The projects offered for choosing. Hidden ones still own their memory and are still searched. */
    list: Effect.sync(() =>
      db.sqlite
        .prepare("SELECT * FROM projects WHERE hidden_at IS NULL ORDER BY created_at, id")
        .all()
        .map(toProject),
    ),

    /** Every project, hidden ones included: what the importer matches a recorded folder against. */
    listAll: Effect.sync(() =>
      db.sqlite.prepare("SELECT * FROM projects ORDER BY created_at, id").all().map(toProject),
    ),

    /** Taken out of the sidebar, or put back. Nothing about its memory changes either way. */
    setHidden: (id: string, hidden: boolean) =>
      Effect.sync(() =>
        db.sqlite
          .prepare("UPDATE projects SET hidden_at = ? WHERE id = ?")
          .run(hidden ? new Date().toISOString() : null, id),
      ).pipe(
        Effect.flatMap((result) =>
          result.changes === 0 ? Effect.fail(new ProjectNotFound({ id })) : find(id),
        ),
      ),

    get: find,

    /** Registering a root widens what file and shell tools may touch, so it is checked here. */
    add: (requestedRoot: string) =>
      Effect.gen(function* () {
        const absolute = resolve(requestedRoot);
        const root = yield* Effect.try({
          try: () => realpathSync.native(absolute),
          catch: () => new ProjectRootRejected({ root: absolute, reason: "not_found" }),
        });
        if (!statSync(root).isDirectory())
          return yield* new ProjectRootRejected({ root, reason: "not_directory" });
        if (pathsOverlap(root, storageRoot))
          return yield* new ProjectRootRejected({ root, reason: "overlaps_storage" });

        const project: Project = {
          id: randomUUID(),
          root,
          name: basename(root) || root,
          crossRecallExcluded: false,
          permissionMode: "ask",
          createdAt: new Date().toISOString(),
          hiddenAt: null,
        };
        // Adding a folder that is registered but hidden puts it back in the list: asking for it
        // again is the same intent as un-hiding it, and there is no other way back.
        const row = db.sqlite
          .prepare(`
            INSERT INTO projects (id, root, name, created_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(root) DO UPDATE SET hidden_at = NULL WHERE projects.hidden_at IS NOT NULL
            RETURNING *`)
          .get(project.id, project.root, project.name, project.createdAt);
        if (!row) return yield* new ProjectRootRejected({ root, reason: "already_registered" });
        return toProject(row);
      }),

    /** R08: excluded projects keep their memory but are not searched from other projects. */
    setCrossRecallExcluded: (id: string, excluded: boolean) =>
      Effect.sync(() =>
        db.sqlite
          .prepare("UPDATE projects SET cross_recall_excluded = ? WHERE id = ?")
          .run(excluded ? 1 : 0, id),
      ).pipe(
        Effect.flatMap((result) =>
          result.changes === 0 ? Effect.fail(new ProjectNotFound({ id })) : find(id),
        ),
      ),

    /** Choosing `auto` or `full` records the user's standing permission policy. */
    setPermissionMode: (id: string, mode: PermissionMode) =>
      Effect.sync(() =>
        db.sqlite
          .prepare("UPDATE projects SET permission_mode = ?, permission_full = ? WHERE id = ?")
          .run(mode === "full" ? "auto" : mode, mode === "full" ? 1 : 0, id),
      ).pipe(
        Effect.flatMap((result) =>
          result.changes === 0 ? Effect.fail(new ProjectNotFound({ id })) : find(id),
        ),
      ),
  };
});

/** Project roots registered from the UI. Sessions, memory and grants belong to one project. */
export class Projects extends Context.Service<Projects, Effect.Success<typeof make>>()(
  "memory-agent/Projects",
) {
  static readonly layer = Layer.effect(Projects, make);
}
