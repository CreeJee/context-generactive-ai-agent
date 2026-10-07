// The launcher is exercised against an actual native HTTP server and the host home directory.
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Cause, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { createServer } from "node:http";
import { homedir } from "node:os";
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

          expect(launchFolder(undefined, project, storage, null)).toEqual({
            kind: "folder",
            root: project,
          });
          expect(launchFolder("src", project, storage, null)).toEqual({
            kind: "folder",
            root: join(project, "src"),
          });
          // A double-click starts in "/", a plain terminal in the home folder: neither is a project.
          expect(launchFolder(undefined, "/", storage, null)).toEqual({ kind: "none" });
          expect(launchFolder(undefined, homedir(), storage, null)).toEqual({ kind: "none" });
          expect(launchFolder(undefined, join(storage, "runtime"), storage, null)).toEqual({
            kind: "none",
          });
          // A Windows double-click starts in the executable's folder; naming that folder still opens it.
          expect(launchFolder(undefined, project, storage, project)).toEqual({ kind: "none" });
          expect(launchFolder(".", project, storage, project)).toEqual({
            kind: "folder",
            root: project,
          });
          // A folder named on the command line must exist and be a folder.
          expect(launchFolder("missing", project, storage, null)).toEqual({
            kind: "invalid",
            path: join(project, "missing"),
          });
          expect(launchFolder("README.md", project, storage, null).kind).toBe("invalid");
        }),
      ),
  );
});

describe("opening the folder on the app", () => {
  it.live("adds it, or finds it when it is registered already, and reports refusals", () =>
    Effect.gen(function* () {
      const runNative = Effect.runPromiseWith(yield* Effect.context<never>());
      const projects = [{ id: "p-1", root: "/work/known" }];
      const server = createServer((request, response) => {
        const reply = (status: number, json: string) =>
          response.writeHead(status, { "content-type": "application/json" }).end(json);
        const rejected = (reason: string) =>
          reply(422, JSON.stringify({ error: "project_rejected", reason }));
        if (request.method === "GET") return reply(200, JSON.stringify(projects));
        let text = "";
        request.on("data", (chunk: Buffer) => (text += chunk.toString()));
        request.on("end", () => {
          void runNative(
            Effect.gen(function* () {
              const { root } = yield* Schema.decodeEffect(
                Schema.fromJsonString(Schema.Struct({ root: Schema.String })),
              )(text);
              if (root === "/work/known") return rejected("already_registered");
              if (root.startsWith("/storage")) return rejected("overlaps_storage");
              reply(
                201,
                yield* Schema.encodeEffect(
                  Schema.fromJsonString(Schema.Struct({ id: Schema.String, root: Schema.String })),
                )({ id: "p-2", root }),
              );
            }).pipe(Effect.catch(() => Effect.sync(() => reply(400, "{}")))),
          );
        });
      });
      yield* Effect.acquireRelease(
        Effect.callback<void, Cause.UnknownError>((resume) => {
          const failed = (cause: Error) => resume(Effect.fail(new Cause.UnknownError(cause)));
          server.once("error", failed);
          server.listen(0, "127.0.0.1", () => resume(Effect.void));
          return Effect.sync(() => server.off("error", failed));
        }),
        () =>
          Effect.callback<void>((resume) => {
            server.close(() => resume(Effect.void));
          }),
      );
      const { port } = yield* Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Int }))(
        server.address(),
      );
      const baseUrl = `http://127.0.0.1:${port}`;

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
