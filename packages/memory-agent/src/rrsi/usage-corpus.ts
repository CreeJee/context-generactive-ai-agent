import { Schema } from "effect";
import { sha256 } from "../runtime/synchronous-crypto.ts";

/** A memory task built from one real user correction, asked later in a new session. */
export const UsageTask = Schema.Struct({
  id: Schema.String,
  split: Schema.Literals(["evolve", "validation", "sealed"]),
  projectId: Schema.String,
  /** The user node that corrected an earlier answer; the only accepted evidence. */
  correctionNodeId: Schema.String,
  question: Schema.NonEmptyString,
  decision: Schema.NonEmptyString,
});
export type UsageTask = typeof UsageTask.Type;

export const UsageCorpus = Schema.Struct({
  version: Schema.String,
  createdAt: Schema.Finite,
  tasks: Schema.Array(UsageTask),
});
export type UsageCorpus = typeof UsageCorpus.Type;

/** What the generator returns for one correction. */
export const GeneratedQuestion = Schema.Union([
  Schema.Struct({ keep: Schema.Literal(false) }),
  Schema.Struct({
    keep: Schema.Literal(true),
    question: Schema.NonEmptyString,
    decision: Schema.NonEmptyString,
  }),
]);

/**
 * Splits by the correction's original session, so corrections from one conversation never land in
 * different suites: 60% evolve, 20% validation, 20% sealed.
 */
export function usageSplit(sessionId: string): UsageTask["split"] {
  const bucket = Number.parseInt(sha256(sessionId).slice(0, 8), 16) % 10;
  return bucket < 6 ? "evolve" : bucket < 8 ? "validation" : "sealed";
}

const normalized = (text: string) =>
  text.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();

/** The generated decision must be stated in the user's own correction, not invented. */
export function decisionInCorrection(decision: string, correction: string): boolean {
  return normalized(correction).includes(normalized(decision));
}

export const generationPrompt = (correction: string, corrected: string) =>
  [
    "A user corrected an AI assistant. Decide whether the correction states a durable decision or fact that the assistant should remember later (a naming rule, a design choice, a constraint, a preference). One-off work instructions such as 'commit now' or 'continue' are not durable.",
    'If it is not durable, return only {"keep":false}.',
    'If it is durable, return only {"keep":true,"question":...,"decision":...}. "question" is what the user might ask in a later, new conversation to check that the assistant remembers it, written in the user\'s language, without revealing the answer. "decision" is the shortest phrase copied verbatim from the correction that answers the question.',
    `Correction: ${correction}`,
    `Corrected message: ${corrected}`,
  ].join("\n");

/** The question as the evaluator asks it, with the scoring contract appended. */
export const usageQuestion = (task: UsageTask) =>
  `${task.question}\nRetrieve original evidence if necessary. Return only JSON with exactly two fields: "decision" (the current decision in a short phrase) and "evidenceIds" (an array containing only the ID of the original user message that stated it). Do not cite an assistant response or a summary.`;
