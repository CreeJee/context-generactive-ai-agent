// The launcher is exercised against an actual native HTTP server and the host home directory.
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Cause, Effect, FileSystem, Layer, Path, Schema } from "effect";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { homeDirectory } from "memory-agent/host-system";
import { describe, expect } from "vite-plus/test";
import { isThisApp, launchFolder, openProject } from "./launch-project";

const withPlatform = Effect.fn("LaunchProjectTest.platform")(function* <A, E, R>(
  test: Effect.Effect<A, E, R>,
) {
  const context = yield* Layer.build(Layer.merge(NodeFileSystem.layer, NodePath.layer));
  return yield* Effect.provideContext(test, context);
});
const sdkCall = Effect.fn("LaunchProjectTest.sdkCall")(<A>(call: () => Promise<A>) =>
  Effect.tryPromise({ try: call, catch: (cause) => new Cause.UnknownError(cause) }),
);

describe("launch folder", () => {
  it.live(
    "is the folder given, or the folder started from unless that is no real working folder",
    () =>
      withPlatform(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const join = path.join;
          const base = yield* fs.realPath(
            yield* fs.makeTempDirectoryScoped({ prefix: "context-agent-launch-" }),
          );
          const project = join(base, "project");
          const storage = join(base, "storage");
          yield* fs.makeDirectory(join(project, "src"), { recursive: true });
          yield* fs.makeDirectory(join(storage, "runtime"), { recursive: true });
          yield* fs.writeFileString(join(project, "README.md"), "");

          expect(yield* sdkCall(() => launchFolder(undefined, project, storage, null))).toEqual({
            kind: "folder",
            root: project,
          });
          expect(yield* sdkCall(() => launchFolder("src", project, storage, null))).toEqual({
            kind: "folder",
            root: join(project, "src"),
          });
          // A double-click starts in "/", a plain terminal in the home folder: neither is a project.
          expect(yield* sdkCall(() => launchFolder(undefined, "/", storage, null))).toEqual({
            kind: "none",
          });
          const home = yield* homeDirectory;
          expect(yield* sdkCall(() => launchFolder(undefined, home, storage, null))).toEqual({
            kind: "none",
          });
          expect(
            yield* sdkCall(() => launchFolder(undefined, join(storage, "runtime"), storage, null)),
          ).toEqual({
            kind: "none",
          });
          // A Windows double-click starts in the executable's folder; naming that folder still opens it.
          expect(yield* sdkCall(() => launchFolder(undefined, project, storage, project))).toEqual({
            kind: "none",
          });
          expect(yield* sdkCall(() => launchFolder(".", project, storage, project))).toEqual({
            kind: "folder",
            root: project,
          });
          // A folder named on the command line must exist and be a folder.
          expect(yield* sdkCall(() => launchFolder("missing", project, storage, null))).toEqual({
            kind: "invalid",
            path: join(project, "missing"),
          });
          expect(
            (yield* sdkCall(() => launchFolder("README.md", project, storage, null))).kind,
          ).toBe("invalid");
        }),
      ),
  );
});

describe("opening the folder on the app", () => {
  it.live("adds it, or finds it when it is registered already, and reports refusals", () =>
    Effect.gen(function* () {
      const projects = [{ id: "p-1", root: "/work/known" }];
      const serverServices = yield* Layer.build(Layer.fresh(NodeHttpServer.layerTest));
      const server = yield* Effect.provideContext(HttpServer.HttpServer, serverServices);
      yield* Effect.provideContext(
        HttpServer.serveEffect(
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            const json = (
              value:
                | typeof projects
                | { error: string; reason: string }
                | { id: string; root: string },
              status: number,
            ) => HttpServerResponse.json(value, { status });
            const rejected = (reason: string) => json({ error: "project_rejected", reason }, 422);
            if (request.method === "GET") return yield* json(projects, 200);
            const { root } = yield* Schema.decodeEffect(
              Schema.fromJsonString(Schema.Struct({ root: Schema.String })),
            )(yield* request.text);
            if (root === "/work/known") return yield* rejected("already_registered");
            if (root.startsWith("/storage")) return yield* rejected("overlaps_storage");
            return yield* json({ id: "p-2", root }, 201);
          }).pipe(Effect.catch(() => HttpServerResponse.json({}, { status: 400 }))),
        ),
        serverServices,
      );
      const address = server.address;
      if (address._tag === "UnixPathAddress")
        return yield* Effect.die(new Error("HTTP fixture requires TCP"));
      const baseUrl = `http://127.0.0.1:${address.port}`;

      expect(yield* sdkCall(() => isThisApp(baseUrl))).toBe(true);
      expect(yield* sdkCall(() => isThisApp("http://127.0.0.1:1"))).toBe(false);
      expect(yield* sdkCall(() => openProject(baseUrl, "/work/new"))).toEqual({
        kind: "opened",
        projectId: "p-2",
        added: true,
      });
      expect(yield* sdkCall(() => openProject(baseUrl, "/work/known"))).toEqual({
        kind: "opened",
        projectId: "p-1",
        added: false,
      });
      expect(yield* sdkCall(() => openProject(baseUrl, "/storage/inside"))).toEqual({
        kind: "rejected",
        reason: "overlaps_storage",
      });
    }),
  );
});
