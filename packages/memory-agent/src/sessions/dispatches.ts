import { Clock, Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import { SecureRandom } from "effect/crypto";
import { SqlClient, SqlSchema } from "effect/sql";
import { NodeCrypto } from "@effect/platform-node";
import { ToolFailed } from "../tools/failure.ts";
import { runTool, type RunTool } from "../tools/run-tool.ts";

/**
 * Persistent messages one conversation leaves another conversation of the same project
 * (docs/decisions.md "세션 dispatch는 표에 영속으로 저장한다"). A row waits until the target
 * conversation's next run delivers it; the app restarts never lose one.
 */

export const SessionDispatchState = Schema.Literals(["waiting", "delivered"]);
export type SessionDispatchState = typeof SessionDispatchState.Type;

/** One dispatch as a test or the delivery reads it. */
export const SessionDispatch = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  fromSessionId: Schema.String,
  fromRunId: Schema.String,
  toSessionId: Schema.String,
  body: Schema.String,
  state: SessionDispatchState,
  deliveredRunId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  deliveredAt: Schema.NullOr(Schema.String),
});
export type SessionDispatch = typeof SessionDispatch.Type;

/** What a dispatching conversation and its run contribute to every dispatch. */
export interface NotifyRequest {
  readonly projectId: string;
  readonly fromSessionId: string;
  readonly fromRunId: string;
}

/** Why the target could not take the dispatch. Each reason is a typed refusal. */
export const NotifyTargetRejectedReason = Schema.Literals([
  /** No conversation with that id exists in this storage. */
  "unknown_target",
  /** The target conversation belongs to another project. */
  "other_project",
  /** The target is the dispatching conversation itself. */
  "self_target",
  /** The target is a report conversation bound to a source, not a chat of its own. */
  "report_target",
]);
export type NotifyTargetRejectedReason = typeof NotifyTargetRejectedReason.Type;

export class NotifyTargetRejected extends Schema.TaggedError<
  NotifyTargetRejected,
  { readonly brand: unique symbol }
>()("NotifyTargetRejected", {
  reason: NotifyTargetRejectedReason,
  toSessionId: Schema.String,
}) {}

export class DispatchStoreFailed extends Schema.TaggedError<
  DispatchStoreFailed,
  { readonly brand: unique symbol }
>()("DispatchStoreFailed", { cause: Schema.Defect() }) {}
/** Reads the store's own tables through the owner's connection as `DispatchStoreFailed`. */
const stored = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, DispatchStoreFailed, R> =>
  Effect.mapError(effect, (cause) => DispatchStoreFailed.make({ cause }));

/** Longest message one conversation may leave another. */
export const maxDispatchBodyCharacters = 8_000;

export const NotifySessionInput = Schema.Struct({
  toSession: Schema.NonEmptyString.annotate({
    description: "Id of another conversation of the same project, as the session list shows it.",
  }),
  body: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(maxDispatchBodyCharacters)),
  ).annotate({
    description: `The message to leave. At most ${maxDispatchBodyCharacters} characters.`,
  }),
});
const notifySessionSpec = {
  name: "notify_session",
  description:
    "Leave a short message for another conversation of the same project. It is delivered when that conversation's next run starts. Use it to hand over finished work or a decision the other conversation is waiting on, not to ask the user anything: the message is not user input and carries no approval.",
  parameters: NotifySessionInput,
} as const;

const DispatchRow = Schema.Struct({
  id: Schema.String,
  project_id: Schema.String,
  from_session_id: Schema.String,
  from_run_id: Schema.String,
  to_session_id: Schema.String,
  body: Schema.String,
  state: SessionDispatchState,
  delivered_run_id: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  delivered_at: Schema.NullOr(Schema.String),
});
type DispatchRow = typeof DispatchRow.Type;

const toDispatch = (row: DispatchRow): SessionDispatch => ({
  id: row.id,
  projectId: row.project_id,
  fromSessionId: row.from_session_id,
  fromRunId: row.from_run_id,
  toSessionId: row.to_session_id,
  body: row.body,
  state: row.state,
  deliveredRunId: row.delivered_run_id,
  createdAt: row.created_at,
  deliveredAt: row.delivered_at,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* SecureRandom.SecureRandom;
  /**
   * One chat conversation of a project: a row of `sessions` that is not a report conversation
   * (`report_sessions`) and not a BTW side thread (which is not a `sessions` row at all). A run's
   * subagent threads are not `sessions` rows either.
   */
  const targetOf = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ id: Schema.String, project_id: Schema.String, report: Schema.Finite }),
    execute: (toSessionId) =>
      sql`
    SELECT s.id, s.project_id, EXISTS (
      SELECT 1 FROM report_sessions r WHERE r.report_session_id = s.id
    ) AS report
    FROM sessions s WHERE s.id = ${toSessionId}`,
  });
  const insert = SqlSchema.findOne({
    Request: DispatchRow,
    Result: DispatchRow,
    execute: (row) => sql`
      INSERT INTO session_dispatches (id, project_id, from_session_id, from_run_id, to_session_id,
        body, state, delivered_run_id, created_at, delivered_at)
      VALUES (${row.id}, ${row.project_id}, ${row.from_session_id}, ${row.from_run_id},
        ${row.to_session_id}, ${row.body}, ${row.state}, ${row.delivered_run_id}, ${row.created_at},
        ${row.delivered_at})
      RETURNING *`,
  });
  const waiting = SqlSchema.findAll({
    Request: Schema.String,
    Result: DispatchRow,
    execute: (toSessionId) => sql`
      SELECT * FROM session_dispatches WHERE to_session_id = ${toSessionId} AND state = 'waiting'
      ORDER BY created_at, id`,
  });
  const markDeliveredRows = SqlSchema.findAll({
    Request: Schema.Struct({
      toSessionId: Schema.String,
      ids: Schema.Array(Schema.String),
      deliveredRunId: Schema.String,
      deliveredAt: Schema.String,
    }),
    Result: Schema.Struct({ id: Schema.String }),
    execute: ({ toSessionId, ids, deliveredRunId, deliveredAt }) => sql`
      UPDATE session_dispatches SET state = 'delivered', delivered_run_id = ${deliveredRunId},
        delivered_at = ${deliveredAt}
      WHERE to_session_id = ${toSessionId} AND state = 'waiting'
        AND id IN ${sql.in(ids)}
      RETURNING id`,
  });
  const isoNow = Effect.map(Clock.currentTimeMillis, (millis) =>
    DateTime.formatIso(DateTime.makeUnsafe(millis)),
  );

  const rejectTarget = (reason: NotifyTargetRejectedReason, toSessionId: string) =>
    Effect.fail(NotifyTargetRejected.make({ reason, toSessionId }));

  /**
   * Stores one dispatch for `toSessionId` after checking it is a chat conversation of the same
   * project that is not the dispatching conversation and not a report conversation. Nothing is
   * written when the target is rejected.
   */
  const notify =
    ({ projectId, fromSessionId, fromRunId }: NotifyRequest) =>
    ({ toSessionId, body }: { readonly toSessionId: string; readonly body: string }) =>
      Effect.gen(function* () {
        const target = yield* stored(targetOf(toSessionId));
        if (Option.isNone(target))
          return yield* toSessionId === fromSessionId
            ? rejectTarget("self_target", toSessionId)
            : rejectTarget("unknown_target", toSessionId);
        const { project_id, report } = target.value;
        if (project_id !== projectId)
          return yield* rejectTarget(
            toSessionId === fromSessionId ? "self_target" : "other_project",
            toSessionId,
          );
        if (toSessionId === fromSessionId) return yield* rejectTarget("self_target", toSessionId);
        if (report !== 0) return yield* rejectTarget("report_target", toSessionId);
        const id = yield* crypto.uuidV7();
        const row = yield* insert({
          id,
          project_id: projectId,
          from_session_id: fromSessionId,
          from_run_id: fromRunId,
          to_session_id: toSessionId,
          body,
          state: "waiting",
          delivered_run_id: null,
          created_at: yield* isoNow,
          delivered_at: null,
        }).pipe(stored);
        return toDispatch(row);
      });

  return {
    notify,

    /** The dispatches of a conversation that still wait, oldest first. */
    pending: (toSessionId: string) =>
      Effect.map(waiting(toSessionId), (rows) => rows.map(toDispatch)).pipe(stored),

    /**
     * Marks the listed dispatches of the conversation that delivered them; rows another call
     * already delivered stay delivered. Returns the ids it actually marked.
     */
    deliver: (toSessionId: string, deliveredRunId: string, ids: readonly string[]) =>
      Effect.gen(function* () {
        if (ids.length === 0) return [];
        const deliveredAt = yield* isoNow;
        const marked = yield* markDeliveredRows({
          toSessionId,
          ids: [...ids],
          deliveredRunId,
          deliveredAt,
        }).pipe(stored);
        return marked.map((row) => row.id);
      }),

    /**
     * The run's `notify_session` tool, bound to the conversation and run whose model calls it.
     * The call is read-only for the project: it only stores a message the app itself delivers.
     */
    notifyToolFor: (projectId: string, sessionId: string, runId: string): RunTool => {
      const refused = (error: NotifyTargetRejected | DispatchStoreFailed): ToolFailed =>
        error._tag === "DispatchStoreFailed"
          ? ToolFailed.make({
              code: "notify_store_failed",
              tag: error._tag,
              detail: "The dispatch could not be stored; try again or tell the user.",
            })
          : ToolFailed.make({
              code: `notify_${error.reason}`,
              tag: error._tag,
              detail:
                error.reason === "self_target"
                  ? "A conversation cannot notify itself; the message is already in this conversation."
                  : error.reason === "report_target"
                    ? "The target conversation is a report conversation bound to a source; notify another conversation."
                    : error.reason === "other_project"
                      ? "The target conversation belongs to another project; only a conversation of the same project can be notified."
                      : `No conversation ${error.toSessionId} exists in this app; check the id in the session list.`,
              refused: true,
            });
      const dispatch = notify({
        projectId,
        fromSessionId: sessionId,
        fromRunId: runId,
      });
      return runTool({
        ...notifySessionSpec,
        handler: ({ toSession, body }) =>
          Effect.mapError(
            dispatch({
              toSessionId: toSession,
              body: body.slice(0, maxDispatchBodyCharacters),
            }),
            (error) => refused(error),
          ),
      });
    },
  };
});

/**
 * The persistent store of session dispatches. Reads and writes go through the owner's own
 * `SqlClient`, so a row written survives the process and the writer's scope.
 */
export class SessionDispatches extends Context.Service<
  SessionDispatches,
  Effect.Success<typeof make>
>()("memory-agent/sessions/dispatches/SessionDispatches") {
  static readonly layer = Layer.effect(SessionDispatches, make).pipe(
    Layer.provide(NodeCrypto.layer),
  );
}
