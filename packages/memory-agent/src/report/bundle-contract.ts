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

export const BundleEvent = Schema.TaggedUnion({
  Message: {
    role: Schema.Literals(["user", "assistant"]),
    at: Schema.String,
    text: BundleText,
  },
  ToolCall: {
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
  },
  Approval: {
    status: Schema.String,
    tool: Schema.NullOr(Schema.String),
    /** `null` when not answered or the answer is not an approval. */
    approved: Schema.NullOr(Schema.Boolean),
    requestedAt: Schema.String,
    resolvedAt: Schema.NullOr(Schema.String),
  },
  Trace: {
    ref: Schema.String,
    status: Schema.String,
    /** The tool call of the run that started the task, by its order; `null` when not in the bundle. */
    parentToolSeq: Schema.NullOr(Schema.Int),
    /** Why the task's latest attempt ended abnormally, as its failure tag; `null` when it did not. */
    failure: Schema.NullOr(Schema.String),
    updatedAt: Schema.String,
  },
});
export type BundleEvent = typeof BundleEvent.Type;

/**
 * A span of the run that ended with a failure (decided 2026-11-03). Only span names the app's code
 * gives, the failure tag with its system error codes, timing and numeric or boolean attributes:
 * never a string attribute.
 */
export const BundleSpan = Schema.Struct({
  /** Names of the spans it ran under, outermost first, ending with its own name. */
  path: Schema.Array(Schema.String),
  failure: Schema.String,
  endedAt: Schema.String,
  durationMs: Schema.Finite,
  attributes: Schema.Record(Schema.String, Schema.Union([Schema.Finite, Schema.Boolean])),
});
export type BundleSpan = typeof BundleSpan.Type;

/**
 * Where a run's time went (decided 2026-11-04): every span of its trace that ended, failed or not,
 * summed by its path. Only span names and numbers.
 */
export const BundleSpanTotal = Schema.Struct({
  /** Names of the spans it ran under, outermost first, ending with its own name. */
  path: Schema.Array(Schema.String),
  count: Schema.Int,
  failed: Schema.Int,
  totalMs: Schema.Finite,
  maxMs: Schema.Finite,
  /** When the first of them started. */
  firstStartedAt: Schema.String,
});
export type BundleSpanTotal = typeof BundleSpanTotal.Type;

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
  /**
   * The run's failed spans this process still holds in memory, oldest first: none after a restart
   * or once they are older than the recorder keeps them.
   */
  failedSpans: Schema.Array(BundleSpan),
  /**
   * The run's span totals this process holds in memory, longest total first: none after a restart
   * or for a run older than the recorder remembers.
   */
  spanTotals: Schema.Array(BundleSpanTotal),
  /** More span paths than the bundle or the recorder keeps; the shortest were left out. */
  spanTotalsCut: Schema.Boolean,
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
  /** 2 since runs carry their failed spans (2026-11-03); 3 since they carry span totals (2026-11-04). */
  version: Schema.Literal(3),
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
