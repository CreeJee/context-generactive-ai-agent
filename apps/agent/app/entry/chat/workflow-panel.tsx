import { isTruthy } from "../../truthy.ts";
import type { ReactNode } from "react";
import type { SessionRunState } from "memory-agent/definitions";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { WorkflowExecutionState, type WorkflowPhase, type WorkflowState } from "../api";
import { koreanLocalTime } from "../shared/local-time";

const localTime = (epochMillis: number) => koreanLocalTime(epochMillis);

export const phaseLabels: Readonly<Record<WorkflowPhase, string>> = {
  chat: "Chat",
  goal: "Goal",
  plan: "Plan",
  execute: "Execute",
  verify: "Verify",
  completed: "완료",
};

/** A closed Verify phase is a completed workflow, not ongoing verification. */
export function workflowModeLabel(state: WorkflowState): string {
  return state.phase === "verify" &&
    state.goal?.status === "completed" &&
    state.plan?.status === "completed" &&
    state.plan.verification.status === "passed"
    ? "완료"
    : phaseLabels[state.phase];
}

export const goalStatusLabels: Record<NonNullable<WorkflowState["goal"]>["status"], string> = {
  draft: "준비 중",
  active: "진행 중",
  paused: "일시 중지",
  completed: "완료",
  failed: "중단됨",
};

export const planStatusLabels: Record<NonNullable<WorkflowState["plan"]>["status"], string> = {
  draft: "작성 중",
  ready: "준비 완료",
  executing: "실행 중",
  completed: "완료",
  blocked: "막힘",
  closed: "닫음",
};

const verificationStatusLabels: Record<
  NonNullable<WorkflowState["plan"]>["verification"]["status"],
  string
> = {
  not_run: "미실행",
  passed: "통과",
  failed: "구현 실패",
  invalid_hypothesis: "가설 무효",
  invalid_criterion: "검증 조건 무효",
  inconclusive: "판정 불가",
  blocked: "외부 요인으로 막힘",
};

/** What each `display` note says. */
const displayTexts: Readonly<Record<NonNullable<SessionRunState["display"]>, string>> = {
  card_reclassifying: "Goal이 바뀌어 카드를 다시 분류하는 중이에요.",
};

export function WorkflowArtifactPanel({
  state,
  display,
  execution,
  providerRetry,
  actions,
  busy,
  disabled,
  controlling,
  onPause,
  onResume,
  onStop,
  onRevise,
  onExecute,
  kanbanRunning,
  boardSlot,
}: {
  readonly state: WorkflowState | null;
  readonly display?: SessionRunState["display"];
  readonly execution?: SessionRunState["execution"] | null;
  readonly providerRetry?: SessionRunState["providerRetry"];
  readonly actions: SessionRunState["actions"] | null;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly controlling: boolean;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onStop: () => void;
  readonly onRevise: () => void;
  readonly onExecute: () => void;
  /** The board's loop runs the cards, so there is no Plan to continue from the chat. */
  readonly kanbanRunning: boolean;
  readonly boardSlot?: ReactNode;
}) {
  if (!(state !== null) || state.phase === "chat") return null;
  if (state.phase === "goal") {
    return (
      <Alert>
        <AlertTitle>
          {isTruthy(state.goal)
            ? `Goal v${state.goal.version} · ${goalStatusLabels[state.goal.status]}`
            : "Goal"}
        </AlertTitle>
        <AlertDescription>
          <p>
            {state.goal?.statement ??
              "달성할 결과를 입력하면 조사부터 수정과 검증까지 자율적으로 진행해요."}
          </p>
          {state.goal && state.goal.evidence.length > 0 && (
            <ul className="mt-3 list-disc space-y-1 pl-5">
              {state.goal.evidence.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
          {state.goal && state.goal.verification.status !== "not_run" && (
            <p className="mt-3">
              검증 {verificationStatusLabels[state.goal.verification.status]} ·{" "}
              {state.goal.verification.summary}
            </p>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              disabled={
                !isTruthy(actions?.controls.resume.allowed) || disabled || controlling || busy
              }
              onClick={onResume}
            >
              계속
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!isTruthy(actions?.controls.pause.allowed) || disabled || controlling}
              onClick={onPause}
            >
              일시 중지
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={!isTruthy(actions?.controls.stop.allowed) || disabled || controlling}
              onClick={onStop}
            >
              중단
            </Button>
          </div>
        </AlertDescription>
      </Alert>
    );
  }

  const plan = state.plan;
  if (!isTruthy(plan)) {
    if (state.phase !== "plan") return null;
    return (
      <Alert>
        <AlertTitle>Plan</AlertTitle>
        <AlertDescription>
          요청을 입력하면 프로젝트를 변경하지 않고 조사해서 실행 계획을 만들어요.
        </AlertDescription>
      </Alert>
    );
  }

  const execute = actions?.phases.execute;
  const continuingImplementation = execute?.allowed && execute.intent === "continue";
  const outdated = execute && !execute.allowed && execute.reason === "plan_outdated";
  return (
    <Alert>
      <AlertTitle>
        {state.phase === "verify" && plan.status === "executing"
          ? "검증 중"
          : planStatusLabels[plan.status]}
      </AlertTitle>
      <AlertDescription>
        {isTruthy(display) && (
          <p className="mb-3" role="status">
            {displayTexts[display]}
          </p>
        )}
        {WorkflowExecutionState.$is("blocked")(execution) && (
          <p className="mb-3 whitespace-pre-wrap" role="status">
            자동 진행 중단: {execution.detail}
          </p>
        )}
        {WorkflowExecutionState.$is("retrying")(execution) ? (
          <p className="mb-3" role="status">
            서버가 다시 시작돼 끊긴 실행을 {localTime(execution.retryAt)}에 남은 단계부터 이어서
            진행해요.
          </p>
        ) : (
          isTruthy(providerRetry) && (
            <p className="mb-3" role="status">
              공급자에 요청을 보내지 못해 {localTime(providerRetry.retryAt)}에 다시 보내요 (
              {providerRetry.retry}번째 재시도).
            </p>
          )
        )}
        {boardSlot}
        {outdated && (
          <p className="mt-3 text-destructive">Goal이 변경되어 이 계획을 다시 확인해야 해요.</p>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!isTruthy(actions?.phases.plan.allowed) || busy || disabled || controlling}
            onClick={onRevise}
          >
            수정 요청
          </Button>
          {!kanbanRunning && (
            <Button
              type="button"
              size="sm"
              disabled={!isTruthy(execute?.allowed) || busy || disabled || controlling}
              onClick={onExecute}
            >
              {isTruthy(continuingImplementation) ? "구현 계속" : "계획 실행"}
            </Button>
          )}
        </div>
      </AlertDescription>
    </Alert>
  );
}
