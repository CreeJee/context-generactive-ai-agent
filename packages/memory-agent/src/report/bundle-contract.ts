import { Schema } from "effect";

/**
 * The evidence a report carries (decided 2026-10-18). The developer who reads the report cannot
 * open the user's database or sessions, so the bundle is collected whole and on its own: the user
 * does not pick items, they review the bundle before sending it. Every text in it went through
 * the secret redactor and was cut to its limit; `cut` says whether it was. Local ids appear only
 * as short hashes (`ref`); runs and tool calls are told apart by their order.
 */

/** A redacted text, cut to the limit its place in the bundle allows. */
export const BundleText = Schema.Struct({ text: Schema.String, cut: Schema.Boolean });
export type BundleText = typeof BundleText.Type;

export const BundleSectionStatus = Schema.Literals(["available", "empty", "failed"]);
export type BundleSectionStatus = typeof BundleSectionStatus.Type;

/** A part of the bundle with its own source: a failed source marks only its own section. */
const section = <S extends Schema.Constraint>(item: S) =>
  Schema.Struct({
    status: BundleSectionStatus,
    items: Schema.Array(item),
    /** Older items were left out to stay within the limits. */
    truncated: Schema.Boolean,
  });

export const BundleMessage = Schema.TaggedStruct("Message", {
  role: Schema.Literals(["user", "assistant"]),
  at: Schema.String,
  text: BundleText,
});

export const BundleToolCall = Schema.TaggedStruct("ToolCall", {
  /** Order of the call within its run, from 1. */
  seq: Schema.Int,
  name: Schema.NullOr(Schema.String),
  at: Schema.String,
  input: BundleText,
  result: Schema.NullOr(
    Schema.Struct({
      /** `null` when the record does not say. */
      ok: Schema.NullOr(Schema.Boolean),
      at: Schema.String,
      text: BundleText,
    }),
  ),
});

export const BundleApproval = Schema.TaggedStruct("Approval", {
  status: Schema.String,
  tool: Schema.NullOr(Schema.String),
  /** `null` when not answered or the answer is not an approval. */
  approved: Schema.NullOr(Schema.Boolean),
  requestedAt: Schema.String,
  resolvedAt: Schema.NullOr(Schema.String),
});

export const BundleTrace = Schema.TaggedStruct("Trace", {
  ref: Schema.String,
  status: Schema.String,
  /** The tool call of the run that started the task, by its order; `null` when not in the bundle. */
  parentToolSeq: Schema.NullOr(Schema.Int),
  /** Why the task's latest attempt ended abnormally, as its failure tag; `null` when it did not. */
  failure: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});

export const BundleEvent = Schema.Union([
  BundleMessage,
  BundleToolCall,
  BundleApproval,
  BundleTrace,
]);
export type BundleEvent = typeof BundleEvent.Type;

export const BundleRun = Schema.Struct({
  /** Order of the run in the session, from 1 for its first run. */
  seq: Schema.Int,
  ref: Schema.String,
  status: Schema.String,
  startedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.Struct({ code: Schema.NullOr(Schema.String), detail: BundleText })),
  events: Schema.Array(BundleEvent),
  /** Earlier events of the run were left out. */
  eventsCut: Schema.Boolean,
});
export type BundleRun = typeof BundleRun.Type;

export const BundleIntegration = Schema.Struct({
  kind: Schema.Literals(["mcp", "agent"]),
  name: Schema.String,
  scope: Schema.String,
  status: Schema.String,
  /** The failure code, when it failed. */
  code: Schema.NullOr(Schema.String),
});

export const BundleBoard = Schema.Struct({
  ref: Schema.String,
  status: Schema.String,
  /** The board loop's `LoopHealth` tag, with its retry count or error tag. */
  health: Schema.String,
  cards: Schema.Array(
    Schema.Struct({
      card: Schema.String,
      failureStreak: Schema.Int,
      replans: Schema.Int,
      reason: Schema.NullOr(Schema.String),
    }),
  ),
});

export const BundleDefect = Schema.Struct({
  tag: Schema.String,
  location: Schema.String,
  count: Schema.Int,
  lastAt: Schema.String,
});

export const ReportBundle = Schema.Struct({
  version: Schema.Literal(1),
  collectedAt: Schema.String,
  /** The limits the bundle was cut to, so a reader knows what may be missing. */
  limits: Schema.Struct({
    runs: Schema.Int,
    eventsPerRun: Schema.Int,
    textChars: Schema.Int,
    failureChars: Schema.Int,
  }),
  environment: Schema.Struct({
    release: Schema.String,
    platform: Schema.String,
    runtime: Schema.String,
    /** The provider and model kind in use; never credentials or endpoints. */
    provider: Schema.NullOr(Schema.String),
    model: Schema.NullOr(Schema.String),
    kanbanConcurrency: Schema.NullOr(Schema.Int),
  }),
  session: Schema.Struct({
    ref: Schema.String,
    title: Schema.NullOr(BundleText),
    /** How many runs the session has; the timeline holds the latest of them. */
    runCount: Schema.Int,
  }),
  integrations: section(BundleIntegration),
  loops: section(Schema.Struct({ loop: Schema.String, health: Schema.String })),
  boards: section(BundleBoard),
  defects: section(BundleDefect),
  timeline: section(BundleRun),
  /** Recent messages and calls not linked to any run. */
  unlinked: section(BundleEvent),
});
export type ReportBundle = typeof ReportBundle.Type;
