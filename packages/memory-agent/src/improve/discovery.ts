import {
  Context,
  DateTime,
  Effect,
  Array as EffectArray,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  Semaphore,
} from "effect";
import { SqlClient } from "effect/sql";
import { StorageRoot } from "../config/storage-root.ts";
import { Checkouts } from "../imports/checkouts.ts";
import { Projects } from "../projects/projects.ts";
import { sha256 } from "../runtime/synchronous-crypto.ts";
import {
  type ImprovementItem,
  type ImprovementReport,
  ImprovementScan,
  type ReportedItem,
} from "./contracts.ts";
import { ImprovementInterpreter } from "./interpret.ts";
import { grouping, improvementItems } from "./items.ts";
import { improvementReport } from "./report.ts";
import { collectSignals } from "./signals.ts";

export class DiscoveryFailed extends Schema.TaggedError<DiscoveryFailed>()("DiscoveryFailed", {
  /**
   * `storage`: the known worktree folders could not be read. `report`: a report or the index of
   * reports could not be written or read back. `cause` has the SQL, decode or file error.
   */
  reason: Schema.Literals(["storage", "report"]),
  cause: Schema.Defect(),
}) {}

/** A repository that open projects resolve to, and what could be improved in it. */
export interface RepositoryImprovements {
  /** The repository's main checkout. */
  readonly repository: string;
  /** The open projects whose use counts for it: the checkout and its worktrees. */
  readonly projectIds: EffectArray.NonEmptyReadonlyArray<string>;
  readonly items: readonly ImprovementItem[];
}

/** Older signals are likely fixed already or about code that has since changed. */
const lookbackDays = 90;

const ParentRow = Schema.Struct({ project_id: Schema.String, parent: Schema.String });

const make = Effect.gen(function* () {
  const projects = yield* Projects;
  const checkouts = yield* Checkouts;
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const reports = path.join((yield* StorageRoot).path, "improvements");
  const interpreter = yield* ImprovementInterpreter;

  const storage = (cause: unknown) => DiscoveryFailed.make({ reason: "storage", cause });

  /** The nearest folder at or above `folder` that holds `.git`: the repository's top. */
  const repositoryTop = (folder: string): Effect.Effect<Option.Option<string>> =>
    fs.exists(path.join(folder, ".git")).pipe(
      Effect.orElseSucceed(() => false),
      Effect.flatMap((found) =>
        found
          ? Effect.succeed(Option.some(folder))
          : path.dirname(folder) === folder
            ? Effect.succeed(Option.none())
            : repositoryTop(path.dirname(folder)),
      ),
    );

  /**
   * Open projects grouped by the repository they belong to. A worktree project, even one whose
   * folder is gone, and a project opened on a subfolder count for their repository; a project
   * outside any existing repository is left out, since there is nowhere to propose a change.
   */
  const repositories = Effect.gen(function* () {
    const parents = yield* sql`SELECT project_id, parent FROM worktree_parents`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ParentRow))),
      Effect.mapError(storage),
    );
    const parentsOf = EffectArray.groupBy(parents, (row) => row.project_id);
    const placement = yield* checkouts.forRoots(
      (yield* projects.listAll.pipe(Effect.mapError(storage))).map((project) => ({
        root: project.root,
        worktreeParents: (parentsOf[project.id] ?? []).map((row) => row.parent),
      })),
    );
    const placed = yield* Effect.forEach(
      yield* projects.list.pipe(Effect.mapError(storage)),
      (project) =>
        placement.resolve(project.root, null).pipe(
          Effect.flatMap((found) => repositoryTop(found.path)),
          Effect.map(Option.map((repository) => ({ projectId: project.id, repository }))),
        ),
      { concurrency: 4 },
    );
    return Object.entries(
      EffectArray.groupBy(EffectArray.getSomes(placed), (entry) => entry.repository),
    ).map(([repository, entries]) => ({
      repository,
      projectIds: EffectArray.map(entries, (entry) => entry.projectId),
    }));
  });

  /**
   * What could be improved in each repository of the open projects, from the last
   * {@link lookbackDays} days of use. Repositories are read one at a time: grouping embeds text.
   */
  const discover = Effect.fn("ProjectImprovement.discover")(function* () {
    const since = DateTime.formatIso(
      DateTime.subtract(yield* DateTime.now, { days: lookbackDays }),
    );
    return yield* Effect.forEach(
      yield* repositories,
      ({ repository, projectIds }) =>
        collectSignals(projectIds, since).pipe(
          Effect.flatMap((signals) => improvementItems(repository, signals)),
          Effect.map((items): RepositoryImprovements => ({ repository, projectIds, items })),
        ),
      { concurrency: 1 },
    );
  });

  const failed = (cause: unknown) => DiscoveryFailed.make({ reason: "report", cause });
  /** Written beside and renamed over, so a reader or a crash never sees half a file. */
  const writeWhole = (file: string, text: string) =>
    fs
      .writeFileString(`${file}.partial`, text)
      .pipe(Effect.andThen(fs.rename(`${file}.partial`, file)), Effect.mapError(failed));
  const indexFile = path.join(reports, "index.json");
  const IndexJson = Schema.fromJsonString(ImprovementScan);
  // One scan at a time: a second request waits and then scans again from fresh signals.
  const scanning = yield* Semaphore.make(1);

  /** The last recorded scan, or none before the first one. */
  const latest = Effect.gen(function* () {
    if (!(yield* fs.exists(indexFile).pipe(Effect.mapError(failed)))) return Option.none();
    const text = yield* fs.readFileString(indexFile).pipe(Effect.mapError(failed));
    return Option.some(yield* Schema.decodeEffect(IndexJson)(text).pipe(Effect.mapError(failed)));
  });

  /**
   * Discovers and writes one Markdown report per repository under the storage root, never into
   * the repository itself, then an index of them that {@link latest} reads. Every scan replaces the
   * reports of the previous one, removing those of repositories it no longer found.
   */
  const scan = Effect.fn("ProjectImprovement.scan")(function* () {
    const { interpret } = yield* interpreter.model;
    const found = yield* discover();
    // Repositories one at a time, two model calls at once within each: the user's own chats share
    // the provider.
    const interpreted = yield* Effect.forEach(
      found,
      (repository) =>
        Effect.forEach(
          Object.values(EffectArray.groupBy(repository.items, (item) => item.source)).flatMap(
            (items) => items.slice(0, grouping.candidatesPerSource),
          ),
          (item) =>
            interpret(item).pipe(
              Effect.map(
                Option.map((interpretation): ReportedItem => ({ ...item, interpretation })),
              ),
            ),
          { concurrency: 2 },
        ).pipe(
          Effect.map((results) => ({
            repository: repository.repository,
            items: EffectArray.getSomes(results).sort((a, b) => b.count - a.count),
          })),
        ),
      { concurrency: 1 },
    );
    const generatedAt = DateTime.formatIso(yield* DateTime.now);
    yield* fs.makeDirectory(reports, { recursive: true }).pipe(Effect.mapError(failed));
    const written = yield* Effect.forEach(
      interpreted,
      (repository) => {
        const file = path.join(
          reports,
          `${path.basename(repository.repository)}-${sha256(repository.repository).slice(0, 8)}.md`,
        );
        const markdown = improvementReport(repository, generatedAt);
        return writeWhole(file, markdown).pipe(
          Effect.as<ImprovementReport>({
            repository: repository.repository,
            file,
            markdown,
            items: repository.items,
          }),
        );
      },
      { concurrency: 4 },
    );
    const result: ImprovementScan = { generatedAt, reports: written };
    yield* Schema.encodeEffect(IndexJson)(result).pipe(
      Effect.mapError(failed),
      Effect.flatMap((text) => writeWhole(indexFile, text)),
    );
    // After the index: a crash before this leaves extra files, never an index naming missing ones.
    const current = written.map((report) => path.basename(report.file));
    yield* fs.readDirectory(reports).pipe(
      Effect.map((names) =>
        names.filter((name) => name.endsWith(".md") && !current.includes(name)),
      ),
      Effect.flatMap((stale) =>
        Effect.forEach(stale, (name) => fs.remove(path.join(reports, name)), { concurrency: 4 }),
      ),
      Effect.mapError(failed),
    );
    return result;
  }, scanning.withPermits(1));

  return { discover, latest, scan };
});

/** Finds what to improve in the repositories behind the open projects. */
export class ProjectImprovement extends Context.Service<
  ProjectImprovement,
  Effect.Success<typeof make>
>()("memory-agent/improve/discovery/ProjectImprovement") {
  static readonly layerNoDeps = Layer.effect(ProjectImprovement, make);
  static readonly layer = ProjectImprovement.layerNoDeps.pipe(
    Layer.provide(Layer.mergeAll(Checkouts.layer, ImprovementInterpreter.layer)),
  );
}
