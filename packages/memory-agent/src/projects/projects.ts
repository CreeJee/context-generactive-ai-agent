import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import type { SQLOutputValue } from "node:sqlite";
import { basename, resolve } from "node:path";
import { Context, Data, Effect, Layer, Schema } from "effect";
import { StorageRoot } from "../config/storage-root.ts";
import { Database } from "../db/database.ts";
import { canonicalPath, pathsOverlap } from "../files/paths.ts";

export const Project = Schema.Struct({
  id: Schema.String,
  root: Schema.String,
  name: Schema.String,
  crossRecallExcluded: Schema.Boolean,
  createdAt: Schema.String,
});
export type Project = typeof Project.Type;

const ProjectRow = Schema.Struct({
  id: Schema.String,
  root: Schema.String,
  name: Schema.String,
  cross_recall_excluded: Schema.Literal(0, 1),
  created_at: Schema.String,
});
const decodeProjectRow = Schema.decodeUnknownSync(ProjectRow);

function toProject(row: Record<string, SQLOutputValue>): Project {
  const decoded = decodeProjectRow(row);
  return {
    id: decoded.id,
    root: decoded.root,
    name: decoded.name,
    crossRecallExcluded: decoded.cross_recall_excluded === 1,
    createdAt: decoded.created_at,
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
    list: Effect.sync(() =>
      db.sqlite.prepare("SELECT * FROM projects ORDER BY created_at, id").all().map(toProject),
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
          createdAt: new Date().toISOString(),
        };
        const inserted = db.sqlite
          .prepare("INSERT INTO projects VALUES (?, ?, ?, 0, ?) ON CONFLICT(root) DO NOTHING")
          .run(project.id, project.root, project.name, project.createdAt);
        if (inserted.changes === 0)
          return yield* new ProjectRootRejected({ root, reason: "already_registered" });
        return project;
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
  };
});

/** Project roots registered from the UI. Sessions, memory and grants belong to one project. */
export class Projects extends Context.Tag("memory-agent/Projects")<
  Projects,
  Effect.Effect.Success<typeof make>
>() {
  static readonly layer = Layer.effect(Projects, make);
}
