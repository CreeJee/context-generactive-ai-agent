import {
  DateTime,
  Clock,
  Context,
  Crypto,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
} from "effect";
import { SqlClient, SqlError, SqlSchema } from "effect/sql";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { StorageRoot } from "../config/storage-root.ts";

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
function toProject(decoded: typeof ProjectRow.Type): Project {
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

export class ProjectRootRejected extends Schema.TaggedError<ProjectRootRejected>()(
  "ProjectRootRejected",
  {
    root: Schema.String,
    reason: Schema.Literals([
      "not_found",
      "not_directory",
      "overlaps_storage",
      "already_registered",
    ]),
  },
) {}

export class ProjectNotFound extends Schema.TaggedError<ProjectNotFound>()("ProjectNotFound", {
  id: Schema.String,
}) {}

export const ProjectHostReason = Schema.TaggedUnion({
  RealPathFailed: { cause: Schema.Defect() },
  StatFailed: { cause: Schema.Defect() },
  IdentityFailed: { cause: Schema.Defect() },
});
const hostFailure = ProjectHostReason.cases;

export class ProjectHostFailed extends Schema.TaggedError<ProjectHostFailed>()(
  "ProjectHostFailed",
  { root: Schema.String, reason: ProjectHostReason },
) {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const canonical = Effect.fnUntraced(function* (
    requested: string,
  ): Effect.fn.Return<string, ProjectHostFailed> {
    return yield* fs.realPath(requested).pipe(
      Effect.catchReason(
        "PlatformError",
        "NotFound",
        () => {
          const parent = path.dirname(requested);
          return parent === requested
            ? Effect.succeed(requested)
            : canonical(parent).pipe(
                Effect.map((resolved) => path.join(resolved, path.basename(requested))),
              );
        },
        (_, error) =>
          Effect.fail(
            ProjectHostFailed.make({
              root: requested,
              reason: hostFailure.RealPathFailed.make({ cause: error }),
            }),
          ),
      ),
    );
  });

  const sql = yield* SqlClient.SqlClient;
  const storage = yield* StorageRoot;
  const storageRoot = yield* canonical(storage.path);

  /** One project, or ProjectNotFound: what every lookup and change by id answers. */
  const one =
    <I>(
      query: (
        request: I,
      ) => Effect.Effect<
        Option.Option<typeof ProjectRow.Type>,
        SqlError.SqlError | Schema.SchemaError
      >,
    ) =>
    (id: string, request: I) =>
      query(request).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(ProjectNotFound.make({ id })),
            onSome: (row) => Effect.succeed(toProject(row)),
          }),
        ),
      );
  const byId = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: ProjectRow,
    execute: (id) => sql`SELECT * FROM projects WHERE id = ${id}`,
  });
  const find = (id: string) => one(byId)(id, id);
  const all = SqlSchema.findAll({
    Request: Schema.Boolean,
    Result: ProjectRow,
    execute: (includeHidden) => sql`
      SELECT * FROM projects
      WHERE ${includeHidden ? sql.literal("1") : sql.literal("hidden_at IS NULL")}
      ORDER BY created_at, id`,
  });
  const hide = one(
    SqlSchema.findOneOption({
      Request: Schema.Struct({ id: Schema.String, hiddenAt: Schema.NullOr(Schema.String) }),
      Result: ProjectRow,
      execute: ({ id, hiddenAt }) =>
        sql`UPDATE projects SET hidden_at = ${hiddenAt} WHERE id = ${id} RETURNING *`,
    }),
  );
  const exclude = one(
    SqlSchema.findOneOption({
      Request: Schema.Struct({ id: Schema.String, excluded: Schema.Literals([0, 1]) }),
      Result: ProjectRow,
      execute: ({ id, excluded }) =>
        sql`UPDATE projects SET cross_recall_excluded = ${excluded} WHERE id = ${id} RETURNING *`,
    }),
  );
  const permit = one(
    SqlSchema.findOneOption({
      Request: Schema.Struct({
        id: Schema.String,
        mode: Schema.Literals(["ask", "auto"]),
        full: Schema.Literals([0, 1]),
      }),
      Result: ProjectRow,
      execute: ({ id, mode, full }) => sql`
        UPDATE projects SET permission_mode = ${mode}, permission_full = ${full}
        WHERE id = ${id} RETURNING *`,
    }),
  );
  // Adding a folder that is registered but hidden puts it back in the list: asking for it
  // again is the same intent as un-hiding it, and there is no other way back.
  const insert = SqlSchema.findOneOption({
    Request: Schema.Struct({
      id: Schema.String,
      root: Schema.String,
      name: Schema.String,
      createdAt: Schema.String,
    }),
    Result: ProjectRow,
    execute: (project) => sql`
      INSERT INTO projects (id, root, name, created_at)
      VALUES (${project.id}, ${project.root}, ${project.name}, ${project.createdAt})
      ON CONFLICT(root) DO UPDATE SET hidden_at = NULL WHERE projects.hidden_at IS NOT NULL
      RETURNING *`,
  });

  return {
    /** The projects offered for choosing. Hidden ones still own their memory and are still searched. */
    list: Effect.map(all(false), (rows) => rows.map(toProject)),

    /** Every project, hidden ones included: what the importer matches a recorded folder against. */
    listAll: Effect.map(all(true), (rows) => rows.map(toProject)),

    /** Taken out of the sidebar, or put back. Nothing about its memory changes either way. */
    setHidden: (id: string, hidden: boolean) =>
      Effect.flatMap(Clock.currentTimeMillis, (millis) =>
        hide(id, { id, hiddenAt: hidden ? DateTime.formatIso(DateTime.makeUnsafe(millis)) : null }),
      ),

    get: find,

    /** Registering a root widens what file and shell tools may touch, so it is checked here. */
    add: (requestedRoot: string) =>
      Effect.gen(function* () {
        const absolute = path.resolve(requestedRoot);
        const root = yield* fs.realPath(absolute).pipe(
          Effect.catchReason(
            "PlatformError",
            "NotFound",
            () => Effect.fail(ProjectRootRejected.make({ root: absolute, reason: "not_found" })),
            (_, error) =>
              Effect.fail(
                ProjectHostFailed.make({
                  root: absolute,
                  reason: hostFailure.RealPathFailed.make({ cause: error }),
                }),
              ),
          ),
        );
        const info = yield* fs
          .stat(root)
          .pipe(
            Effect.mapError((cause) =>
              ProjectHostFailed.make({ root, reason: hostFailure.StatFailed.make({ cause }) }),
            ),
          );
        if (info.type !== "Directory")
          return yield* ProjectRootRejected.make({ root, reason: "not_directory" });
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
          return yield* ProjectRootRejected.make({ root, reason: "overlaps_storage" });

        const project: Project = {
          id: yield* crypto.randomUUIDv4().pipe(
            Effect.mapError((cause) =>
              ProjectHostFailed.make({
                root,
                reason: hostFailure.IdentityFailed.make({ cause }),
              }),
            ),
          ),
          root,
          name: path.basename(root) || root,
          crossRecallExcluded: false,
          permissionMode: "ask",
          createdAt: DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
          hiddenAt: null,
        };
        const row = yield* insert(project);
        if (Option.isNone(row))
          return yield* ProjectRootRejected.make({ root, reason: "already_registered" });
        return toProject(row.value);
      }),

    /** R08: excluded projects keep their memory but are not searched from other projects. */
    setCrossRecallExcluded: (id: string, excluded: boolean) =>
      exclude(id, { id, excluded: excluded ? 1 : 0 }),

    /** Choosing `auto` or `full` records the user's standing permission policy. */
    setPermissionMode: (id: string, mode: PermissionMode) =>
      permit(id, { id, mode: mode === "full" ? "auto" : mode, full: mode === "full" ? 1 : 0 }),
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
