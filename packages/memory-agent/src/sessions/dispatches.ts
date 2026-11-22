import { Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { ToolFailed } from "../tools/failure.ts";
import { runTool, type RunTool } from "../tools/run-tool.ts";
import { SessionInbox, type InboxEntry, type InboxStoreFailed } from "./inbox.ts";

/**
 * Persistent messages one conversation leaves another conversation of the same project
 * (docs/decisions.md "세션 dispatch는 표에 영속으로 저장한다"). A row waits until the target
 * conversation's next run delivers it; the app restarts never lose one. The rows live in the
 * session inbox (`SessionInbox`, sender `conversation`); this service checks the target and binds
 * the `notify_session` tool.
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
/** Reads the target check through the owner's connection as `DispatchStoreFailed`. */
const stored = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, DispatchStoreFailed, R> =>
  Effect.mapError(effect, (cause) => DispatchStoreFailed.make({ cause }));
/** What the inbox could not store or read, as the dispatch store's own failure. */
const fromInbox = <A, R>(
  effect: Effect.Effect<A, InboxStoreFailed, R>,
): Effect.Effect<A, DispatchStoreFailed, R> =>
  Effect.mapError(effect, ({ cause }) => DispatchStoreFailed.make({ cause }));

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

type ConversationEntry = Extract<InboxEntry, { readonly sender: "conversation" }>;

const toDispatch = (entry: ConversationEntry): SessionDispatch => ({
  id: entry.id,
  projectId: entry.payload.projectId,
  fromSessionId: entry.payload.fromSessionId,
  fromRunId: entry.payload.fromRunId,
  toSessionId: entry.sessionId,
  body: entry.payload.body,
  state: entry.state,
  deliveredRunId: entry.deliveredRunId,
  createdAt: entry.createdAt,
  deliveredAt: entry.deliveredAt,
});
/** The inbox rows another conversation left, as dispatches. */
const toDispatches = (entries: ReadonlyArray<InboxEntry>) =>
  entries.filter((entry) => entry.sender === "conversation").map(toDispatch);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const inbox = yield* SessionInbox;
  /**
   * One chat conversation of a project: a row of `sessions` that is not a report conversation
   * (`report_sessions`). A run's subagent threads are not `sessions` rows either.
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
        const entry = yield* fromInbox(
          inbox.put({
            sessionId: toSessionId,
            sender: "conversation",
            delivery: "next_run",
            payload: { projectId, fromSessionId, fromRunId, body },
          }),
        );
        return toDispatch(entry);
      });

  return {
    notify,

    /** The dispatches of a conversation that still wait, oldest first. */
    pending: (toSessionId: string) =>
      Effect.map(fromInbox(inbox.pending(toSessionId)), toDispatches),

    /**
     * Marks the listed dispatches of the conversation that delivered them; rows another call
     * already delivered stay delivered. Returns the ids it actually marked.
     */
    deliver: (toSessionId: string, deliveredRunId: string, ids: readonly string[]) =>
      fromInbox(inbox.deliver(toSessionId, deliveredRunId, ids)),

    /**
     * Takes the conversation's waiting dispatches for the run `runId`, oldest first, each marked
     * with the run that delivers it. The mark keeps every run, including `runId` again, from
     * taking the same dispatch twice; a run that does not finish gives its takes back with
     * `release`, and a run that finishes completes their delivery with `deliverClaimed`. A session
     * whose user stopped the notifications (parent_notification_holds, decisions.md "대상 세션의
     * 다음 run에 전달한다") takes nothing: its rows keep waiting for a later run.
     */
    consume: (toSessionId: string, runId: string) =>
      Effect.map(fromInbox(inbox.claim(toSessionId, runId)), toDispatches),

    /** Gives back the dispatches the run `runId` claimed; the rows wait for the next run again. */
    release: (toSessionId: string, runId: string) => fromInbox(inbox.release(toSessionId, runId)),

    /**
     * Marks the dispatches the run `runId` claimed of the conversation delivered, as `deliver`
     * does, and lets go of the claims. A row another call already delivered stays delivered.
     */
    deliverClaimed: (toSessionId: string, runId: string) =>
      fromInbox(inbox.deliverClaimed(toSessionId, runId)),

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
 * The session dispatches of every conversation: the target check and the `notify_session` tool
 * over the rows the session inbox keeps.
 */
export class SessionDispatches extends Context.Service<
  SessionDispatches,
  Effect.Success<typeof make>
>()("memory-agent/sessions/dispatches/SessionDispatches") {
  static readonly layer = Layer.effect(SessionDispatches, make);
}
