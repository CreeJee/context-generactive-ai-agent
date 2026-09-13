import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Either, Layer } from "effect";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { StorageRoot } from "../src/config/storage-root.ts";
import { Database } from "../src/db/database.ts";
import { Projects } from "../src/projects/projects.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function workspace() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "memory-agent-projects-")));
  directories.push(base);
  const storage = join(base, "storage");
  const app = join(base, "code", "app");
  mkdirSync(app, { recursive: true });
  return { base, storage, app };
}

const run = <A, E>(storage: string, program: Effect.Effect<A, E, Projects>) =>
  Effect.runPromise(
    program.pipe(
      Effect.provide(
        Projects.layer.pipe(
          Layer.provide(Database.layer(join(storage, "agent.db"))),
          Layer.provide(StorageRoot.layer(storage)),
        ),
      ),
    ),
  );

const rejection = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.either,
    Effect.map((result) => (Either.isLeft(result) ? result.left : null)),
  );

describe("Projects", () => {
  test("registers a canonical root once and lists it after reopening", async () => {
    const { storage, app, base } = workspace();
    const link = join(base, "app-link");
    symlinkSync(app, link);

    const added = await run(
      storage,
      Effect.gen(function* () {
        const projects = yield* Projects;
        const project = yield* projects.add(link);
        const again = yield* rejection(projects.add(app));
        return { project, again };
      }),
    );
    expect(added.project).toMatchObject({ root: app, name: "app", crossRecallExcluded: false });
    expect(added.again).toMatchObject({
      _tag: "ProjectRootRejected",
      reason: "already_registered",
    });

    const listed = await run(
      storage,
      Effect.flatMap(Projects, (projects) => projects.list),
    );
    expect(listed).toEqual([added.project]);
  });

  test("rejects roots that are missing, files, or overlap the storage root", async () => {
    const { storage, base } = workspace();
    const file = join(base, "notes.txt");
    writeFileSync(file, "x");
    mkdirSync(storage, { recursive: true });

    const reasons = await run(
      storage,
      Effect.gen(function* () {
        const projects = yield* Projects;
        return [
          yield* rejection(projects.add(join(base, "missing"))),
          yield* rejection(projects.add(file)),
          yield* rejection(projects.add(storage)),
          yield* rejection(projects.add(base)),
        ].map((error) => error && "reason" in error && error.reason);
      }),
    );
    expect(reasons).toEqual(["not_found", "not_directory", "overlaps_storage", "overlaps_storage"]);
  });

  test("toggles cross-project recall exclusion and reports unknown ids", async () => {
    const { storage, app } = workspace();
    const result = await run(
      storage,
      Effect.gen(function* () {
        const projects = yield* Projects;
        const project = yield* projects.add(app);
        const excluded = yield* projects.setCrossRecallExcluded(project.id, true);
        const missing = yield* rejection(projects.setCrossRecallExcluded("nope", true));
        return { excluded, missing };
      }),
    );
    expect(result.excluded.crossRecallExcluded).toBe(true);
    expect(result.missing).toMatchObject({ _tag: "ProjectNotFound", id: "nope" });
  });
});
