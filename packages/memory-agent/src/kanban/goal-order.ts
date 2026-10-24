import { Clock, Context, Effect, Function as EffectFunction, Layer, Schema } from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import { GoalScheduleStorageFailed, GoalScheduleStorageReason } from "./goal-schedules.ts";

/**
 * The priority tree of the project scheduler (docs/kanban-orchestration.md "프로젝트 스케줄러"):
 * projects in one order, and inside a project its Goals (conversations with a Plan) in one order.
 * Cards keep their Plan's order below that. A person moves a project or a Goal while boards run; a
 * project or Goal nobody placed comes after the placed ones, oldest first.
 */

/**
 * `order` with `item` put in front of `before`, or last when `before` is null. An item or a
 * `before` that is not in the order leaves it as it is.
 */
export const moved: {
  (item: string, before: string | null): (order: readonly string[]) => readonly string[];
} & typeof movedBody = EffectFunction.dual(3, movedBody);
function movedBody(
  order: readonly string[],
  item: string,
  before: string | null,
): readonly string[] {
  if (!order.includes(item) || item === before) return order;
  const rest = order.filter((other) => other !== item);
  const at = before === null ? rest.length : rest.indexOf(before);
  if (at < 0) return order;
  return [...rest.slice(0, at), item, ...rest.slice(at)];
}

const SessionRow = Schema.Struct({ session_id: Schema.String });
const ProjectRow = Schema.Struct({ id: Schema.String });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = Clock.currentTimeMillis;
  const failed = (cause: SqlError.SqlError | Schema.SchemaError) =>
    GoalScheduleStorageFailed.make({
      reason: GoalScheduleStorageReason.cases.Storage.make({}),
      cause,
    });
  const rows =
    <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
    <E, R>(query: Effect.Effect<ReadonlyArray<unknown>, E, R>) =>
      Effect.flatMap(query, Schema.decodeUnknownEffect(Schema.Array(schema)));

  /** The project's conversations that have workflow state, placed ones first. */
  const goals = (projectId: string) =>
    sql`SELECT s.id AS session_id FROM sessions s
        JOIN session_workflows w ON w.session_id = s.id
        LEFT JOIN kanban_goal_ranks r ON r.project_id = s.project_id AND r.session_id = s.id
        WHERE s.project_id = ${projectId} AND s.archived_at IS NULL
        ORDER BY r.rank IS NULL, r.rank, s.created_at, s.id`.pipe(
      rows(SessionRow),
      Effect.map((found): readonly string[] => found.map((row) => row.session_id)),
      Effect.mapError(failed),
    );

  /** Every project, placed ones first. Hidden projects keep their place: their boards may run. */
  const projects = sql`SELECT p.id FROM projects p
      LEFT JOIN kanban_project_ranks r ON r.project_id = p.id
      ORDER BY r.rank IS NULL, r.rank, p.created_at, p.id`.pipe(
    rows(ProjectRow),
    Effect.map((found): readonly string[] => found.map((row) => row.id)),
    Effect.mapError(failed),
  );

  return {
    goals,
    projects,

    /**
     * Puts the conversation's Goal in front of `before` (or last) among the project's Goals and
     * stores every Goal's place, so the order holds while Goals come and go.
     */
    moveGoal: Effect.fn("GoalOrder.moveGoal")(function* (
      projectId: string,
      sessionId: string,
      before: string | null,
    ) {
      const current = yield* goals(projectId);
      const next = moved(current, sessionId, before);
      if (next === current) return current;
      const at = yield* now;
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM kanban_goal_ranks WHERE project_id = ${projectId}`;
            yield* Effect.forEach(
              next,
              (session, rank) => sql`INSERT INTO kanban_goal_ranks
                (project_id, session_id, rank, updated_at)
                VALUES (${projectId}, ${session}, ${rank}, ${at})`,
              { discard: true },
            );
          }),
        )
        .pipe(Effect.mapError(failed));
      return next;
    }),

    /** Puts the project in front of `before` (or last) among the projects. */
    moveProject: Effect.fn("GoalOrder.moveProject")(function* (
      projectId: string,
      before: string | null,
    ) {
      const current = yield* projects;
      const next = moved(current, projectId, before);
      if (next === current) return current;
      const at = yield* now;
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM kanban_project_ranks`;
            yield* Effect.forEach(
              next,
              (project, rank) => sql`INSERT INTO kanban_project_ranks
                (project_id, rank, updated_at) VALUES (${project}, ${rank}, ${at})`,
              { discard: true },
            );
          }),
        )
        .pipe(Effect.mapError(failed));
      return next;
    }),
  };
});

/** The order of projects and of each project's Goals. Owner process only. */
export class GoalOrder extends Context.Service<GoalOrder, Effect.Success<typeof make>>()(
  "memory-agent/kanban/goal-order/GoalOrder",
) {
  static readonly layer = Layer.effect(GoalOrder, make);
}
