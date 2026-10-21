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
  Cause,
  Exit,
  FiberHandle,
  Ref,
} from "effect";
import { SqlClient } from "effect/sql";
import { StorageRoot } from "../config/storage-root.ts";
import { Checkouts } from "../imports/checkouts.ts";
import { Embedder } from "../memory/embedding/embedder.ts";
import { Projects } from "../projects/projects.ts";
import { sha256 } from "../runtime/synchronous-crypto.ts";
import {
  type ImprovementItem,
  type ImprovementReport,
  ImprovementScan,
  type ReportedItem,
  type ScanFailure,
  ScanState,
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
  const embedder = yield* Embedder;
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
          // Held by the service, so the background scan needs nothing from whoever started it.
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.provideService(Embedder, embedder),
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
  const state = yield* Ref.make<ScanState>(ScanState.cases.idle.make({}));
  // The one background scan; closing the service's Scope interrupts it.
  const running = yield* FiberHandle.make<void, never>();
  const now = Effect.map(DateTime.now, DateTime.formatIso);
  /** Progress counts only while a scan runs; a late update after a stop changes nothing. */
  const advance = (change: (running: typeof ScanState.cases.running.Type) => ScanState) =>
    Ref.update(state, (current) => (ScanState.guards.running(current) ? change(current) : current));

  /**
   * The last recorded scan, or none before the first one. An index in an older shape counts as no
   * scan; the next scan writes it again.
   */
  const latest = Effect.gen(function* () {
    if (!(yield* fs.exists(indexFile).pipe(Effect.mapError(failed)))) return Option.none();
    const text = yield* fs.readFileString(indexFile).pipe(Effect.mapError(failed));
    return yield* Schema.decodeEffect(IndexJson)(text).pipe(
      Effect.asSome,
      Effect.catchTag("SchemaError", () => Effect.succeedNone),
    );
  });

  /**
   * Discovers and writes one Markdown report per repository under the storage root, never into
   * the repository itself, then an index of them that {@link latest} reads. Every scan replaces the
   * reports of the previous one, removing those of repositories it no longer found.
   */
  const scan = Effect.fn("ProjectImprovement.scan")(function* () {
    const { interpret } = yield* interpreter.model;
    const found = yield* discover();
    const candidatesOf = (items: readonly ImprovementItem[]) =>
      Object.values(EffectArray.groupBy(items, (item) => item.source)).flatMap((group) =>
        group.slice(0, grouping.candidatesPerSource),
      );
    yield* advance((current) => ({
      ...current,
      repositories: { done: 0, total: found.length },
      items: {
        done: 0,
        total: found.reduce((sum, repository) => sum + candidatesOf(repository.items).length, 0),
      },
    }));
    // Repositories one at a time, two model calls at once within each: the user's own chats share
    // the provider.
    const interpreted = yield* Effect.forEach(
      found,
      (repository) =>
        Effect.forEach(
          candidatesOf(repository.items),
          (item) =>
            interpret(item).pipe(
              Effect.map(
                Option.map((interpretation): ReportedItem => ({ ...item, interpretation })),
              ),
              Effect.tap(() =>
                advance((current) => ({
                  ...current,
                  items: { ...current.items, done: current.items.done + 1 },
                })),
              ),
            ),
          { concurrency: 2 },
        ).pipe(
          Effect.map((results) => ({
            repository: repository.repository,
            items: EffectArray.getSomes(results).sort((a, b) => b.count - a.count),
          })),
          Effect.tap(() =>
            advance((current) => ({
              ...current,
              repositories: { ...current.repositories, done: current.repositories.done + 1 },
            })),
          ),
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
  });

  /** The scan in the background, leaving how it ended in {@link state}. */
  const background = scan().pipe(
    Effect.asVoid,
    Effect.catchTags({
      DiscoveryFailed: (failure) => Effect.fail<ScanFailure>(failure.reason),
      SignalsFailed: () => Effect.fail<ScanFailure>("storage"),
      EmbeddingError: () => Effect.fail<ScanFailure>("embedding"),
      InterpretationUnavailable: (failure) => Effect.fail<ScanFailure>(failure.reason),
    }),
    Effect.onExit((exit) =>
      Effect.flatMap(now, (at) =>
        Ref.set(
          state,
          Exit.match(exit, {
            onSuccess: (): ScanState => ScanState.cases.idle.make({}),
            onFailure: (cause): ScanState =>
              Cause.hasInterruptsOnly(cause)
                ? ScanState.cases.stopped.make({ at })
                : ScanState.cases.failed.make({
                    at,
                    reason: Option.getOrElse(
                      Cause.findErrorOption(cause),
                      () => "internal" as const,
                    ),
                  }),
          }),
        ),
      ),
    ),
    Effect.tapCause((cause) =>
      Cause.hasDies(cause)
        ? Effect.logError("Project improvement scan failed", cause)
        : Effect.void,
    ),
    Effect.ignore,
  );

  /** Starts a scan unless one is running, and answers where it stands. */
  const start = Effect.gen(function* () {
    const startedAt = yield* now;
    const claimed = yield* Ref.modify(state, (current): [boolean, ScanState] =>
      ScanState.guards.running(current)
        ? [false, current]
        : [
            true,
            ScanState.cases.running.make({
              startedAt,
              repositories: { done: 0, total: 0 },
              items: { done: 0, total: 0 },
            }),
          ],
    );
    // Only the claim decides: a scan that just recorded its end may still sit in the handle, and
    // replacing it there loses nothing.
    if (claimed) yield* FiberHandle.run(running, background);
    return yield* Ref.get(state);
  });

  /** Interrupts a running scan; its partial results are not recorded. */
  const stop = FiberHandle.clear(running).pipe(Effect.andThen(Ref.get(state)));

  const status = Effect.all({ state: Ref.get(state), scan: latest });

  return { discover, latest, scan, start, stop, status };
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
