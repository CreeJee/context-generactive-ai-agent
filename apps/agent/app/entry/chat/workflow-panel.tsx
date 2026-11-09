import { isTruthy } from "../../truthy.ts";
import type { ReactNode } from "react";
import type { SessionRunState } from "memory-agent/definitions";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../../components/ui/alert-dialog";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { WorkflowExecutionState, type WorkflowMode, type WorkflowState } from "../api";
import { koreanLocalTime } from "../shared/local-time";

const localTime = (epochMillis: number) => koreanLocalTime(epochMillis);

/** The modes the composer offers: plain chat, or who approves the Plan (Plan or Goal). */
export const modeLabels: Readonly<Record<"chat" | WorkflowMode, string>> = {
  chat: "Chat",
  plan: "Plan",
  goal: "Goal",
};

/** The mode the composer shows: plain chat, or the mode a workflow shapes and runs in. */
export const composerModeOf = (state: WorkflowState | null): "chat" | WorkflowMode =>
  state === null || state.phase === "chat" ? "chat" : state.mode;

/** A completed workflow reads as done; any other as its mode. */
export function workflowModeLabel(state: WorkflowState): string {
  return state.phase === "completed" ? "완료" : modeLabels[composerModeOf(state)];
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

/** Where the workflow is, beside its mode in the panel title. */
export const stageLabels: Readonly<Record<Exclude<WorkflowState["phase"], "chat">, string>> = {
  shaping: "계획 중",
  running: "실행 중",
  completed: "완료",
};

/** What happens next, in the words of each stage and mode. */
const stageGuides: Readonly<Record<"shaping" | "running", Readonly<Record<WorkflowMode, string>>>> =
  {
    shaping: {
      plan: "요청을 입력하면 프로젝트를 바꾸지 않고 조사해서 Plan을 만들어요. 승인하면 칸반 보드에서 카드로 실행해요.",
      goal: "달성할 결과를 입력하면 계획자가 카드를 만들어 바로 실행해요. 결과가 모두 확인되면 Goal이 끝나요.",
    },
    running: {
      plan: "보드가 카드를 실행하고 결과마다 확인해요. 계획자가 더한 카드는 승인한 뒤에 돌아요.",
      goal: "보드가 카드를 실행하고 결과마다 확인해요. 결과가 모두 확인될 때까지 계획자가 카드를 더해요.",
    },
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
  /** Revising a running Plan asks first: the board stops taking cards until it is approved. */
  readonly onRevise: () => void;
  readonly onExecute: () => void;
  /** The board's loop runs the cards, so there is no Plan to start from the chat. */
  readonly kanbanRunning: boolean;
  readonly boardSlot?: ReactNode;
}) {
  if (state === null || state.phase === "chat") return null;
  const { goal, plan, phase, mode } = state;
  const completed = phase === "completed";
  const execute = actions?.moves.run;
  const continuing = execute?.allowed === true && execute.intent === "continue";
  const outdated = execute !== undefined && !execute.allowed && execute.reason === "plan_outdated";
  const paused = goal?.status === "paused";
  const resumable = actions?.controls.resume.allowed === true;
  return (
    <Alert>
      <AlertTitle>
        <span className="flex flex-wrap items-center gap-2">
          <span>
            {modeLabels[mode]} · {stageLabels[phase]}
          </span>
          {paused && <Badge variant="outline">{goalStatusLabels.paused}</Badge>}
          {goal?.status === "failed" && (
            <Badge variant="destructive">{goalStatusLabels.failed}</Badge>
          )}
        </span>
      </AlertTitle>
      <AlertDescription>
        <div className="space-y-3">
          {isTruthy(goal) && <p className="font-medium text-foreground">{goal.statement}</p>}
          {completed ? (
            isTruthy(goal) &&
            goal.verification.status !== "not_run" && (
              <p>
                검증 {verificationStatusLabels[goal.verification.status]} ·{" "}
                {goal.verification.summary}
              </p>
            )
          ) : (
            <p className="text-muted-foreground">
              {phase === "shaping" && mode === "plan" && isTruthy(plan)
                ? "Plan을 확인하고 승인하면 칸반 보드에서 실행해요. 바꾸고 싶은 점은 그대로 입력하세요."
                : stageGuides[phase][mode]}
            </p>
          )}
          {isTruthy(display) && <p role="status">{displayTexts[display]}</p>}
          {WorkflowExecutionState.$is("blocked")(execution) && (
            <p className="whitespace-pre-wrap" role="status">
              자동 진행 중단: {execution.detail}
            </p>
          )}
          {WorkflowExecutionState.$is("retrying")(execution) ? (
            <p role="status">
              서버가 다시 시작돼 끊긴 실행을 {localTime(execution.retryAt)}에 이어서 진행해요.
            </p>
          ) : (
            isTruthy(providerRetry) && (
              <p role="status">
                공급자에 요청을 보내지 못해 {localTime(providerRetry.retryAt)}에 다시 보내요 (
                {providerRetry.retry}번째 재시도).
              </p>
            )
          )}
          {(isTruthy(goal) || isTruthy(plan)) && boardSlot}
          {outdated && (
            <p className="text-destructive">Goal이 변경되어 이 계획을 다시 확인해야 해요.</p>
          )}
          {!completed && (isTruthy(plan) || isTruthy(goal)) && (
            <div className="flex flex-wrap gap-2">
              {/* Goal mode approves its planner's Plan by itself; a Plan left without a board can still move onto one. */}
              {isTruthy(plan) && !kanbanRunning && (mode === "plan" || continuing) && (
                <Button
                  type="button"
                  size="sm"
                  disabled={execute?.allowed !== true || busy || disabled || controlling}
                  onClick={onExecute}
                >
                  {continuing ? "보드에서 이어서 실행" : "승인하고 실행"}
                </Button>
              )}
              {isTruthy(plan) && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={
                    actions?.moves[mode].allowed !== true || busy || disabled || controlling
                  }
                  onClick={onRevise}
                >
                  Plan 수정
                </Button>
              )}
              {isTruthy(goal) && (
                <>
                  {resumable || paused ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={!resumable || disabled || controlling || busy}
                      onClick={onResume}
                    >
                      계속
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={actions?.controls.pause.allowed !== true || disabled || controlling}
                      onClick={onPause}
                    >
                      일시 중지
                    </Button>
                  )}
                  <AlertDialog>
                    <AlertDialogTrigger
                      render={
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          disabled={
                            actions?.controls.stop.allowed !== true || disabled || controlling
                          }
                        />
                      }
                    >
                      중단
                    </AlertDialogTrigger>
                    <AlertDialogContent size="sm">
                      <AlertDialogHeader>
                        <AlertDialogTitle>이 Goal을 중단할까요?</AlertDialogTitle>
                        <AlertDialogDescription>
                          중단한 Goal은 다시 계속할 수 없어요. 잠시 멈추려면 일시 중지를 쓰세요.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>그만두기</AlertDialogCancel>
                        <AlertDialogAction variant="destructive" onClick={onStop}>
                          중단
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </>
              )}
            </div>
          )}
        </div>
      </AlertDescription>
    </Alert>
  );
}
