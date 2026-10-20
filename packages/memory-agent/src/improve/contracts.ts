import { Schema } from "effect";

// Shapes and wording shared by the backend and the settings page; nothing here reaches the
// database, the file system or a model.

/** One thing to improve in one repository and the evidence for it. */
export const ImprovementItem = Schema.Struct({
  /**
   * A tool failure or card keeps its id across scans. A correction group has no fixed key: it is
   * named after its oldest correction in the lookback window, so its id changes once that
   * correction leaves the window.
   */
  id: Schema.String,
  repository: Schema.String,
  source: Schema.Literals(["correction", "tool_failure", "card_failure"]),
  title: Schema.String,
  /** How many signals it groups; a card counts its failures and replans. */
  count: Schema.Int,
  /** Node ids, or `goal/card` ids for cards; the newest first, at most {@link grouping.evidence}. */
  evidence: Schema.Array(Schema.String),
  excerpts: Schema.Array(Schema.String),
  latestAt: Schema.NullOr(Schema.String),
});
export type ImprovementItem = typeof ImprovementItem.Type;

/** What the model made of one item: the problem and how to stop it, or why it could not say. */
export const ItemInterpretation = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("interpreted"),
    /** One line naming the problem. */
    title: Schema.String,
    /** What kept going wrong, from the evidence. */
    problem: Schema.String,
    /** The instruction to add to the repository's agent guidance file. */
    rule: Schema.String,
    /** The code, script or configuration change that removes the cause. */
    change: Schema.String,
    acceptance: Schema.String,
  }),
  /** The model could not be asked or did not answer usably; the item keeps its raw evidence. */
  Schema.Struct({
    status: Schema.Literal("failed"),
    reason: Schema.Literals(["model_failed", "invalid_answer"]),
  }),
]).pipe(Schema.toTaggedUnion("status"));
export type ItemInterpretation = typeof ItemInterpretation.Type;

/** An item the model judged worth fixing, or could not judge. */
export const ReportedItem = Schema.Struct({
  ...ImprovementItem.fields,
  interpretation: ItemInterpretation,
});
export type ReportedItem = typeof ReportedItem.Type;

/** One repository's recorded report: the Markdown document and the items in it. */
export const ImprovementReport = Schema.Struct({
  repository: Schema.String,
  /** Where the document was written, under the storage root. */
  file: Schema.String,
  markdown: Schema.String,
  items: Schema.Array(ReportedItem),
});
export type ImprovementReport = typeof ImprovementReport.Type;

export const ImprovementScan = Schema.Struct({
  generatedAt: Schema.String,
  reports: Schema.Array(ImprovementReport),
});
export type ImprovementScan = typeof ImprovementScan.Type;

/** How the app names each kind of item, in reports and on the settings page. */
export const sourceLabels: Record<ReportedItem["source"], string> = {
  correction: "반복된 정정",
  tool_failure: "반복된 도구 실패",
  card_failure: "칸반 카드 실패",
};

/** The item's name: the model's title when it read the item, otherwise the grouping label. */
export const reportedTitle = (item: ReportedItem) =>
  ItemInterpretation.match(item.interpretation, {
    interpreted: ({ title }) => title,
    failed: () => item.title,
  });
