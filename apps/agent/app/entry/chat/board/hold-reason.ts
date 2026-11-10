import { Match, Predicate } from "effect";
import type {
  CardFailure,
  CardHoldReason,
  VerdictFailure,
  WorktreeFailureReason,
} from "memory-agent";
import { boardCopy } from "./copy";

/**
 * Why the kanban loop held a card, in words picked by its tags. A model's own words (a verifier's
 * note, the orchestrator's reason for a Goal change) are returned apart by `holdReasonNote`, so
 * pages show them as an opinion and never as the reason's wording.
 */

export const verdictText = (verdict: VerdictFailure) =>
  Match.valueTags(verdict, {
    Rejected: () => boardCopy.verdict.Rejected,
    NoVerdict: () => boardCopy.verdict.NoVerdict,
    NotFinished: () => boardCopy.verdict.NotFinished,
    ModelSelectionRequired: () => boardCopy.verdict.ModelSelectionRequired,
    Unavailable: () => boardCopy.verdict.Unavailable,
  });

/** Worktree failures with their own words; the rest share one. */
const worktreeFailureTexts: Readonly<Partial<Record<typeof WorktreeFailureReason.Type, string>>> =
  boardCopy.worktreeFailure;

const failureText = (failure: CardFailure) =>
  Match.valueTags(failure, {
    Agent: ({ code }) => boardCopy.agentFailure[code],
    Worktree: ({ reason }) => worktreeFailureTexts[reason] ?? boardCopy.failure.Worktree,
    Verification: ({ verdict }) => verdictText(verdict),
    GoalBranchKeptMoving: () => boardCopy.failure.GoalBranchKeptMoving,
    Defect: () => boardCopy.failure.Defect,
  });

export const holdReasonText = (reason: CardHoldReason) =>
  Match.valueTags(reason, {
    RetryBackoff: ({ failure }) => boardCopy.holdReason.RetryBackoff(failureText(failure)),
    ReplanRequested: ({ failure }) =>
      failure === null
        ? boardCopy.holdReason.ReplanRequested
        : boardCopy.holdReason.ReplanAfterFailure(failureText(failure)),
    RepeatedFailure: ({ failure }) => boardCopy.holdReason.RepeatedFailure(failureText(failure)),
    MergeConflict: ({ files }) => boardCopy.holdReason.MergeConflict(files.join(", ")),
    UncertainEffect: () => boardCopy.holdReason.UncertainEffect,
    DeadLettered: () => boardCopy.holdReason.DeadLettered,
    GoalChanged: () => boardCopy.holdReason.GoalChanged,
    UpstreamRegressed: ({ verdict }) =>
      boardCopy.holdReason.UpstreamRegressed(verdictText(verdict)),
  });

const verdictNote = (verdict: VerdictFailure) =>
  Match.valueTags(verdict, {
    Rejected: ({ note }) => note,
    NoVerdict: () => null,
    NotFinished: () => null,
    ModelSelectionRequired: () => null,
    Unavailable: () => null,
  });

const failureNote = (failure: CardFailure) =>
  Predicate.isTagged(failure, "Verification") ? verdictNote(failure.verdict) : null;

/** What a model wrote about the hold, when it wrote anything. */
export const holdReasonNote = (reason: CardHoldReason) =>
  Match.valueTags(reason, {
    RetryBackoff: ({ failure }) => failureNote(failure),
    RepeatedFailure: ({ failure }) => failureNote(failure),
    ReplanRequested: ({ failure }) => (failure === null ? null : failureNote(failure)),
    GoalChanged: ({ note }) => note,
    UpstreamRegressed: ({ verdict }) => verdictNote(verdict),
    MergeConflict: () => null,
    UncertainEffect: () => null,
    DeadLettered: () => null,
  });
