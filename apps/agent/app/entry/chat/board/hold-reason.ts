import { i18n, type MessageDescriptor } from "@lingui/core";
import { msg, ph, t } from "@lingui/core/macro";
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
    Rejected: () => t`검증에서 통과하지 못했습니다`,
    NoVerdict: () => t`검증이 판정을 남기지 않았습니다`,
    NotFinished: () => t`검증이 끝나지 않았습니다`,
    ModelSelectionRequired: () => t`검증할 모델이 선택되지 않았습니다`,
    Unavailable: () => t`검증을 실행할 수 없었습니다`,
  });

const agentFailureTexts = {
  model_selection_required: msg`실행할 모델이 선택되지 않았습니다`,
  not_started: msg`에이전트가 시작하지 못했습니다`,
  failed: msg`에이전트 실행이 실패했습니다`,
  cancelled: msg`에이전트 실행이 중단됐습니다`,
  unavailable: msg`에이전트를 실행할 수 없었습니다`,
} satisfies Readonly<Record<AgentFailureCode, MessageDescriptor>>;

/** Worktree failures with their own words; the rest share one. */
const worktreeFailureTexts: Readonly<
  Partial<Record<typeof WorktreeFailureReason.Type, MessageDescriptor>>
> = {
  WorktreeDirty: msg`카드 작업 폴더에 정리되지 않은 변경이 있습니다`,
  ConflictUnresolved: msg`Goal 브랜치와 충돌한 파일에 아직 풀지 않은 충돌이 남아 있습니다`,
  InUse: msg`카드 작업 폴더를 다른 실행이 쓰고 있습니다`,
  GitFailed: msg`git 명령이 실패했습니다`,
};

const worktreeFailureText = (reason: typeof WorktreeFailureReason.Type) => {
  const own = worktreeFailureTexts[reason];
  return own === undefined ? t`카드 작업 폴더를 준비하지 못했습니다` : i18n._(own);
};

const failureText = (failure: CardFailure) =>
  Match.valueTags(failure, {
    Agent: ({ code }) => i18n._(agentFailureTexts[code]),
    Worktree: ({ reason }) => worktreeFailureText(reason),
    Verification: ({ verdict }) => verdictText(verdict),
    GoalBranchKeptMoving: () => t`Goal 브랜치가 계속 바뀌어 통합하지 못했습니다`,
    Defect: () => t`예상하지 못한 오류로 실패했습니다`,
  });

export const holdReasonText = (reason: CardHoldReason) =>
  Match.valueTags(reason, {
    RetryBackoff: ({ failure }) =>
      t`다시 실패해 잠시 뒤 재시도합니다: ${ph({ failure: failureText(failure) })}`,
    ReplanRequested: ({ failure, awaitingUser }) =>
      awaitingUser === true
        ? failure === null
          ? t`Plan 작성자가 카드를 대체하지 않았습니다. 카드를 고치거나 다시 대기열에 넣어 주십시오`
          : t`계속 실패했지만 Plan 작성자가 카드를 다시 짜지 않았습니다. 카드를 고치거나 다시 대기열에 넣어 주십시오: ${ph({ failure: failureText(failure) })}`
        : failure === null
          ? t`새 카드로 대체하도록 요청했습니다`
          : t`계속 실패해 Plan 작성자에게 카드를 다시 짜 달라고 요청했습니다: ${ph({ failure: failureText(failure) })}`,
    RepeatedFailure: ({ failure }) =>
      t`다시 짠 뒤에도 실패했습니다: ${ph({ failure: failureText(failure) })}`,
    MergeConflict: ({ files }) => t`Goal 브랜치와 충돌: ${ph({ files: files.join(", ") })}`,
    UncertainEffect: () => t`이전 실행의 결과를 알 수 없어 확인이 필요합니다`,
    DeadLettered: () => t`실행 기회를 모두 써서 멈췄습니다. 다시 대기열에 넣을 수 있습니다`,
    GoalChanged: () => t`Goal이 바뀌어 오케스트레이터가 이 카드를 멈췄습니다`,
    UpstreamRegressed: ({ verdict }) =>
      t`다른 Goal이 merge된 뒤 다시 검증하니 통과하지 못했습니다: ${ph({ verdict: verdictText(verdict) })}`,
  });

/** A card a replan was asked for and the planner's run left as it was: it waits for the user. */
export const waitsForUser = (reason: CardHoldReason | null) =>
  Predicate.isTagged(reason, "ReplanRequested") && reason.awaitingUser === true;

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
