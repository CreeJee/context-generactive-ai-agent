import { ChevronRightIcon } from "lucide-react";
import type { SessionRunState } from "memory-agent/definitions";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";
import type { WorkflowPhase, WorkflowState } from "./api";

export const phaseLabels: Readonly<Record<WorkflowPhase, string>> = {
  chat: "Chat",
  goal: "Goal",
  plan: "Plan",
  execute: "Execute",
  verify: "Verify",
};

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
};

const stepStatusLabels: Record<
  NonNullable<WorkflowState["plan"]>["steps"][number]["status"],
  string
> = {
  pending: "대기",
  in_progress: "진행 중",
  completed: "완료",
  blocked: "막힘",
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

export function WorkflowArtifactPanel({
  state,
  actions,
  busy,
  disabled,
  controlling,
  onPause,
  onResume,
  onStop,
  onRevise,
  onExecute,
}: {
  readonly state: WorkflowState | null;
  readonly actions: SessionRunState["actions"] | null;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly controlling: boolean;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onStop: () => void;
  readonly onRevise: () => void;
  readonly onExecute: () => void;
}) {
  if (!state || state.phase === "chat") return null;
  if (state.phase === "goal") {
    return (
      <Alert>
        <AlertTitle>
          {state.goal
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
              disabled={!actions?.controls.resume.allowed || disabled || controlling || busy}
              onClick={onResume}
            >
              계속
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!actions?.controls.pause.allowed || disabled || controlling}
              onClick={onPause}
            >
              일시 중지
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={!actions?.controls.stop.allowed || disabled || controlling}
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
  if (!plan) {
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
  const completedSteps = plan.steps.filter((step) => step.status === "completed").length;
  const activeStep =
    plan.steps.find((step) => step.status === "in_progress") ??
    plan.steps.find((step) => step.status === "blocked") ??
    plan.steps.find((step) => step.status === "pending");
  const activeStepLabel =
    activeStep?.status === "in_progress"
      ? "현재"
      : activeStep?.status === "blocked"
        ? "막힘"
        : "다음";
  return (
    <Alert>
      <AlertTitle>
        Plan v{plan.version} ·{" "}
        {state.phase === "verify" ? "검증 중" : planStatusLabels[plan.status]}
      </AlertTitle>
      <AlertDescription>
        <Collapsible className="rounded-md border bg-background/50">
          <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-2 text-left">
            <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground group-data-[panel-open]:rotate-90" />
            <span className="shrink-0 font-medium">
              단계 {completedSteps}/{plan.steps.length}
            </span>
            {activeStep && (
              <span className="min-w-0 truncate text-muted-foreground">
                {activeStepLabel}: {activeStep.title}
              </span>
            )}
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">계획 내용</span>
          </CollapsibleTrigger>
          <CollapsibleContent className="max-h-80 space-y-3 overflow-y-auto border-t px-3 py-3">
            <p className="whitespace-pre-wrap">{plan.summary}</p>
            {plan.steps.length > 0 && (
              <ol className="list-decimal space-y-1.5 pl-5">
                {plan.steps.map((step) => (
                  <li key={step.id}>
                    {step.title} · {stepStatusLabels[step.status]}
                    {step.evidence.length > 0 && (
                      <ul className="list-disc pl-5 text-muted-foreground">
                        {step.evidence.map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ol>
            )}
            {plan.verification.status !== "not_run" && (
              <p>
                검증 {verificationStatusLabels[plan.verification.status]} ·{" "}
                {plan.verification.summary}
              </p>
            )}
          </CollapsibleContent>
        </Collapsible>
        {outdated && (
          <p className="mt-3 text-destructive">Goal이 변경되어 이 계획을 다시 확인해야 해요.</p>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!actions?.phases.plan.allowed || busy || disabled || controlling}
            onClick={onRevise}
          >
            수정 요청
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!execute?.allowed || busy || disabled || controlling}
            onClick={onExecute}
          >
            {continuingImplementation ? "구현 계속" : "계획 실행"}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
