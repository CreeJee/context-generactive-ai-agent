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
import { chatCopy } from "./copy";

const copy = chatCopy.decision;
const kinds = copy.kinds;
const answers = copy.answers;

interface AnswerOption {
  readonly answer: DecisionAnswer;
  readonly label: string;
}

/** What a request asks, from its safe metadata only. */
export function describeDecision(kind: DecisionKind) {
  return Match.valueTags(kind, {
    UncertainSideEffect: ({ toolNames }) => ({
      title: kinds.UncertainSideEffect.title,
      detail:
        toolNames.length > 0
          ? kinds.UncertainSideEffect.detail(toolNames.join(", "))
          : kinds.UncertainSideEffect.detailWithoutTools,
    }),
    IntegrationConflict: ({ files }) => ({
      title: kinds.IntegrationConflict.title,
      detail: kinds.IntegrationConflict.detail(files.join(", ")),
    }),
    ImpactUnclear: ({ fromGoalVersion, toGoalVersion }) => ({
      title: kinds.ImpactUnclear.title,
      detail: kinds.ImpactUnclear.detail(fromGoalVersion, toGoalVersion),
    }),
    RetryExhausted: ({ attempts }) => ({
      title: kinds.RetryExhausted.title,
      detail: kinds.RetryExhausted.detail(attempts),
    }),
    ProtectedBranchMerge: ({ targetBranch, prAvailable }) => ({
      title: kinds.ProtectedBranchMerge.title,
      detail: prAvailable
        ? kinds.ProtectedBranchMerge.detail(targetBranch)
        : kinds.ProtectedBranchMerge.detailWithoutPr(targetBranch),
    }),
    MergeConflict: ({ targetBranch, files }) => ({
      title: kinds.MergeConflict.title,
      detail: kinds.MergeConflict.detail(targetBranch, files.join(", ")),
    }),
    FileOverlap: ({ otherCardId, files }) => ({
      title: kinds.FileOverlap.title,
      detail: kinds.FileOverlap.detail(otherCardId, files.join(", ")),
    }),
  });
}

const answerOptions = (kind: DecisionKind): readonly AnswerOption[] =>
  Match.valueTags(kind, {
    UncertainSideEffect: () => [
      {
        answer: DecisionAnswer.UncertainSideEffect({ choice: "continue" }),
        label: answers.UncertainSideEffect.continue,
      },
      {
        answer: DecisionAnswer.UncertainSideEffect({ choice: "retry" }),
        label: answers.UncertainSideEffect.retry,
      },
      {
        answer: DecisionAnswer.UncertainSideEffect({ choice: "stop" }),
        label: answers.UncertainSideEffect.stop,
      },
    ],
    IntegrationConflict: () => [
      {
        answer: DecisionAnswer.IntegrationConflict({ choice: "resolved" }),
        label: answers.IntegrationConflict.resolved,
      },
      {
        answer: DecisionAnswer.IntegrationConflict({ choice: "rework" }),
        label: answers.IntegrationConflict.rework,
      },
      {
        answer: DecisionAnswer.IntegrationConflict({ choice: "stop" }),
        label: answers.IntegrationConflict.stop,
      },
    ],
    ImpactUnclear: () => [
      {
        answer: DecisionAnswer.ImpactUnclear({ choice: "continue" }),
        label: answers.ImpactUnclear.continue,
      },
      {
        answer: DecisionAnswer.ImpactUnclear({ choice: "replace" }),
        label: answers.ImpactUnclear.replace,
      },
      {
        answer: DecisionAnswer.ImpactUnclear({ choice: "stop" }),
        label: answers.ImpactUnclear.stop,
      },
    ],
    RetryExhausted: () => [
      {
        answer: DecisionAnswer.RetryExhausted({ choice: "requeue" }),
        label: answers.RetryExhausted.requeue,
      },
      {
        answer: DecisionAnswer.RetryExhausted({ choice: "stop" }),
        label: answers.RetryExhausted.stop,
      },
    ],
    ProtectedBranchMerge: ({ prAvailable }) => [
      ...(prAvailable
        ? [
            {
              answer: DecisionAnswer.ProtectedBranchMerge({ choice: "create_pr" }),
              label: answers.ProtectedBranchMerge.create_pr,
            },
          ]
        : []),
      {
        answer: DecisionAnswer.ProtectedBranchMerge({ choice: "manual_merge" }),
        label: answers.ProtectedBranchMerge.manual_merge,
      },
    ],
    MergeConflict: () => [
      {
        answer: DecisionAnswer.MergeConflict({ choice: "resolved" }),
        label: answers.MergeConflict.resolved,
      },
      {
        answer: DecisionAnswer.MergeConflict({ choice: "stop" }),
        label: answers.MergeConflict.stop,
      },
    ],
    FileOverlap: () => [
      { answer: DecisionAnswer.FileOverlap({ choice: "wait" }), label: answers.FileOverlap.wait },
      {
        answer: DecisionAnswer.FileOverlap({ choice: "proceed" }),
        label: answers.FileOverlap.proceed,
      },
    ],
  });

const errorText = (code: ApiErrorCode) => {
  switch (code) {
    case "answer_conflict":
      return copy.errors.answerConflict;
    case "facts_changed":
      return copy.errors.factsChanged;
    case "request_closed":
      return copy.errors.requestClosed;
    case "goal_superseded":
      return copy.errors.goalSuperseded;
    case "request_missing":
    case "request_mismatch":
      return copy.errors.requestMissing;
    case "session_in_use":
      return copy.errors.sessionInUse;
    case "kanban_storage_failed":
    case "workflow_storage_failed":
      return copy.errors.storageFailed;
    default:
      return copy.errors.failed;
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
      {request.factsChanged && <p className="text-muted-foreground">{copy.factsChanged}</p>}
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
