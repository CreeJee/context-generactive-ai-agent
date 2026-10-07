import { expect, it } from "@effect/vitest";
import { NodeCrypto, NodeFileSystem, NodePath } from "@effect/platform-node";
import { Context, Effect, FileSystem, Layer, Path, PlatformError } from "effect";
import { StorageRoot } from "../src/config/storage-root.ts";
import { Database } from "../src/db/database.ts";
import { Projects } from "../src/projects/projects.ts";

const hostLayer = Layer.mergeAll(NodeCrypto.layer, NodeFileSystem.layer, NodePath.layer);
const workspace = Effect.fnUntraced(function* () {
  const host = yield* Layer.build(hostLayer);
  const fs = Context.get(host, FileSystem.FileSystem);
  const path = Context.get(host, Path.Path);
  const base = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
  const storage = path.join(base, "storage");
  const app = path.join(base, "code", "app");
  yield* fs.makeDirectory(app, { recursive: true });
  const open = Effect.fnUntraced(function* (filesystem: FileSystem.FileSystem) {
    const services = yield* Layer.build(
      Projects.layerNoDeps.pipe(
        Layer.provide(Database.layer(path.join(storage, "agent.db"))),
        Layer.provide(StorageRoot.layer(storage)),
        Layer.provide(
          Layer.mergeAll(
            NodeCrypto.layer,
            NodePath.layer,
            Layer.succeed(FileSystem.FileSystem, filesystem),
          ),
        ),
      ),
    );
    return Context.get(services, Projects);
  });
  return { base, storage, app, fs, path, open };
});

it.live("registers a canonical root once and lists it after reopening", () =>
  Effect.gen(function* () {
    const fixture = yield* workspace();
    const { base, app, fs, path } = fixture;
    const link = path.join(base, "app-link");
    yield* fs.symlink(app, link);
    const added = yield* Effect.scoped(
      Effect.gen(function* () {
        const projects = yield* fixture.open(fs);
        const project = yield* projects.add(link);
        const again = yield* Effect.result(projects.add(app));
        return { project, again };
      }),
    );
    expect(added.project).toMatchObject({ root: app, name: "app", crossRecallExcluded: false });
    expect(added.again).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ProjectRootRejected", reason: "already_registered" },
    });
    const reopened = yield* fixture.open(fs);
    expect(yield* reopened.list).toEqual([added.project]);
  }),
);

it.live("rejects missing, file and storage-overlapping roots", () =>
  Effect.gen(function* () {
    const fixture = yield* workspace();
    const { base, storage, fs, path } = fixture;
    const file = path.join(base, "notes.txt");
    yield* fs.writeFileString(file, "x");
    const projects = yield* fixture.open(fs);
    for (const input of [
      { root: path.join(base, "missing"), reason: "not_found" },
      { root: file, reason: "not_directory" },
      { root: storage, reason: "overlaps_storage" },
      { root: base, reason: "overlaps_storage" },
    ]) {
      expect(yield* Effect.result(projects.add(input.root))).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ProjectRootRejected", reason: input.reason },
      });
    }
  }),
);

it.live("toggles cross-project recall exclusion and reports unknown ids", () =>
  Effect.gen(function* () {
    const fixture = yield* workspace();
    const projects = yield* fixture.open(fixture.fs);
    const project = yield* projects.add(fixture.app);
    expect((yield* projects.setCrossRecallExcluded(project.id, true)).crossRecallExcluded).toBe(
      true,
    );
    expect(yield* Effect.result(projects.setCrossRecallExcluded("nope", true))).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ProjectNotFound", id: "nope" },
    });
  }),
);

it.live("starts in ask mode and switches the permission mode", () =>
  Effect.gen(function* () {
    const fixture = yield* workspace();
    const projects = yield* fixture.open(fixture.fs);
    const project = yield* projects.add(fixture.app);
    expect(project.permissionMode).toBe("ask");
    for (const mode of ["auto", "full", "ask"] as const) {
      expect((yield* projects.setPermissionMode(project.id, mode)).permissionMode).toBe(mode);
    }
    expect(yield* Effect.result(projects.setPermissionMode("nope", "auto"))).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ProjectNotFound" },
    });
  }),
);

it.live("permission and stat failures stay typed and cannot register a project", () =>
  Effect.gen(function* () {
    const fixture = yield* workspace();
    const denied = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "realPath",
    });
    const projects = yield* fixture.open(
      FileSystem.makeNoop({
        ...fixture.fs,
        realPath: (requested) =>
          requested === fixture.app ? Effect.fail(denied) : fixture.fs.realPath(requested),
      }),
    );
    expect(yield* Effect.result(projects.add(fixture.app))).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ProjectHostFailed", reason: { _tag: "RealPathFailed", cause: denied } },
    });
    const raced = yield* fixture.open(
      FileSystem.makeNoop({
        ...fixture.fs,
        stat: () => Effect.fail(denied),
      }),
    );
    expect(yield* Effect.result(raced.add(fixture.app))).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ProjectHostFailed", reason: { _tag: "StatFailed", cause: denied } },
    });
    expect(yield* projects.list).toEqual([]);
  }),
);
