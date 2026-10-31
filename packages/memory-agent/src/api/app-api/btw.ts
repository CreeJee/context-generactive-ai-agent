import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { BtwThread } from "../../btw/contracts.ts";
import { appRefusalFields, refusalWith, SameSite } from "../refusal.ts";

const appRefusal = refusalWith(appRefusalFields);

/** A deleted thread. `filesPending`: the rows are gone, some image files wait for the next cleanup. */
export const BtwThreadDeleted = Schema.Struct({
  deleted: Schema.Literal(true),
  filesPending: Schema.Boolean,
});
export type BtwThreadDeleted = typeof BtwThreadDeleted.Type;

/** The conversation the path names does not exist. */
const UnknownSession = appRefusal(404, ["session_not_found"]);

/** The thread the path names does not exist. */
const UnknownThread = appRefusal(404, ["btw_not_found"]);

/** The thread's answer did not stop in time. */
const RunInProgress = appRefusal(409, ["run_in_progress"]);

/** Every refusal of the group, for `appRefusalStatus`. */
export const btwRefusals = [UnknownSession, UnknownThread, RunInProgress];

/**
 * A conversation's BTW threads: listing, opening and deleting them. Asking a thread and reading its
 * messages are the chat API's (`chat-api.ts` `BtwGroup`).
 */
export class BtwThreadsGroup extends HttpApiGroup.make("btw")
  .add(
    /** The conversation's threads, newest first. */
    HttpApiEndpoint.get("list", "/api/sessions/:session/btw", {
      params: { session: Schema.String },
      success: Schema.Array(BtwThread),
    }),
    /** Opens a thread bound for good to the conversation. */
    HttpApiEndpoint.post("create", "/api/sessions/:session/btw", {
      params: { session: Schema.String },
      success: BtwThread.pipe(HttpApiSchema.status(201)),
      error: UnknownSession,
    }),
    /**
     * Deletes the thread, its messages, tool calls and results, and images no other message uses.
     * A running answer is stopped first.
     */
    HttpApiEndpoint.delete("remove", "/api/btw/:thread", {
      params: { thread: Schema.String },
      success: BtwThreadDeleted,
      error: [UnknownThread, RunInProgress],
    }),
  )
  .middleware(SameSite) {}
