import { Schema } from "effect";

/**
 * The only tools a BTW thread may call: search, read the original, trace provenance. All three
 * read the same project's memory. Writes, promotion, workflow, files, shell and subagents are
 * never offered, and a call to any other name is refused by the server.
 */
export const btwToolNames = ["find_memory", "read_evidence", "trace_evidence"] as const;
export const BtwToolName = Schema.Literals(btwToolNames);
export type BtwToolName = typeof BtwToolName.Type;

/** A side question thread bound for good to one main conversation. */
export const BtwThread = Schema.Struct({
  id: Schema.String,
  parentSessionId: Schema.String,
  projectId: Schema.String,
  /** From the first question; null until one is asked. */
  title: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  /** Epoch milliseconds of the last saved message. */
  updatedAt: Schema.Finite,
});
export type BtwThread = typeof BtwThread.Type;

export class BtwThreadNotFound extends Schema.TaggedError<BtwThreadNotFound>()(
  "BtwThreadNotFound",
  { threadId: Schema.String },
) {}

export class BtwParentNotFound extends Schema.TaggedError<BtwParentNotFound>()(
  "BtwParentNotFound",
  { sessionId: Schema.String },
) {}

export class BtwRunInProgress extends Schema.TaggedError<BtwRunInProgress>()("BtwRunInProgress", {
  threadId: Schema.String,
}) {}

export class BtwStorageFailed extends Schema.TaggedError<BtwStorageFailed>()("BtwStorageFailed", {
  operation: Schema.Literals(["purge_attachments", "create_thread", "read_transcript"]),
}) {}

export class BtwError extends Schema.TaggedError<BtwError>()("BtwError", {
  reason: Schema.Union([BtwThreadNotFound, BtwParentNotFound, BtwRunInProgress, BtwStorageFailed]),
}) {}
