import { Match } from "effect";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import {
  DecisionAnswer,
  isApiError,
  type ApiErrorCode,
  type DecisionKind,
  type HumanDecisionRequest,
} from "../api";
import { useAnswerDecisionMutation } from "../queries/mutations/session";

interface AnswerOption {
  readonly answer: DecisionAnswer;
  readonly label: string;
}

/** What a request asks, from its safe metadata only. */
export function describeDecision(kind: DecisionKind) {
  return Match.valueTags(kind, {
    UncertainSideEffect: ({ toolNames }) => ({
      title: "결과를 알 수 없는 도구 실행",
      detail:
        toolNames.length > 0
          ? `도구 ${toolNames.join(", ")}의 실행 결과가 확인되지 않았어요. 실제로 반영됐는지 확인해 주세요.`
          : "이전 실행에서 결과가 확인되지 않은 도구가 있어요. 카드 작업 폴더에 실제로 반영됐는지 확인해 주세요.",
    }),
    IntegrationConflict: ({ files }) => ({
      title: "Goal 브랜치 통합 충돌",
      detail: `충돌한 파일: ${files.join(", ")}`,
    }),
    ImpactUnclear: ({ fromGoalVersion, toGoalVersion }) => ({
      title: "Goal 변경의 영향 판단",
      detail: `Goal v${fromGoalVersion} → v${toGoalVersion} 변경이 이 카드에 어떤 영향을 주는지 오케스트레이터가 판단하지 못했어요.`,
    }),
    RetryExhausted: ({ attempts }) => ({
      title: "시도를 모두 실패",
      detail: `${attempts}번 시도했지만 끝내지 못했어요.`,
    }),
    ProtectedBranchMerge: ({ targetBranch, prAvailable }) => ({
      title: "보호 브랜치 merge",
      detail: prAvailable
        ? `${targetBranch}는 보호 브랜치라 자동으로 merge하지 않아요. PR을 만들거나 직접 merge해 주세요.`
        : `${targetBranch}는 보호 브랜치라 자동으로 merge하지 않아요. gh가 없어 PR은 만들 수 없어요. Goal 브랜치를 남겨 두었으니 직접 merge해 주세요.`,
    }),
    MergeConflict: ({ targetBranch, files }) => ({
      title: "사용자 브랜치 merge 충돌",
      detail: `${targetBranch}를 Goal 브랜치에 merge하다 충돌했어요. 충돌한 파일: ${files.join(", ")}`,
    }),
    FileOverlap: ({ otherCardId, files }) => ({
      title: "다른 Goal과 파일 겹침",
      detail: `다른 Goal의 카드 ${otherCardId}가 같은 파일(${files.join(", ")})을 이미 바꿨지만 아직 merge되지 않았어요. 어느 쪽을 먼저 할지 정해 주세요.`,
    }),
  });
}

const answerOptions = (kind: DecisionKind): readonly AnswerOption[] =>
  Match.valueTags(kind, {
    UncertainSideEffect: () => [
      {
        answer: DecisionAnswer.UncertainSideEffect({ choice: "continue" }),
        label: "반영됨, 이어서 진행",
      },
      {
        answer: DecisionAnswer.UncertainSideEffect({ choice: "retry" }),
        label: "반영 안 됨, 다시 시도",
      },
      { answer: DecisionAnswer.UncertainSideEffect({ choice: "stop" }), label: "카드 멈춤" },
    ],
    IntegrationConflict: () => [
      {
        answer: DecisionAnswer.IntegrationConflict({ choice: "resolved" }),
        label: "직접 해결함, 다시 검증",
      },
      { answer: DecisionAnswer.IntegrationConflict({ choice: "rework" }), label: "카드 다시 작업" },
      { answer: DecisionAnswer.IntegrationConflict({ choice: "stop" }), label: "카드 멈춤" },
    ],
    ImpactUnclear: () => [
      { answer: DecisionAnswer.ImpactUnclear({ choice: "continue" }), label: "그대로 진행" },
      { answer: DecisionAnswer.ImpactUnclear({ choice: "replace" }), label: "새 카드로 대체" },
      { answer: DecisionAnswer.ImpactUnclear({ choice: "stop" }), label: "카드 멈춤" },
    ],
    RetryExhausted: () => [
      { answer: DecisionAnswer.RetryExhausted({ choice: "requeue" }), label: "다시 큐에 넣기" },
      { answer: DecisionAnswer.RetryExhausted({ choice: "stop" }), label: "카드 멈춤" },
    ],
    ProtectedBranchMerge: ({ prAvailable }) => [
      ...(prAvailable
        ? [
            {
              answer: DecisionAnswer.ProtectedBranchMerge({ choice: "create_pr" }),
              label: "PR 만들기",
            },
          ]
        : []),
      {
        answer: DecisionAnswer.ProtectedBranchMerge({ choice: "manual_merge" }),
        label: "직접 merge",
      },
    ],
    MergeConflict: () => [
      {
        answer: DecisionAnswer.MergeConflict({ choice: "resolved" }),
        label: "직접 해결함, 다시 merge",
      },
      { answer: DecisionAnswer.MergeConflict({ choice: "stop" }), label: "자동 merge 멈춤" },
    ],
    FileOverlap: () => [
      { answer: DecisionAnswer.FileOverlap({ choice: "wait" }), label: "다른 Goal merge 뒤에" },
      { answer: DecisionAnswer.FileOverlap({ choice: "proceed" }), label: "지금 진행" },
    ],
  });

const errorText = (code: ApiErrorCode) => {
  switch (code) {
    case "answer_conflict":
      return "이미 다른 답이 기록됐어요. 보드를 다시 확인해 주세요.";
    case "request_closed":
      return "이 결정 요청은 닫혔어요. 카드가 멈췄거나 실행이 취소됐어요.";
    case "goal_superseded":
      return "Goal이 바뀌어 이 결정 요청은 더 이상 쓰이지 않아요.";
    case "request_missing":
    case "request_mismatch":
      return "결정 요청을 찾을 수 없어요.";
    case "session_in_use":
      return "다른 창에서 이 대화를 쓰고 있어요.";
    case "kanban_storage_failed":
    case "workflow_storage_failed":
      return "답을 기록하거나 카드를 옮기지 못했어요. 잠시 뒤 다시 시도해 주세요.";
    default:
      return "답을 보내지 못했어요.";
  }
};

/** One card decision with its choices; the board and the project inbox both show it. */
export function DecisionPrompt({
  projectId,
  holder,
  request,
  disabled,
}: {
  readonly projectId: string;
  readonly holder: string;
  readonly request: HumanDecisionRequest;
  readonly disabled: boolean;
}) {
  const answer = useAnswerDecisionMutation(projectId, holder);
  const [error, setError] = useState<string | null>(null);
  const { title, detail } = describeDecision(request.kind);
  return (
    <div
      className="space-y-1.5 rounded-md border bg-background p-2"
      aria-label={title}
      role="group"
    >
      <p className="font-medium text-foreground">{title}</p>
      <p>{detail}</p>
      <div className="flex flex-wrap gap-1">
        {answerOptions(request.kind).map((option) => (
          <Button
            key={option.answer.choice}
            type="button"
            size="xs"
            variant="outline"
            disabled={disabled || answer.isPending}
            onClick={() => {
              setError(null);
              answer.mutate(
                { request, answer: option.answer },
                {
                  onError: (failure) =>
                    setError(
                      isApiError(failure) ? errorText(failure.code) : errorText("request_failed"),
                    ),
                },
              );
            }}
          >
            {option.label}
          </Button>
        ))}
      </div>
      {error !== null && (
        <p className="text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
