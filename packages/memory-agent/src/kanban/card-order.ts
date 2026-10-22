import { Clock, Context, Effect, Layer, Schema } from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import { decodeWorkflowState } from "../workflow/workflow.ts";
import { GoalPriority } from "./goal-schedules.ts";

/**
 * The one order of a project's cards across its boards (docs/kanban-orchestration.md "프로젝트
 * 스케줄러"): the sequence the scheduler starts cards in, which a person arranges by dragging cards
 * on the project board, between conversations too. Each Plan keeps its own order inside it; the
 * ranks stored here decide how the Plans interleave.
 */

/** A card named by its conversation and id. */
export interface OrderedCard {
  readonly sessionId: string;
  readonly cardId: string;
}

/** One Plan's cards in Plan order, each with the rank a person gave it, or none. */
export interface OrderedPlan {
  readonly sessionId: string;
  readonly priority: GoalPriority;
  readonly cards: ReadonlyArray<{ readonly cardId: string; readonly rank: number | null }>;
}

const sameCard = (a: OrderedCard, b: OrderedCard) =>
  a.sessionId === b.sessionId && a.cardId === b.cardId;

/** Where a Plan's never-ranked cards enter: higher priority first, then the older conversation. */
const priorityOrder = { high: 0, normal: 1, low: 2 } as const satisfies Record<
  GoalPriority,
  number
>;

/**
 * Merges the Plans into one order. At each step the Plan whose next card has the lowest rank
 * goes. A card without a rank takes the rank of the card before it in its Plan, so a new card
 * follows its predecessor; a Plan whose first card has none comes after every ranked card, by
 * priority and then by age.
 */
export const mergeByRank = (plans: readonly OrderedPlan[]): readonly OrderedCard[] => {
  const lists = plans
    .map((plan, age) => ({ plan, age, next: 0, inherited: Number.POSITIVE_INFINITY }))
    .sort(
      (a, b) => priorityOrder[a.plan.priority] - priorityOrder[b.plan.priority] || a.age - b.age,
    );
  const keyOf = (list: (typeof lists)[number]) =>
    list.plan.cards[list.next]?.rank ?? list.inherited;
  const total = plans.reduce((sum, plan) => sum + plan.cards.length, 0);
  const order: OrderedCard[] = [];
  for (let taken = 0; taken < total; taken++) {
    let best: (typeof lists)[number] | undefined;
    for (const list of lists) {
      if (list.next >= list.plan.cards.length) continue;
      if (best === undefined || keyOf(list) < keyOf(best)) best = list;
    }
    const card = best?.plan.cards[best.next];
    if (best === undefined || card === undefined) break;
    order.push({ sessionId: best.plan.sessionId, cardId: card.cardId });
    best.inherited = card.rank ?? best.inherited;
    best.next += 1;
  }
  return order;
};

/** The cards of one conversation in `order`: its Plan's own order. */
export const projection = (order: readonly OrderedCard[], sessionId: string) =>
  order.filter((card) => card.sessionId === sessionId).map((card) => card.cardId);

/**
 * `order` with `card` moved to the place of `before` (after it when the card came from earlier,
 * as dropping a card onto another does), or to the end when `before` is null.
 */
export const placed = (
  order: readonly OrderedCard[],
  card: OrderedCard,
  before: OrderedCard | null,
): readonly OrderedCard[] => {
  const from = order.findIndex((other) => sameCard(other, card));
  const moved = order[from];
  if (moved === undefined) return order;
  const to =
    before === null ? order.length - 1 : order.findIndex((other) => sameCard(other, before));
  if (to < 0) return order;
  const next = order.filter((_, index) => index !== from);
  next.splice(Math.min(to, next.length), 0, moved);
  return next;
};

export class CardOrderStorageFailed extends Schema.TaggedError<CardOrderStorageFailed>()(
  "CardOrderStorageFailed",
  { cause: Schema.Defect() },
) {}

const PlanRow = Schema.Struct({
  session_id: Schema.String,
  state_json: Schema.String,
  priority: Schema.NullOr(GoalPriority),
});
const RankRow = Schema.Struct({
  session_id: Schema.String,
  card_id: Schema.String,
  rank: Schema.Int,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = Clock.currentTimeMillis;
  const failed = (cause: SqlError.SqlError | Schema.SchemaError) =>
    CardOrderStorageFailed.make({ cause });
  const rows =
    <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
    <E, R>(query: Effect.Effect<ReadonlyArray<unknown>, E, R>) =>
      Effect.flatMap(query, Schema.decodeUnknownEffect(Schema.Array(schema)));
  // Session ids are UUIDs and card ids may hold any character, so the separator cannot occur first.
  const keyOf = (card: OrderedCard) => `${card.sessionId}:${card.cardId}`;

  /** The project's Plans, oldest conversation first, with the ranks their cards were given. */
  const plans = Effect.fnUntraced(function* (projectId: string) {
    const found = yield* sql`SELECT w.session_id, w.state_json,
        (SELECT gs.priority FROM kanban_goals k
          JOIN kanban_goal_schedules gs ON gs.goal_instance_id = k.goal_instance_id
          WHERE k.session_id = w.session_id AND k.status = 'active'
          ORDER BY k.created_at DESC LIMIT 1) AS priority
      FROM session_workflows w JOIN sessions s ON s.id = w.session_id
      WHERE s.project_id = ${projectId} AND s.archived_at IS NULL
      ORDER BY s.created_at, s.id`.pipe(rows(PlanRow));
    const ranks = yield* sql`SELECT session_id, card_id, rank FROM kanban_card_ranks
      WHERE project_id = ${projectId}`.pipe(rows(RankRow));
    const rankOf = new Map(
      ranks.map((row) => [keyOf({ sessionId: row.session_id, cardId: row.card_id }), row.rank]),
    );
    const decoded = yield* Effect.forEach(found, (row) =>
      Effect.map(decodeWorkflowState(row.state_json), ({ plan }): readonly OrderedPlan[] =>
        plan === null
          ? []
          : [
              {
                sessionId: row.session_id,
                priority: row.priority ?? "normal",
                cards: plan.steps.map((step) => ({
                  cardId: step.id,
                  rank: rankOf.get(keyOf({ sessionId: row.session_id, cardId: step.id })) ?? null,
                })),
              },
            ],
      ),
    );
    return decoded.flat();
  });
  const order = (projectId: string) =>
    Effect.map(plans(projectId), mergeByRank).pipe(Effect.mapError(failed));

  return {
    /** The project's cards in the order the scheduler starts them. */
    order,

    /**
     * Moves `card` to the place of `before` (or last) and stores the rank of every card of the
     * project, so the order stays as arranged while cards come and go.
     */
    place: Effect.fn("CardOrder.place")(function* (
      projectId: string,
      card: OrderedCard,
      before: OrderedCard | null,
    ) {
      const next = placed(yield* order(projectId), card, before);
      const at = yield* now;
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM kanban_card_ranks WHERE project_id = ${projectId}`;
            yield* Effect.forEach(
              next,
              (ref, rank) => sql`INSERT INTO kanban_card_ranks
                (project_id, session_id, card_id, rank, updated_at)
                VALUES (${projectId}, ${ref.sessionId}, ${ref.cardId}, ${rank}, ${at})`,
              { discard: true },
            );
          }),
        )
        .pipe(Effect.mapError(failed));
      return next;
    }),
  };
});

/** The order of a project's cards across its boards. Owner process only. */
export class CardOrder extends Context.Service<CardOrder, Effect.Success<typeof make>>()(
  "memory-agent/kanban/card-order/CardOrder",
) {
  static readonly layer = Layer.effect(CardOrder, make);
}
