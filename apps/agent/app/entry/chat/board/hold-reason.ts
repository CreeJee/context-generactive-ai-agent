import { Match, Predicate } from "effect";
import type {
  AgentFailureCode,
  CardFailure,
  CardHoldReason,
  VerdictFailure,
  WorktreeFailureReason,
} from "memory-agent";

/**
 * Why the kanban loop held a card, in words picked by its tags. A model's own words (a verifier's
 * note, the orchestrator's reason for a Goal change) are returned apart by `holdReasonNote`, so
 * pages show them as an opinion and never as the reason's wording.
 */

export const verdictText = (verdict: VerdictFailure) =>
  Match.valueTags(verdict, {
    Rejected: () => "검증에서 통과하지 못했어요",
    NoVerdict: () => "검증이 판정을 남기지 않았어요",
    NotFinished: () => "검증이 끝나지 않았어요",
    ModelSelectionRequired: () => "검증할 모델이 선택되지 않았어요",
    Unavailable: () => "검증을 실행할 수 없었어요",
  });

const agentFailureTexts: Readonly<Record<AgentFailureCode, string>> = {
  model_selection_required: "실행할 모델이 선택되지 않았어요",
  not_started: "에이전트가 시작하지 못했어요",
  failed: "에이전트 실행이 실패했어요",
  cancelled: "에이전트 실행이 중단됐어요",
  unavailable: "에이전트를 실행할 수 없었어요",
};

/** Worktree failures with their own words; the rest share one. */
const worktreeFailureTexts: Readonly<Partial<Record<typeof WorktreeFailureReason.Type, string>>> = {
  WorktreeDirty: "카드 작업 폴더에 정리되지 않은 변경이 있어요",
  InUse: "카드 작업 폴더를 다른 실행이 쓰고 있어요",
  GitFailed: "git 명령이 실패했어요",
};

const failureText = (failure: CardFailure) =>
  Match.valueTags(failure, {
    Agent: ({ code }) => agentFailureTexts[code],
    Worktree: ({ reason }) => worktreeFailureTexts[reason] ?? "카드 작업 폴더를 준비하지 못했어요",
    Verification: ({ verdict }) => verdictText(verdict),
    GoalBranchKeptMoving: () => "Goal 브랜치가 계속 바뀌어 통합하지 못했어요",
    Defect: () => "예상하지 못한 오류로 실패했어요",
  });

export const holdReasonText = (reason: CardHoldReason) =>
  Match.valueTags(reason, {
    RetryBackoff: ({ failure }) => `다시 실패해 잠시 뒤 재시도해요: ${failureText(failure)}`,
    ReplanRequested: ({ failure }) =>
      failure === null
        ? "새 카드로 대체하도록 요청했어요"
        : `계속 실패해 카드를 다시 계획해요: ${failureText(failure)}`,
    RepeatedFailure: ({ failure }) => `다시 계획한 뒤에도 실패했어요: ${failureText(failure)}`,
    MergeConflict: ({ files }) => `Goal 브랜치와 충돌: ${files.join(", ")}`,
    UncertainEffect: () => "이전 실행의 결과를 알 수 없어 확인이 필요해요",
    DeadLettered: () => "실행 기회를 모두 써서 멈췄어요. 다시 대기열에 넣을 수 있어요",
    GoalChanged: () => "Goal이 바뀌어 오케스트레이터가 이 카드를 멈췄어요",
    UpstreamRegressed: ({ verdict }) =>
      `다른 Goal이 merge된 뒤 다시 검증하니 통과하지 못했어요: ${verdictText(verdict)}`,
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
