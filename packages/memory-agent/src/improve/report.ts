import { Function as EffectFunction } from "effect";
import { ItemInterpretation, type ReportedItem, reportedTitle, sourceLabels } from "./contracts.ts";
import { improvePrompts } from "./prompts.ts";

const prompts = improvePrompts.report;

/** Quoted so user text cannot open headings, lists or fences of its own. */
const quote = (text: string) =>
  text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

/** One line, so model or user text cannot start a heading or list item of its own. */
const line = (text: string) => text.replaceAll("\n", " ");

const specOf = (repository: string, item: ReportedItem) =>
  ItemInterpretation.match(item.interpretation, {
    interpreted: ({ problem, rule, change, acceptance }) => [
      `- **Problem:** ${line(problem)}`,
      prompts.spec.target(repository),
      prompts.spec.change(line(rule), line(change)),
      prompts.spec.constraints,
      prompts.spec.ownership,
      `- **Acceptance:** ${line(acceptance)}`,
    ],
    failed: ({ reason }) => [
      prompts.uninterpreted.note(prompts.uninterpreted.failure[reason]),
      prompts.uninterpreted.target(repository),
      `- **Change:** ${prompts.uninterpreted.change[item.source]}`,
      prompts.spec.constraints,
      prompts.spec.ownership,
      prompts.uninterpreted.acceptance,
    ],
  });

const itemSection = (repository: string, item: ReportedItem, index: number) =>
  [
    `## ${index + 1}. ${line(reportedTitle(item))}`,
    "",
    prompts.item.kind(sourceLabels[item.source], item.count),
    ...(item.latestAt === null ? [] : [prompts.item.latestAt(item.latestAt)]),
    prompts.item.id(item.id),
    "",
    prompts.item.spec,
    "",
    ...specOf(repository, item),
    "",
    prompts.item.evidence,
    "",
    ...item.excerpts.flatMap((excerpt) => [quote(excerpt), ""]),
  ].join("\n");

/** One repository and the improvement items found in it. */
interface FoundItems {
  readonly repository: string;
  readonly items: readonly ReportedItem[];
}

/** One repository's improvement items as a document another agent or tool can act on. */
export const improvementReport: {
  (generatedAt: string): (found: FoundItems) => string;
} & typeof improvementReportBody = EffectFunction.dual(2, improvementReportBody);
function improvementReportBody(found: FoundItems, generatedAt: string): string {
  return [
    prompts.heading(found.repository),
    "",
    prompts.intro(generatedAt),
    "",
    ...(found.items.length === 0
      ? [prompts.empty, ""]
      : found.items.map((item, index) => itemSection(found.repository, item, index))),
  ].join("\n");
}
