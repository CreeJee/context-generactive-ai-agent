import { Result, Function as EffectFunction } from "effect";
import { isTruthy } from "../truthy.ts";
import type { SQLOutputValue } from "node:sqlite";
import {
  DateTime,
  Clock,
  Context,
  Crypto,
  Data,
  Effect,
  FileSystem,
  Layer,
  Path,
  Schema,
} from "effect";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { StorageRoot } from "../config/storage-root.ts";
import { Database } from "../db/database.ts";

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
// Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
const decodeProjectRow = EffectFunction.flow(
  Schema.decodeUnknownResult(ProjectRow),
  Result.getOrThrow,
);

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

export class ProjectHostFailed extends Schema.TaggedError<ProjectHostFailed>()(
  "ProjectHostFailed",
  {
    root: Schema.String,
    reason: Schema.Union([
      Schema.TaggedStruct("RealPathFailed", { cause: Schema.Defect() }),
      Schema.TaggedStruct("StatFailed", { cause: Schema.Defect() }),
      Schema.TaggedStruct("IdentityFailed", { cause: Schema.Defect() }),
    ]),
  },
) {}

const make = Effect.gen(function* () {
  const effectClock = yield* Clock.Clock;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const canonical = Effect.fnUntraced(function* (
    requested: string,
  ): Effect.fn.Return<string, ProjectHostFailed> {
    return yield* fs.realPath(requested).pipe(
      Effect.catchTag("PlatformError", (error) => {
        switch (error.reason._tag) {
          case "NotFound": {
            const parent = path.dirname(requested);
            return parent === requested
              ? Effect.succeed(requested)
              : canonical(parent).pipe(
                  Effect.map((resolved) => path.join(resolved, path.basename(requested))),
                );
          }
          default:
            return Effect.fail(
              ProjectHostFailed.make({
                root: requested,
                reason: { _tag: "RealPathFailed", cause: error },
              }),
            );
        }
      }),
    );
  });

  const db = yield* Database;
  const storage = yield* StorageRoot;
  const storageRoot = yield* canonical(storage.path);

  const find = (id: string) =>
    Effect.sync(() => db.sqlite.prepare("SELECT * FROM projects WHERE id = ?").get(id)).pipe(
      Effect.flatMap((row) =>
        isTruthy(row) ? Effect.succeed(toProject(row)) : Effect.fail(new ProjectNotFound({ id })),
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
          .run(
            hidden
              ? DateTime.formatIso(DateTime.makeUnsafe(effectClock.currentTimeMillisUnsafe()))
              : null,
            id,
          ),
      ).pipe(
        Effect.flatMap((result) =>
          result.changes === 0 ? Effect.fail(new ProjectNotFound({ id })) : find(id),
        ),
      ),

    get: find,

    /** Registering a root widens what file and shell tools may touch, so it is checked here. */
    add: (requestedRoot: string) =>
      Effect.gen(function* () {
        const absolute = path.resolve(requestedRoot);
        const root = yield* fs.realPath(absolute).pipe(
          Effect.catchTag(
            "PlatformError",
            (error): Effect.Effect<never, ProjectRootRejected | ProjectHostFailed> => {
              switch (error.reason._tag) {
                case "NotFound":
                  return Effect.fail(
                    new ProjectRootRejected({ root: absolute, reason: "not_found" }),
                  );
                default:
                  return Effect.fail(
                    ProjectHostFailed.make({
                      root: absolute,
                      reason: { _tag: "RealPathFailed", cause: error },
                    }),
                  );
              }
            },
          ),
        );
        const info = yield* fs
          .stat(root)
          .pipe(
            Effect.mapError((cause) =>
              ProjectHostFailed.make({ root, reason: { _tag: "StatFailed", cause } }),
            ),
          );
        if (info.type !== "Directory")
          return yield* new ProjectRootRejected({ root, reason: "not_directory" });
        const contains = (parent: string) => (candidate: string) => {
          const relative = path.relative(parent, candidate);
          return (
            relative === "" ||
            (relative !== ".." &&
              !relative.startsWith(".." + path.sep) &&
              !path.isAbsolute(relative))
          );
        };
        if (contains(root)(storageRoot) || contains(storageRoot)(root))
          return yield* new ProjectRootRejected({ root, reason: "overlaps_storage" });

        const project: Project = {
          id: yield* crypto
            .randomUUIDv4()
            .pipe(
              Effect.mapError((cause) =>
                ProjectHostFailed.make({ root, reason: { _tag: "IdentityFailed", cause } }),
              ),
            ),
          root,
          name: path.basename(root) || root,
          crossRecallExcluded: false,
          permissionMode: "ask",
          createdAt: DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
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
        if (!isTruthy(row))
          return yield* new ProjectRootRejected({ root, reason: "already_registered" });
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
  "memory-agent/projects/projects",
) {
  static readonly layerNoDeps = Layer.effect(Projects, make);
  static readonly layer = Projects.layerNoDeps.pipe(
    Layer.provide(Layer.mergeAll(NodeCrypto.layer, NodeFileSystem.layer, NodePath.layer)),
  );
}
