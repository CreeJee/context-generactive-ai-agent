import type { CardFailure, CardHoldReason, VerdictFailure } from "memory-agent";

/**
 * Why the kanban loop held a card, in words picked by its tags. A model's own words (a verifier's
 * note, the orchestrator's reason for a Goal change) are returned apart by `holdReasonNote`, so
 * pages show them as an opinion and never as the reason's wording.
 */

export const verdictText = (verdict: VerdictFailure) => {
  switch (verdict._tag) {
    case "Rejected":
      return "검증에서 통과하지 못했어요";
    case "NoVerdict":
      return "검증이 판정을 남기지 않았어요";
    case "NotFinished":
      return "검증이 끝나지 않았어요";
    case "ModelSelectionRequired":
      return "검증할 모델이 선택되지 않았어요";
    case "Unavailable":
      return "검증을 실행할 수 없었어요";
  }
};

const failureText = (failure: CardFailure) => {
  switch (failure._tag) {
    case "Agent":
      switch (failure.code) {
        case "model_selection_required":
          return "실행할 모델이 선택되지 않았어요";
        case "not_started":
          return "에이전트가 시작하지 못했어요";
        case "failed":
          return "에이전트 실행이 실패했어요";
        case "cancelled":
          return "에이전트 실행이 중단됐어요";
        case "unavailable":
          return "에이전트를 실행할 수 없었어요";
      }
    case "Worktree":
      switch (failure.reason) {
        case "WorktreeDirty":
          return "카드 작업 폴더에 정리되지 않은 변경이 있어요";
        case "InUse":
          return "카드 작업 폴더를 다른 실행이 쓰고 있어요";
        case "GitFailed":
          return "git 명령이 실패했어요";
        default:
          return "카드 작업 폴더를 준비하지 못했어요";
      }
    case "Verification":
      return verdictText(failure.verdict);
    case "GoalBranchKeptMoving":
      return "Goal 브랜치가 계속 바뀌어 통합하지 못했어요";
    case "Defect":
      return "예상하지 못한 오류로 실패했어요";
  }
};

export const holdReasonText = (reason: CardHoldReason) => {
  switch (reason._tag) {
    case "RetryBackoff":
      return `다시 실패해 잠시 뒤 재시도해요: ${failureText(reason.failure)}`;
    case "ReplanRequested":
      return reason.failure === null
        ? "새 카드로 대체하도록 요청했어요"
        : `계속 실패해 카드를 다시 계획해요: ${failureText(reason.failure)}`;
    case "RepeatedFailure":
      return `다시 계획한 뒤에도 실패했어요: ${failureText(reason.failure)}`;
    case "MergeConflict":
      return `Goal 브랜치와 충돌: ${reason.files.join(", ")}`;
    case "UncertainEffect":
      return "이전 실행의 결과를 알 수 없어 확인이 필요해요";
    case "DeadLettered":
      return "실행 기회를 모두 써서 멈췄어요. 다시 대기열에 넣을 수 있어요";
    case "GoalChanged":
      return "Goal이 바뀌어 오케스트레이터가 이 카드를 멈췄어요";
    case "UpstreamRegressed":
      return `다른 Goal이 merge된 뒤 다시 검증하니 통과하지 못했어요: ${verdictText(reason.verdict)}`;
  }
};

const verdictNote = (verdict: VerdictFailure) => {
  switch (verdict._tag) {
    case "Rejected":
      return verdict.note;
    case "NoVerdict":
    case "NotFinished":
    case "ModelSelectionRequired":
    case "Unavailable":
      return null;
  }
};

/** What a model wrote about the hold, when it wrote anything. */
export const holdReasonNote = (reason: CardHoldReason) => {
  switch (reason._tag) {
    case "RetryBackoff":
    case "RepeatedFailure":
      return reason.failure._tag === "Verification" ? verdictNote(reason.failure.verdict) : null;
    case "ReplanRequested":
      return reason.failure?._tag === "Verification" ? verdictNote(reason.failure.verdict) : null;
    case "GoalChanged":
      return reason.note;
    case "UpstreamRegressed":
      return verdictNote(reason.verdict);
    case "MergeConflict":
    case "UncertainEffect":
    case "DeadLettered":
      return null;
  }
};
