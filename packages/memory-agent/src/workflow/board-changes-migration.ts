import { Effect, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { boardChange, revisionCards } from "./workflow.ts";

const SessionRow = Schema.Struct({ session_id: Schema.String });
const RevisionRow = Schema.Struct({ id: Schema.Int, plan_json: Schema.NullOr(Schema.String) });

/** A session's revisions so far: the cards of the latest one it could read, and those it could not. */
interface Walk {
  readonly cards: ReadonlyMap<string, string>;
  readonly unreadable: number;
}

/**
 * Works out the cards every stored revision changed from the revision before it, session by
 * session in revision order, as saving a new revision does. A revision whose Plan it cannot read
 * records no change, and the next one is compared with the latest one it could read; the board
 * failed to show such a revision before as well.
 */
export const migrateBoardChanges = Effect.fn("Workflows.migrateBoardChanges")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sessions = SqlSchema.findAll({
    Request: Schema.Void,
    Result: SessionRow,
    execute: () => sql`SELECT DISTINCT session_id FROM workflow_state_revisions`,
  });
  const revisions = SqlSchema.findAll({
    Request: Schema.String,
    Result: RevisionRow,
    execute: (sessionId) => sql`SELECT id, plan_json FROM workflow_state_revisions
      WHERE session_id = ${sessionId} ORDER BY id`,
  });
  const record = (revisionId: number, sessionId: string, change: Option.Option<string>) =>
    Option.match(change, {
      onNone: () => Effect.void,
      onSome: (json) =>
        Effect.asVoid(sql`INSERT INTO workflow_board_changes
          (revision_id, session_id, card_ids_json) VALUES (${revisionId}, ${sessionId}, ${json})`),
    });
  const walks = yield* Effect.forEach(yield* sessions(), ({ session_id }) =>
    Effect.flatMap(revisions(session_id), (rows) =>
      Effect.reduce(
        rows,
        (): Walk => ({ cards: new Map(), unreadable: 0 }),
        (walk, row) =>
          Effect.matchEffect(revisionCards(row.plan_json), {
            onFailure: () => Effect.succeed({ ...walk, unreadable: walk.unreadable + 1 }),
            onSuccess: (cards) =>
              boardChange({ before: walk.cards, after: cards }).pipe(
                Effect.flatMap((change) => record(row.id, session_id, change)),
                Effect.as({ ...walk, cards }),
              ),
          }),
      ),
    ),
  );
  const unreadable = walks.reduce((total, walk) => total + walk.unreadable, 0);
  yield* Effect.when(
    Effect.logWarning("Workflow revisions whose Plan could not be read", { unreadable }),
    Effect.succeed(unreadable > 0),
  );
});
