import type { MessageDescriptor } from "@lingui/core";
import { msg, ph } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
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
  readonly label: MessageDescriptor;
}

/** The one answer most decisions offer: leave the card stopped. */
const stopCard = msg({ message: "카드 멈춤", comment: "Decision answer: stop the card" });

/** What a request asks, from its safe metadata only. */
export function describeDecision(kind: DecisionKind): {
  readonly title: MessageDescriptor;
  readonly detail: MessageDescriptor;
} {
  return Match.valueTags(kind, {
    UncertainSideEffect: ({ toolNames }) => ({
      title: msg`결과를 알 수 없는 도구 실행`,
      detail:
        toolNames.length > 0
          ? msg`도구 ${ph({ tools: toolNames.join(", ") })}의 실행 결과가 확인되지 않았습니다. 실제로 반영됐는지 확인해 주십시오.`
          : msg`이전 실행에서 결과가 확인되지 않은 도구가 있습니다. 카드 작업 폴더에 실제로 반영됐는지 확인해 주십시오.`,
    }),
    IntegrationConflict: ({ files }) => ({
      title: msg`Goal 브랜치 통합 충돌`,
      detail: msg`카드가 충돌을 여러 번 풀었지만 Goal 브랜치와 다시 충돌했습니다. 카드 작업 폴더에 merge가 진행 중인 채로 남아 있습니다. 충돌한 파일: ${ph({ files: files.join(", ") })}`,
    }),
    ImpactUnclear: ({ fromGoalVersion, toGoalVersion }) => ({
      title: msg`Goal 변경의 영향 판단`,
      detail: msg`Goal v${fromGoalVersion} → v${toGoalVersion} 변경이 이 카드에 어떤 영향을 주는지 오케스트레이터가 판단하지 못했습니다.`,
    }),
    RetryExhausted: ({ attempts }) => ({
      title: msg`시도를 모두 실패`,
      detail: msg`${attempts}번 시도했지만 끝내지 못했습니다.`,
    }),
    ProtectedBranchMerge: ({ targetBranch, prAvailable }) => ({
      title: msg`보호 브랜치 merge`,
      detail: prAvailable
        ? msg`${targetBranch}는 보호 브랜치라 자동으로 merge하지 않습니다. PR을 만들거나 직접 merge해 주십시오.`
        : msg`${targetBranch}는 보호 브랜치라 자동으로 merge하지 않습니다. PR은 gh가 없어 만들 수 없습니다. Goal 브랜치를 남겨 두었으니 직접 merge해 주십시오.`,
    }),
    MergeConflict: ({ targetBranch, files }) => ({
      title: msg`사용자 브랜치 merge 충돌`,
      detail: msg`${targetBranch}를 Goal 브랜치에 merge하다 충돌했습니다. 충돌한 파일: ${ph({ files: files.join(", ") })}`,
    }),
    FileOverlap: ({ otherCardId, files }) => ({
      title: msg`다른 Goal과 파일 겹침`,
      detail: msg`다른 Goal의 카드 ${otherCardId}가 같은 파일(${ph({ files: files.join(", ") })})을 이미 바꿨지만 아직 merge되지 않았습니다. 어느 쪽을 먼저 할지 정해 주십시오.`,
    }),
  });
}

const answerOptions = (kind: DecisionKind): readonly AnswerOption[] =>
  Match.valueTags(kind, {
    UncertainSideEffect: () => [
      {
        answer: DecisionAnswer.UncertainSideEffect({ choice: "continue" }),
        label: msg({
          message: "반영됨, 이어서 진행",
          comment: "Decision answer: the uncertain tool call did take effect; go on",
        }),
      },
      {
        answer: DecisionAnswer.UncertainSideEffect({ choice: "retry" }),
        label: msg({
          message: "반영 안 됨, 다시 시도",
          comment: "Decision answer: the uncertain tool call did not take effect; run it again",
        }),
      },
      { answer: DecisionAnswer.UncertainSideEffect({ choice: "stop" }), label: stopCard },
    ],
    IntegrationConflict: () => [
      {
        answer: DecisionAnswer.IntegrationConflict({ choice: "resolved" }),
        label: msg({
          message: "직접 해결함, 다시 검증",
          comment: "Decision answer: the user resolved the conflict; verify again",
        }),
      },
      {
        answer: DecisionAnswer.IntegrationConflict({ choice: "rework" }),
        label: msg({ message: "카드 다시 작업", comment: "Decision answer: redo the card's work" }),
      },
      { answer: DecisionAnswer.IntegrationConflict({ choice: "stop" }), label: stopCard },
    ],
    ImpactUnclear: () => [
      {
        answer: DecisionAnswer.ImpactUnclear({ choice: "continue" }),
        label: msg({
          message: "그대로 진행",
          comment: "Decision answer: keep the card as it is after the Goal changed",
        }),
      },
      {
        answer: DecisionAnswer.ImpactUnclear({ choice: "replace" }),
        label: msg({
          message: "새 카드로 대체",
          comment: "Decision answer: replace the card with a new one",
        }),
      },
      { answer: DecisionAnswer.ImpactUnclear({ choice: "stop" }), label: stopCard },
    ],
    RetryExhausted: () => [
      {
        answer: DecisionAnswer.RetryExhausted({ choice: "requeue" }),
        label: msg({
          message: "다시 대기열에 넣기",
          comment: "Decision answer: put the card back in the queue",
        }),
      },
      { answer: DecisionAnswer.RetryExhausted({ choice: "stop" }), label: stopCard },
    ],
    ProtectedBranchMerge: ({ prAvailable }) => [
      ...(prAvailable
        ? [
            {
              answer: DecisionAnswer.ProtectedBranchMerge({ choice: "create_pr" }),
              label: msg({
                message: "PR 만들기",
                comment: "Decision answer: open a pull request instead of merging",
              }),
            },
          ]
        : []),
      {
        answer: DecisionAnswer.ProtectedBranchMerge({ choice: "manual_merge" }),
        label: msg({
          message: "직접 merge",
          comment: "Decision answer: the user merges the branch by hand",
        }),
      },
    ],
    MergeConflict: () => [
      {
        answer: DecisionAnswer.MergeConflict({ choice: "resolved" }),
        label: msg({
          message: "직접 해결함, 다시 merge",
          comment: "Decision answer: the user resolved the merge conflict; merge again",
        }),
      },
      {
        answer: DecisionAnswer.MergeConflict({ choice: "stop" }),
        label: msg({
          message: "자동 merge 멈춤",
          comment: "Decision answer: stop merging automatically",
        }),
      },
    ],
    FileOverlap: () => [
      {
        answer: DecisionAnswer.FileOverlap({ choice: "wait" }),
        label: msg({
          message: "다른 Goal merge 뒤에",
          comment: "Decision answer: run this card after the other Goal merges",
        }),
      },
      {
        answer: DecisionAnswer.FileOverlap({ choice: "proceed" }),
        label: msg({
          message: "지금 진행",
          comment: "Decision answer: go ahead now despite the overlap",
        }),
      },
    ],
  });

const errorText = (code: ApiErrorCode): MessageDescriptor => {
  switch (code) {
    case "answer_conflict":
      return msg`이미 다른 답이 기록됐습니다. 보드를 다시 확인해 주십시오.`;
    case "facts_changed":
      return msg`답을 고르는 동안 상황이 바뀌었습니다. 바뀐 내용을 확인하고 다시 골라 주십시오.`;
    case "request_closed":
      return msg`이 결정 요청은 닫혔습니다. 카드가 멈췄거나 실행이 취소됐습니다.`;
    case "goal_superseded":
      return msg`Goal이 바뀌어 이 결정 요청은 더 이상 쓰이지 않습니다.`;
    case "request_missing":
    case "request_mismatch":
      return msg`결정 요청을 찾을 수 없습니다.`;
    case "session_in_use":
      return msg`다른 창에서 이 대화를 쓰고 있습니다.`;
    case "kanban_storage_failed":
    case "workflow_storage_failed":
      return msg`답을 기록하거나 카드를 옮기지 못했습니다. 잠시 뒤 다시 시도해 주십시오.`;
    default:
      return msg`답을 보내지 못했습니다.`;
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
  const { t } = useLingui();
  const answer = useAnswerDecisionMutation(projectId, holder);
  const [error, setError] = useState<MessageDescriptor | null>(null);
  const description = describeDecision(request.kind);
  const title = t(description.title);
  return (
    <div
      className="space-y-1.5 rounded-md border bg-background p-2"
      aria-label={title}
      role="group"
    >
      <p className="font-medium text-foreground">{title}</p>
      <p>{t(description.detail)}</p>
      {request.factsChanged && (
        <p className="text-muted-foreground">
          <Trans>처음 물은 뒤 상황이 바뀌어 최신 내용으로 보여 줍니다.</Trans>
        </p>
      )}
      <div className="flex flex-wrap gap-1">
        {answerOptions(request.kind).map((option) => (
          <Button
            key={option.answer.choice}
            type="button"
            size="sm"
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
            {t(option.label)}
          </Button>
        ))}
      </div>
      {error !== null && (
        <p className="text-destructive" role="alert">
          {t(error)}
        </p>
      )}
    </div>
  );
}
