import { Effect, FileSystem, Option, Schema } from "effect";
import { expect } from "vite-plus/test";
import { CliFailure, resolveProjectId } from "../../src/cli/project-reference.ts";
import { Projects } from "../../src/projects/projects.ts";
import { path } from "../../src/runtime/synchronous-path.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";

/**
 * A caller of the CLI knows a working directory, not a project id. What types cannot show is
 * which project each way of naming one resolves to against a real storage, so that is what this
 * checks: the id, the path, a directory inside the project, and the refusal.
 */
testAgent()("the CLI's project reference", (it) => {
  const none = Option.none<string>();

  /** The refusal itself, so a test can read its code and detail. */
  const refusalOf = <E, R>(resolving: Effect.Effect<string, E, R>) =>
    Effect.map(Effect.flip(resolving), (error) => {
      expect(Schema.is(CliFailure)(error)).toBe(true);
      // SAFETY: the assertion above already failed the test when this is another failure.
      return error as CliFailure;
    });

  it.effect("takes an exact project id", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const resolved = yield* resolveProjectId({
        projectId: Option.some(env.project.id),
        project: none,
        cwd: env.project.root,
      });
      expect(resolved).toBe(env.project.id);
    }),
  );

  it.effect("takes a root path or a name for --project", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const byPath = yield* resolveProjectId({
        projectId: none,
        project: Option.some(env.project.root),
        cwd: "/",
      });
      const byName = yield* resolveProjectId({
        projectId: none,
        project: Option.some(env.project.name),
        cwd: "/",
      });
      expect(byPath).toBe(env.project.id);
      expect(byName).toBe(env.project.id);
    }),
  );

  it.effect("finds the project a working directory sits in, from a subdirectory", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const inside = path.join(env.project.root, "src", "deep");
      const resolved = yield* resolveProjectId({ projectId: none, project: none, cwd: inside });
      expect(resolved).toBe(env.project.id);
    }),
  );

  it.effect("prefers the deepest registered project when they nest", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const projects = yield* Projects;
      const nested = path.join(env.project.root, "inner");
      yield* (yield* FileSystem.FileSystem).makeDirectory(nested, { recursive: true });
      const inner = yield* projects.add(nested);
      const resolved = yield* resolveProjectId({
        projectId: none,
        project: none,
        cwd: path.join(inner.root, "below"),
      });
      expect(resolved).toBe(inner.id);
    }),
  );

  it.effect("refuses when nothing names a project", () =>
    Effect.gen(function* () {
      const outside = yield* refusalOf(
        resolveProjectId({ projectId: none, project: none, cwd: "/" }),
      );
      const unknownId = yield* refusalOf(
        resolveProjectId({ projectId: Option.some("no-such-id"), project: none, cwd: "/" }),
      );
      expect(outside.code).toBe("project_not_found");
      expect(outside.detail["cwd"]).toBe("/");
      expect(outside.detail["hint"]).toContain("projects");
      expect(unknownId.code).toBe("project_not_found");
      expect(unknownId.detail["projectId"]).toBe("no-such-id");
    }),
  );
});
