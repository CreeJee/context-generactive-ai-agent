import { it } from "@effect/vitest";
import { NodeCrypto, NodeServices } from "@effect/platform-node";
import {
  Context,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schedule,
  type Scope,
} from "effect";
import { expect } from "vite-plus/test";
import { StorageRoot } from "../src/config/storage-root.ts";
import { Database } from "../src/db/database.ts";
import { ItemInterpretation, ScanState } from "../src/improve/contracts.ts";
import { ProjectImprovement } from "../src/improve/discovery.ts";
import { ImprovementInterpreter } from "../src/improve/interpret.ts";
import { Checkouts } from "../src/imports/checkouts.ts";
import { EmbedderRuntime, Embedder } from "../src/memory/embedding/embedder.ts";
import { Projects } from "../src/projects/projects.ts";
import { sqlRun } from "./support/sql.ts";

const embedder = Layer.succeed(Embedder, {
  identity: "fixture",
  dimensions: 1,
  embed: (texts) => Effect.succeed(texts.map(() => Float32Array.from([1]))),
  runtime: () => EmbedderRuntime.other(),
});

const interpreted = ItemInterpretation.cases.interpreted.make({
  title: "t",
  problem: "p",
  rule: "r",
  change: "c",
  acceptance: "a",
});

/**
 * A git repository with one open project and three failures of one cause, scanned by a model that
 * holds every answer until `release` and says when it was first asked.
 */
const fixture = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const base = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
  const repository = path.join(base, "repo");
  const storage = path.join(base, "storage");
  yield* fs.makeDirectory(path.join(repository, ".git"), { recursive: true });
  yield* fs.makeDirectory(storage, { recursive: true });
  const asked = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const interpreter = Layer.succeed(ImprovementInterpreter, {
    model: Effect.succeed({
      interpret: () =>
        Deferred.succeed(asked, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(Option.some(interpreted)),
        ),
    }),
  });
  const services = yield* Layer.build(
    ProjectImprovement.layerNoDeps.pipe(
      Layer.provideMerge(
        Layer.mergeAll(Projects.layerNoDeps, Checkouts.layer, interpreter, embedder),
      ),
      Layer.provideMerge(Database.layer(path.join(storage, "agent.db"))),
      Layer.provideMerge(StorageRoot.layer(storage)),
      Layer.provideMerge(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
    ),
  );
  const project = yield* Context.get(services, Projects).add(repository);
  const seed = Effect.gen(function* () {
    yield* sqlRun(
      "INSERT INTO sessions (id, project_id, title, created_at) VALUES ('s1', ?, NULL, '2026-10-01')",
      project.id,
    );
    for (const id of ["f1", "f2", "f3"])
      yield* sqlRun(
        `INSERT INTO nodes (id, project_id, session_id, kind, text, detail, created_at)
         VALUES (?, ?, 's1', 'tool_result', 'Error: cannot open /a.ts', ?, ?)`,
        id,
        project.id,
        '{"toolName":"Bash","ok":false,"importedFrom":"claude-code"}',
        new Date().toISOString(),
      );
  });
  yield* Effect.provideContext(seed, services);
  return { improvement: Context.get(services, ProjectImprovement), asked, release, storage };
});

const settled = (improvement: ProjectImprovement["Service"]) =>
  improvement.status.pipe(
    Effect.repeat({
      until: ({ state }) => !ScanState.guards.running(state),
      schedule: Schedule.spaced("10 millis"),
    }),
    Effect.timeout("10 seconds"),
  );

const live = <A, E>(
  name: string,
  body: () => Effect.Effect<A, E, Scope.Scope | FileSystem.FileSystem | Path.Path>,
) =>
  it.live(
    name,
    () =>
      Effect.flatMap(Layer.build(NodeServices.layer), (context) =>
        Effect.provideContext(body(), context),
      ).pipe(Effect.scoped),
    30_000,
  );

live("a second start joins the running scan, and a stopped scan records nothing", () =>
  Effect.gen(function* () {
    const { improvement, asked } = yield* fixture();
    expect(ScanState.guards.running(yield* improvement.start)).toBe(true);
    yield* Deferred.await(asked);
    expect(ScanState.guards.running(yield* improvement.start)).toBe(true);
    expect(ScanState.guards.stopped(yield* improvement.stop)).toBe(true);
    const { state, scan } = yield* improvement.status;
    expect(ScanState.guards.stopped(state)).toBe(true);
    expect(scan).toEqual(Option.none());
  }),
);

live("a finished scan is recorded and the state returns to idle", () =>
  Effect.gen(function* () {
    const { improvement, asked, release } = yield* fixture();
    yield* improvement.start;
    yield* Deferred.await(asked);
    yield* Deferred.succeed(release, undefined);
    const { state, scan } = yield* settled(improvement);
    expect(state).toEqual(ScanState.cases.idle.make({}));
    expect(Option.map(scan, ({ reports }) => reports.map((report) => report.items.length))).toEqual(
      Option.some([1]),
    );
  }),
);

live("an index from before tagged interpretations counts as no recorded scan", () =>
  Effect.gen(function* () {
    const { improvement, storage } = yield* fixture();
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reports = path.join(storage, "improvements");
    yield* fs.makeDirectory(reports, { recursive: true });
    // As release 0.0.17 wrote it: the interpretation keyed by `status`.
    yield* fs.writeFileString(
      path.join(reports, "index.json"),
      `{"generatedAt":"2026-10-20T00:00:00.000Z","reports":[{"repository":"/repo",
        "file":"/storage/improvements/repo.md","markdown":"# repo","items":[{"id":"i1",
        "repository":"/repo","source":"tool_failure","title":"t","count":3,"evidence":["f1"],
        "excerpts":["Error"],"latestAt":null,"interpretation":{"status":"interpreted",
        "title":"t","problem":"p","rule":"r","change":"c","acceptance":"a"}}]}]}`,
    );
    expect(yield* improvement.latest).toEqual(Option.none());
  }),
);
