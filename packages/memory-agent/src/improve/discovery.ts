import {
  Context,
  DateTime,
  Effect,
  Array as EffectArray,
  FileSystem,
  Layer,
  Path,
  Schema,
} from "effect";
import { SqlClient } from "effect/sql";
import { Checkouts } from "../imports/checkouts.ts";
import { Projects } from "../projects/projects.ts";
import { improvementItems, type ImprovementItem } from "./items.ts";
import { collectSignals } from "./signals.ts";

export class DiscoveryFailed extends Schema.TaggedError<DiscoveryFailed>()("DiscoveryFailed", {
  /** The known worktree folders could not be read; `cause` has the SQL or decode error. */
  reason: Schema.Literals(["storage"]),
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

  /**
   * Open projects grouped by the repository they belong to. A worktree project, even one whose
   * folder is gone, counts for its repository; a project outside any existing repository is left
   * out, since there is nowhere to propose a change.
   */
  const repositories = Effect.gen(function* () {
    const parents = yield* sql`SELECT project_id, parent FROM worktree_parents`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ParentRow))),
      Effect.mapError((cause) => DiscoveryFailed.make({ reason: "storage", cause })),
    );
    const parentsOf = EffectArray.groupBy(parents, (row) => row.project_id);
    const placement = yield* checkouts.forRoots(
      (yield* projects.listAll).map((project) => ({
        root: project.root,
        worktreeParents: (parentsOf[project.id] ?? []).map((row) => row.parent),
      })),
    );
    const placed = yield* Effect.forEach(
      yield* projects.list,
      (project) =>
        Effect.map(placement.resolve(project.root, null), (found) => ({
          projectId: project.id,
          repository: found.path,
        })),
      { concurrency: 4 },
    );
    const grouped = Object.entries(EffectArray.groupBy(placed, (entry) => entry.repository));
    return yield* Effect.filter(
      grouped,
      ([repository]) =>
        fs.exists(path.join(repository, ".git")).pipe(Effect.orElseSucceed(() => false)),
      { concurrency: 4 },
    ).pipe(
      Effect.map((found) =>
        found.map(([repository, entries]) => ({
          repository,
          projectIds: EffectArray.map(entries, (entry) => entry.projectId),
        })),
      ),
    );
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

  return { discover };
});

/** Finds what to improve in the repositories behind the open projects. */
export class ProjectImprovement extends Context.Service<
  ProjectImprovement,
  Effect.Success<typeof make>
>()("memory-agent/improve/discovery/ProjectImprovement") {
  static readonly layer = Layer.effect(ProjectImprovement, make).pipe(
    Layer.provide(Checkouts.layer),
  );
}
