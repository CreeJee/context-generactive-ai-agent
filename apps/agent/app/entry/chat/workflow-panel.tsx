import { i18n, type MessageDescriptor } from "@lingui/core";
import { msg, ph } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { isTruthy } from "../../truthy.ts";
import type { ReactNode } from "react";
import type { SessionRunState } from "memory-agent/definitions";
import { Match } from "effect";
import {
  ChevronDownIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleHelpIcon,
  CircleXIcon,
  ClockIcon,
  ListChecksIcon,
  LoaderCircleIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  RefreshCwIcon,
  SquareIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "cn";
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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../components/ui/collapsible";
import { WorkflowExecutionState, type WorkflowMode, type WorkflowState } from "../api";
import { koreanLocalTime } from "../shared/local-time";
import { WorkflowRow, WorkflowRows } from "./workflow-rows";

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

const completedModeLabel = msg({
  message: "완료",
  comment: "Shown in place of the workflow mode (Plan, Goal) once the workflow has finished",
});

/** A completed workflow reads as done; any other as its mode. */
export function workflowModeLabel(state: WorkflowState): string {
  return state.phase === "completed"
    ? i18n._(completedModeLabel)
    : modeLabels[composerModeOf(state)];
}

export const goalStatusLabels = {
  draft: msg({ message: "준비 중", comment: "Goal status: not started yet" }),
  active: msg({ message: "진행 중", comment: "Goal status: being worked on" }),
  paused: msg({ message: "일시 중지", comment: "Goal status: paused by the user" }),
  completed: msg({ message: "완료", comment: "Goal status: finished" }),
  failed: msg({ message: "중단됨", comment: "Goal status: stopped for good" }),
} satisfies Record<NonNullable<WorkflowState["goal"]>["status"], MessageDescriptor>;

export const planStatusLabels = {
  draft: msg({ message: "작성 중", comment: "Plan status: still being written" }),
  ready: msg({ message: "준비 완료", comment: "Plan status: ready to approve and run" }),
  executing: msg({ message: "실행 중", comment: "Plan status: its cards are running" }),
  completed: msg({ message: "완료", comment: "Plan status: finished" }),
  blocked: msg({ message: "막힘", comment: "Plan status: cannot go on" }),
  closed: msg({ message: "닫음", comment: "Plan status: closed by the user" }),
} satisfies Record<NonNullable<WorkflowState["plan"]>["status"], MessageDescriptor>;

const verificationStatusLabels = {
  not_run: msg({ message: "미실행", comment: "Goal verification status: not run" }),
  passed: msg({ message: "통과", comment: "Goal verification status: passed" }),
  failed: msg({
    message: "구현 실패",
    comment: "Goal verification status: the implementation failed the check",
  }),
  invalid_hypothesis: msg({
    message: "가설 무효",
    comment: "Goal verification status: the hypothesis being checked was wrong",
  }),
  invalid_criterion: msg({
    message: "검증 조건 무효",
    comment: "Goal verification status: the check itself was wrong",
  }),
  inconclusive: msg({
    message: "판정 불가",
    comment: "Goal verification status: the check could not decide",
  }),
  blocked: msg({
    message: "외부 요인으로 막힘",
    comment: "Goal verification status: something outside the project kept the check from running",
  }),
} satisfies Record<NonNullable<WorkflowState["plan"]>["verification"]["status"], MessageDescriptor>;

/** What each `display` note says. */
const displayTexts = {
  card_reclassifying: msg`Goal이 바뀌어 카드를 다시 분류하는 중입니다.`,
} satisfies Record<NonNullable<SessionRunState["display"]>, MessageDescriptor>;

/** Where the workflow is, beside its mode in the panel title. */
export const stageLabels = {
  shaping: msg({
    message: "Plan 작성 중",
    comment: "Workflow stage after the mode: writing the Plan",
  }),
  running: msg({ message: "실행 중", comment: "Workflow stage after the mode: running the cards" }),
  completed: msg({ message: "완료", comment: "Workflow stage after the mode: finished" }),
} satisfies Record<Exclude<WorkflowState["phase"], "chat">, MessageDescriptor>;

/** What happens next, in the words of each stage and mode. */
const stageGuides = {
  shaping: {
    plan: msg`요청을 입력하면 프로젝트를 바꾸지 않고 조사한 뒤 Plan을 만듭니다. 승인하면 칸반 보드에서 카드로 실행합니다.`,
    goal: msg`달성할 결과를 입력하면 그에 맞는 카드를 Plan 작성자가 만들어 바로 실행합니다. Goal은 결과가 모두 확인되면 끝납니다.`,
  },
  running: {
    plan: msg`보드가 카드를 실행하고 결과마다 확인합니다. Plan 작성자가 더한 카드는 승인한 뒤에 실행됩니다.`,
    goal: msg`보드가 카드를 실행하고 결과마다 확인합니다. 결과가 모두 확인될 때까지 Plan 작성자가 카드를 더합니다.`,
  },
} satisfies Record<"shaping" | "running", Record<WorkflowMode, MessageDescriptor>>;

/** What the bar's icon says about the stage at a glance. */
function StageIcon({ state }: { readonly state: WorkflowState }) {
  if (state.goal?.status === "failed")
    return <CircleXIcon aria-hidden className="size-3.5 shrink-0 text-destructive" />;
  if (state.goal?.status === "paused")
    return <PauseIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />;
  return Match.value(state.phase).pipe(
    Match.when("completed", () => (
      <CircleCheckIcon aria-hidden className="size-3.5 shrink-0 text-primary" />
    )),
    Match.when("running", () => (
      <LoaderCircleIcon aria-hidden className="size-3.5 shrink-0 animate-spin text-primary" />
    )),
    Match.orElse(() => <ListChecksIcon aria-hidden className="size-3.5 shrink-0 text-primary" />),
  );
}

/** One line under the bar's head: something the server is doing about the run. */
function NoticeRow({
  icon: Icon,
  text,
  destructive = false,
}: {
  readonly icon: LucideIcon;
  readonly text: string;
  readonly destructive?: boolean;
}) {
  return (
    <p
      role="status"
      title={text}
      className={cn(
        "flex min-w-0 items-center gap-2 px-3 text-xs",
        destructive ? "text-destructive" : "text-muted-foreground",
      )}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{text}</span>
    </p>
  );
}

/** The Plan's open questions and risks, one line each. */
function PlanNotes({ plan }: { readonly plan: NonNullable<WorkflowState["plan"]> }) {
  const { t } = useLingui();
  return (
    <>
      {plan.openQuestions.length > 0 && (
        <WorkflowRows label={t`열린 질문 ${ph({ count: plan.openQuestions.length })}`}>
          {plan.openQuestions.map((question) => (
            <WorkflowRow
              key={question}
              title={question}
              icon={<CircleHelpIcon aria-hidden className="size-3.5 text-warning" />}
            >
              {question}
            </WorkflowRow>
          ))}
        </WorkflowRows>
      )}
      {plan.risks.length > 0 && (
        <WorkflowRows label={t`위험 ${ph({ count: plan.risks.length })}`}>
          {plan.risks.map((risk) => (
            <WorkflowRow
              key={risk}
              title={risk}
              icon={<TriangleAlertIcon aria-hidden className="size-3.5 text-muted-foreground" />}
            >
              {risk}
            </WorkflowRow>
          ))}
        </WorkflowRows>
      )}
    </>
  );
}

/**
 * The workflow as one line above the composer: its mode and stage, the Goal, how far the board
 * is, and the next step. Unfolded, it lists the Goal, the outcomes, the cards and the Plan's notes
 * one line each, scrolling inside its own height, with the less frequent controls at its foot.
 */
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
  boardTally,
  boardAction,
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
  /** The board unfolded: outcomes and cards, one line each. */
  readonly boardSlot?: ReactNode;
  /** The board's numbers on the bar's line. */
  readonly boardTally?: ReactNode;
  /** Opens the whole board. */
  readonly boardAction?: ReactNode;
}) {
  const { t } = useLingui();
  if (state === null || state.phase === "chat") return null;
  const { goal, plan, phase, mode } = state;
  const completed = phase === "completed";
  const hasWork = isTruthy(goal) || isTruthy(plan);
  const execute = actions?.moves.run;
  const continuing = execute?.allowed === true && execute.intent === "continue";
  const outdated = execute !== undefined && !execute.allowed && execute.reason === "plan_outdated";
  const paused = goal?.status === "paused";
  const resumable = actions?.controls.resume.allowed === true;
  const verification = goal?.verification;
  // A Plan waiting for approval is read before it is approved, so it opens unfolded; each new
  // version of it opens again.
  const reviewing = phase === "shaping" && mode === "plan" && isTruthy(plan);
  const executable =
    !completed && isTruthy(plan) && !kanbanRunning && (mode === "plan" || continuing);
  const resuming = !completed && isTruthy(goal) && (resumable || paused);
  return (
    <section
      aria-label={t({
        message: "워크플로",
        comment: "Accessible name of the workflow bar above the composer",
      })}
      className="mb-2 rounded-xl border bg-card text-xs shadow-xs"
    >
      <Collapsible key={`${phase}:${plan?.version ?? 0}`} defaultOpen={reviewing}>
        <div className="flex min-h-9 items-center gap-1 p-1">
          <CollapsibleTrigger className="group flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors outline-none hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50">
            <StageIcon state={state} />
            <span className="shrink-0 font-medium">
              {modeLabels[mode]} · {t(stageLabels[phase])}
            </span>
            {paused && <Badge variant="outline">{t(goalStatusLabels.paused)}</Badge>}
            {goal?.status === "failed" && (
              <Badge variant="destructive">{t(goalStatusLabels.failed)}</Badge>
            )}
            {isTruthy(goal) && (
              <span className="min-w-0 truncate text-muted-foreground">{goal.statement}</span>
            )}
            <span className="ml-auto flex shrink-0 items-center gap-2">
              {hasWork && boardTally}
              <ChevronDownIcon
                aria-hidden
                className="size-3.5 text-muted-foreground transition-transform group-data-[panel-open]:rotate-180"
              />
            </span>
          </CollapsibleTrigger>
          {/* Goal mode approves its planner's Plan by itself; a Plan left without a board can still move onto one. */}
          {executable && (
            <Button
              type="button"
              size="sm"
              disabled={execute?.allowed !== true || busy || disabled || controlling}
              onClick={onExecute}
            >
              <PlayIcon data-icon="inline-start" />
              {continuing ? (
                <Trans comment="Button: keep running an approved Plan on the kanban board">
                  보드에서 이어서 실행
                </Trans>
              ) : (
                <Trans comment="Button: approve the Plan and run it on the kanban board">
                  승인하고 실행
                </Trans>
              )}
            </Button>
          )}
          {resuming && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!resumable || disabled || controlling || busy}
              onClick={onResume}
            >
              <PlayIcon data-icon="inline-start" />
              <Trans comment="Button: resume a paused Goal">계속</Trans>
            </Button>
          )}
          {hasWork && boardAction}
        </div>
        {(isTruthy(display) ||
          WorkflowExecutionState.$is("blocked")(execution) ||
          WorkflowExecutionState.$is("retrying")(execution) ||
          isTruthy(providerRetry) ||
          outdated) && (
          <div className="flex flex-col gap-1 pb-2">
            {isTruthy(display) && (
              <NoticeRow icon={RefreshCwIcon} text={t(displayTexts[display])} />
            )}
            {WorkflowExecutionState.$is("blocked")(execution) && (
              <NoticeRow
                icon={CircleAlertIcon}
                destructive
                text={t`자동 진행 중단: ${ph({ detail: execution.detail })}`}
              />
            )}
            {WorkflowExecutionState.$is("retrying")(execution) ? (
              <NoticeRow
                icon={ClockIcon}
                text={t`서버가 다시 시작돼 끊긴 실행을 ${ph({ time: localTime(execution.retryAt) })}에 이어서 진행합니다.`}
              />
            ) : (
              isTruthy(providerRetry) && (
                <NoticeRow
                  icon={ClockIcon}
                  text={t`공급자에 요청을 보내지 못했습니다. ${ph({ time: localTime(providerRetry.retryAt) })}에 다시 보냅니다(${ph({ attempt: providerRetry.retry })}번째 재시도).`}
                />
              )
            )}
            {outdated && (
              <NoticeRow
                icon={TriangleAlertIcon}
                destructive
                text={t`Goal이 변경되어 이 Plan을 다시 확인해야 합니다.`}
              />
            )}
          </div>
        )}
        {/* Kept mounted so the controls exist, folded, for the keyboard and for tests. */}
        <CollapsibleContent keepMounted className="border-t">
          <div className="flex max-h-[min(24rem,40dvh)] flex-col gap-3 overflow-y-auto p-2">
            {!completed && (
              <p className="px-1.5 text-muted-foreground">
                {reviewing ? (
                  <Trans>
                    Plan을 확인하고 승인하면 칸반 보드에서 실행합니다. 바꾸고 싶은 점은 그대로
                    입력해 주십시오.
                  </Trans>
                ) : (
                  t(stageGuides[phase][mode])
                )}
              </p>
            )}
            {(isTruthy(goal) || (isTruthy(plan) && plan.summary.length > 0)) && (
              <div className="flex flex-col gap-0.5 px-1.5">
                {isTruthy(goal) && <p className="font-medium">{goal.statement}</p>}
                {isTruthy(plan) && plan.summary.length > 0 && (
                  <p className="whitespace-pre-wrap text-muted-foreground">{plan.summary}</p>
                )}
              </div>
            )}
            {completed && isTruthy(verification) && verification.status !== "not_run" && (
              <Alert
                role="status"
                variant={verification.status === "passed" ? "default" : "destructive"}
              >
                {verification.status === "passed" ? <CircleCheckIcon /> : <CircleAlertIcon />}
                <AlertTitle>
                  {t({
                    message: `검증 ${ph({ status: t(verificationStatusLabels[verification.status]) })}`,
                    comment: "Title of the Goal verification result; the placeholder is its status",
                  })}
                </AlertTitle>
                {verification.summary.length > 0 && (
                  <AlertDescription>{verification.summary}</AlertDescription>
                )}
              </Alert>
            )}
            {hasWork && boardSlot}
            {!completed && isTruthy(plan) && <PlanNotes plan={plan} />}
          </div>
          {!completed && hasWork && (
            <div className="flex flex-wrap items-center gap-1 border-t p-1.5">
              {isTruthy(plan) && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={
                    actions?.moves[mode].allowed !== true || busy || disabled || controlling
                  }
                  onClick={onRevise}
                >
                  <PencilIcon data-icon="inline-start" />
                  <Trans comment="Button: revise the Plan">Plan 수정</Trans>
                </Button>
              )}
              {isTruthy(goal) && !resuming && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={actions?.controls.pause.allowed !== true || disabled || controlling}
                  onClick={onPause}
                >
                  <PauseIcon data-icon="inline-start" />
                  <Trans comment="Button: pause the Goal">일시 중지</Trans>
                </Button>
              )}
              {isTruthy(goal) && (
                <AlertDialog>
                  <AlertDialogTrigger
                    render={
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="ml-auto"
                        disabled={
                          actions?.controls.stop.allowed !== true || disabled || controlling
                        }
                      />
                    }
                  >
                    <SquareIcon data-icon="inline-start" />
                    <Trans comment="Button: stop the Goal for good">중단</Trans>
                  </AlertDialogTrigger>
                  <AlertDialogContent size="sm">
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        <Trans>이 Goal을 중단할까요?</Trans>
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        <Trans>
                          중단한 Goal은 다시 계속할 수 없습니다. 잠시 멈추려면 일시 중지를 써
                          주십시오.
                        </Trans>
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>
                        <Trans comment="Button: close the stop dialog without stopping the Goal">
                          그만두기
                        </Trans>
                      </AlertDialogCancel>
                      <AlertDialogAction variant="destructive" onClick={onStop}>
                        <Trans comment="Button: confirm stopping the Goal">중단</Trans>
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
            </div>
          )}
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}
