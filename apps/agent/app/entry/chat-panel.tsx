import { fetchServerSentEvents, useChat } from "@tanstack/ai-react";
import {
  ArrowUpIcon,
  CheckIcon,
  ChevronRightIcon,
  ImagePlusIcon,
  MessageSquareIcon,
  RefreshCwIcon,
  SquareIcon,
  WandSparklesIcon,
} from "lucide-react";
import {
  approvalToolDefinitions,
  attachmentUrl,
  contextUsageEvent,
  permissionReviewInterrupt,
  queueDeliveredEvent,
  sessionHolderHeader,
} from "memory-agent/definitions";
import { cn } from "cn";
import type { TraceTaskView } from "memory-agent";
import { Option } from "effect";
import { useAtom } from "jotai";
import { Fragment, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import {
  PromptInput,
  PromptInputButton,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputTextarea,
} from "~/components/ui/prompt-input";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "~/components/ui/collapsible";
import { Command } from "~/components/ui/command";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Spinner } from "~/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { ApprovalCard } from "./approval";
import { acceptedImageTypes, renumberReferences, useDraftImages } from "./draft-images";
import { DraftImageTray } from "./images";
import { interruptContinuationState } from "./interrupt-recovery";
import {
  api,
  ApiError,
  compactErrorMessage,
  decodeContextEvent,
  decodeDeliveredEvent,
  type CompactResult,
  type ContextView,
  type GeneratedImageAsset,
  type ImageFeatureStatus,
  type QueuedMessage,
  type WorkflowPhase,
  type WorkflowState,
} from "./api";
import { appFetch } from "./backend-restart";
import { ContextMeter } from "./context-meter";
import { ComposerShortcuts, ComposerStatus, type ComposerMode } from "./composer-status";
import { DeliveredMessageView, MessageView } from "./message";
import { isPending, isTakenIn, useMessageQueue } from "./message-queue";
import { QueuePanel } from "./queue-panel";
import { SubagentPanel } from "./subagent-panel";
import { ReadOnlyBar } from "./read-only-bar";
import { toPendingApproval, type ApprovalInterrupts, type ApprovalTools } from "./pending-approval";
import { RunNoticeView } from "./run-state";
import { sessionDraftsAtom } from "./session-drafts";
import { useSessionLease, type PageLease } from "./session-lease";
import { SlashPalette } from "./slash-palette";
import { useWorkTrace } from "./work-trace";
import { useBackendRestartRequired } from "./use-backend-restart";
import { useRunState } from "./use-run-state";
import {
  parseSlash,
  promptOf,
  suggest,
  type SlashCommand,
  type SlashContext,
} from "./slash-commands";

/** Slash commands: what they can offer, and how the app runs the ones outside this panel. */
export interface SlashSupport {
  readonly context: SlashContext;
  readonly run: (
    command: Extract<SlashCommand, { kind: "new" | "agent" | "mode" | "model" | "settings" }>,
  ) => Promise<void>;
}

// Stable references: useChat treats a new array as changed options on every render.
const approvalInterrupts: ApprovalInterrupts = [permissionReviewInterrupt];

const imageFiles = (files: FileList | null) =>
  Array.from(files ?? []).filter((file) => file.type.startsWith("image/"));

/** The input box either writes a new message or edits one that is waiting in the queue. */
type Composer = { readonly kind: "compose" } | { readonly kind: "editing"; readonly id: string };

/**
 * Where a message the running answer took in shows, next to a message of the conversation, until
 * the saved conversation (read again when the run ends) has it in place.
 */
interface Placement {
  readonly side: "before" | "after";
  readonly messageId: string;
}

/** Unsaved edit text is stored after typing pauses this long. */
const editDraftSaveMs = 400;

/** The line above the input box: why something did not happen, or what a command did. */
interface Notice {
  readonly tone: "problem" | "done";
  readonly text: string;
}
const problem = (text: string): Notice => ({ tone: "problem", text });
const done = (text: string): Notice => ({ tone: "done", text });

const phaseLabels: Readonly<Record<WorkflowPhase, string>> = {
  chat: "Chat",
  goal: "Goal",
  plan: "Plan",
  execute: "Execute",
  verify: "Verify",
};

const goalStatusLabels: Record<NonNullable<WorkflowState["goal"]>["status"], string> = {
  draft: "준비 중",
  active: "진행 중",
  paused: "일시 중지",
  completed: "완료",
  failed: "중단됨",
};

const planStatusLabels: Record<NonNullable<WorkflowState["plan"]>["status"], string> = {
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

function workflowStatus(state: WorkflowState | null): Notice {
  if (!state) return problem("워크플로 상태를 아직 불러오지 못했어요.");
  const goal = state.goal
    ? `Goal v${state.goal.version} · ${goalStatusLabels[state.goal.status]}`
    : "Goal 없음";
  const plan = state.plan
    ? `Plan v${state.plan.version} · ${planStatusLabels[state.plan.status]}${state.goal && state.plan.goalVersion !== state.goal.version ? " · Goal 변경으로 오래됨" : ""}`
    : "Plan 없음";
  return done(`${phaseLabels[state.phase]} 모드 · ${goal} · ${plan}`);
}

function WorkflowArtifactPanel({
  state,
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
          {state.goal && !["completed", "failed"].includes(state.goal.status) && (
            <div className="mt-4 flex flex-wrap gap-2">
              {state.goal.status === "paused" ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={disabled || controlling || busy}
                  onClick={onResume}
                >
                  계속
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled || controlling}
                  onClick={onPause}
                >
                  일시 중지
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={disabled || controlling}
                onClick={onStop}
              >
                중단
              </Button>
            </div>
          )}
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

  const current = state.goal !== null && plan.goalVersion === state.goal.version;
  const continuingImplementation =
    current &&
    plan.status === "executing" &&
    ((state.phase === "verify" &&
      (plan.verification.status === "not_run" || plan.verification.status === "failed")) ||
      (state.phase === "execute" && plan.verification.status === "failed"));
  const executable =
    (current && state.phase === "plan" && plan.status === "ready") || continuingImplementation;
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
        {!current && (
          <p className="mt-3 text-destructive">Goal이 변경되어 이 계획을 다시 확인해야 해요.</p>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || disabled}
            onClick={onRevise}
          >
            수정 요청
          </Button>
          {(state.phase === "plan" || continuingImplementation) && (
            <Button
              type="button"
              size="sm"
              disabled={!executable || busy || disabled}
              onClick={onExecute}
            >
              {continuingImplementation ? "구현 계속" : "계획 실행"}
            </Button>
          )}
        </div>
      </AlertDescription>
    </Alert>
  );
}

const tokenCount = new Intl.NumberFormat("ko-KR", {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** What `/compact` did, in one or two sentences. */
function compacted(result: CompactResult): Notice {
  const { cleared, summarizedTurns, summaryFailed, tokensBefore, tokensAfter } = result;
  // One sentence per change, so each noun keeps its own particle.
  const done = [
    ...(cleared > 0 ? [`지난 도구 출력 ${cleared}개를 비웠어요.`] : []),
    ...(summarizedTurns > 0 ? [`앞 대화 ${summarizedTurns}턴은 요약으로 보내요.`] : []),
  ];
  const failed = summaryFailed ? ["앞 대화는 요약하지 못했어요."] : [];
  if (done.length === 0)
    return {
      tone: summaryFailed ? "problem" : "done",
      text: ["더 줄일 내용이 없어요. 최근 대화는 그대로 보내요.", ...failed].join(" "),
    };
  const size = `다음 질문부터 대화가 약 ${tokenCount.format(tokensBefore)} 토큰에서 ${tokenCount.format(tokensAfter)} 토큰으로 줄어요.`;
  return { tone: "done", text: [...done, ...failed, size].join(" ") };
}

/** A user turn from text and uploaded images, as the chat endpoint expects it. */
const contentOf = (text: string, attachmentIds: readonly string[]) => ({
  content: [
    ...(text.length > 0 ? [{ type: "text" as const, content: text }] : []),
    ...attachmentIds.map((id) => ({
      type: "image" as const,
      source: { type: "url" as const, value: attachmentUrl(id) },
    })),
  ],
});

/** The queued message that goes next, if the one at the front is simply waiting. */
const nextInLine = (items: readonly QueuedMessage[]) => {
  const front = items.find((message) => isPending(message) && message.state.kind !== "failed");
  return front?.state.kind === "waiting" ? front : undefined;
};

const isEditable = (message: QueuedMessage) => {
  switch (message.state.kind) {
    case "waiting":
    case "editing":
    case "held":
      return true;
    case "delivered":
    case "failed":
      return false;
  }
};

/**
 * One session: follows who may change it, and remounts the conversation of a read-only page when
 * the owning page starts or finishes a run, so the reader sees it live.
 */
export function SessionView({
  sessionId,
  imagesSupported,
  slash,
}: {
  sessionId: string;
  imagesSupported: boolean;
  slash: SlashSupport;
}) {
  const { holder, lease, revision, refused, continueHere } = useSessionLease(sessionId);
  const [syncRevision, setSyncRevision] = useState(0);
  const reading = lease.state === "other" || lease.state === "free";
  return (
    <ChatPanel
      key={`${reading ? `read:${revision}` : "write"}:sync:${syncRevision}`}
      sessionId={sessionId}
      holder={holder}
      lease={lease}
      refused={refused}
      onContinue={() => void continueHere()}
      onResync={() => setSyncRevision((current) => current + 1)}
      imagesSupported={imagesSupported}
      slash={slash}
    />
  );
}

/**
 * One session's live conversation. The server owns the transcript: on mount the chat hydrates it by
 * session id, together with any approval still waiting, so a reload shows the same card again.
 */
function ChatPanel({
  sessionId,
  holder,
  lease,
  refused,
  onContinue,
  onResync,
  imagesSupported,
  slash,
}: {
  sessionId: string;
  holder: string;
  lease: PageLease;
  refused: boolean;
  onContinue: () => void;
  onResync: () => void;
  imagesSupported: boolean;
  slash: SlashSupport;
}) {
  const readOnly = lease.state !== "mine";
  const backendRestartRequired = useBackendRestartRequired();
  const mutationBlocked = readOnly || backendRestartRequired;
  const workTrace = useWorkTrace(sessionId);
  const [composer, setComposer] = useState<Composer>({ kind: "compose" });
  const [sessionDrafts, setSessionDrafts] = useAtom(sessionDraftsAtom);
  const [editingDraft, setEditingDraft] = useState("");
  const composeDraft = sessionDrafts[sessionId] ?? "";
  const draft = composer.kind === "editing" ? editingDraft : composeDraft;
  const setDraft = (next: string) => {
    if (composer.kind === "editing") {
      setEditingDraft(next);
      return;
    }
    setSessionDrafts((current) => {
      if (next.length > 0) return { ...current, [sessionId]: next };
      const remaining = { ...current };
      delete remaining[sessionId];
      return remaining;
    });
  };
  const [dragging, setDragging] = useState(false);
  const [imageIntent, setImageIntent] = useState(false);
  const [imageSettings, setImageSettings] = useState<ImageFeatureStatus | null>(null);
  const [generatingImage, setGeneratingImage] = useState(false);
  const [generatedImage, setGeneratedImage] = useState<GeneratedImageAsset | null>(null);
  useEffect(() => {
    const refresh = () =>
      void api
        .imageSettings()
        .then(setImageSettings)
        .catch(() => undefined);
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  const [notice, setNotice] = useState<Notice | null>(null);
  // What the run in progress reports; the server's record covers the time before and after it.
  const [liveContext, setLiveContext] = useState<ContextView | null>(null);
  const [placements, setPlacements] = useState<ReadonlyMap<string, Placement>>(new Map());
  // Set while the conversation is read again after a run, so taken-in messages do not blink out.
  const [catchingUp, setCatchingUp] = useState(false);
  const place = (ids: readonly string[], placement: Placement) =>
    setPlacements((current) => new Map([...current, ...ids.map((id) => [id, placement] as const)]));
  const draftImages = useDraftImages();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const caretAfterRender = useRef<number | null>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const {
    messages,
    setMessages,
    sendMessage,
    stop,
    isLoading,
    sessionGenerating,
    error,
    status,
    interrupts,
    interruptErrors,
    resuming,
    resolveInterrupts,
    retryInterrupts,
  } = useChat<ApprovalTools, undefined, unknown, ApprovalInterrupts>({
    connection: fetchServerSentEvents(`/api/chat?session=${encodeURIComponent(sessionId)}`, {
      // The server refuses sends and approval answers from a page that does not hold the session.
      headers: { [sessionHolderHeader]: holder },
      fetchClient: appFetch,
    }),
    threadId: sessionId,
    persistence: true,
    // Enables TanStack's server-authoritative delta protocol: hydrated and completed message ids are
    // remembered, so the next turn sends only messages the server has not persisted already.
    history: { pageSize: 10_000 },
    // The same definitions the server uses, so approval requests can be matched and answered:
    // tool approvals in `ask` mode, permission reviews in `auto` mode.
    tools: approvalToolDefinitions,
    interrupts: approvalInterrupts,
    onCustomEvent: (eventType, data) => {
      switch (eventType) {
        case contextUsageEvent: {
          const view = Option.getOrNull(decodeContextEvent(data));
          if (view) setLiveContext(view);
          return;
        }
        case queueDeliveredEvent: {
          // Taken in at a tool call: after the message that made it, before the answer that follows.
          const last = messages.at(-1);
          const delivered = Option.getOrNull(decodeDeliveredEvent(data));
          if (last && delivered) place(delivered.ids, { side: "after", messageId: last.id });
          void queue.refresh();
          return;
        }
      }
    },
  });
  const approvals = interrupts.flatMap((interrupt) => toPendingApproval(interrupt) ?? []);
  const approvalBatchKey = approvals.map((approval) => approval.id).join("\u0000");
  const [approvalDecisions, setApprovalDecisions] = useState<Readonly<Record<string, boolean>>>({});
  useEffect(() => setApprovalDecisions({}), [approvalBatchKey]);
  const waitingForApproval = interrupts.length > 0;
  const awaitingApproval = new Set(approvals.map((approval) => approval.toolCallId));
  const incompleteApprovalBatch = approvals.length !== interrupts.length;
  const staleApprovalBatch = interruptErrors.some((interruptError) =>
    ["incomplete-batch", "unknown-interrupt", "stale", "conflict", "expired"].includes(
      interruptError.code,
    ),
  );
  const retryableApprovalBatch = interruptErrors.some((interruptError) => interruptError.retryable);
  const approvalErrorMessage = interruptErrors.at(-1)?.message;
  const continuation = interruptContinuationState(error?.message, interrupts.length);
  const continuationStartFailed = continuation === "lost";
  const continuationReachedNextApproval = continuation === "continued";
  const [discardingInterrupts, setDiscardingInterrupts] = useState(false);
  const discardBrokenInterrupts = async () => {
    setDiscardingInterrupts(true);
    try {
      await api.discardInterrupts(sessionId, holder);
      onResync();
    } catch (failure) {
      setDiscardingInterrupts(false);
      setNotice(
        problem(
          failure instanceof ApiError && failure.code === "run_in_progress"
            ? "실행 중인 응답이 끝난 뒤 다시 시도해 주세요."
            : "끊어진 승인 요청을 폐기하지 못했어요.",
        ),
      );
    }
  };
  const stageApproval = (approvalId: string, approved: boolean) => {
    const decisions = { ...approvalDecisions, [approvalId]: approved };
    setApprovalDecisions(decisions);
    // TanStack resumes an interrupt batch atomically. Do not submit until every visible item has
    // a decision, or a reconnect could send only an older subset of the server's pending batch.
    if (
      incompleteApprovalBatch ||
      staleApprovalBatch ||
      approvals.some((approval) => decisions[approval.id] === undefined)
    )
      return;
    try {
      resolveInterrupts((interrupt) => {
        const pending = toPendingApproval(interrupt);
        const decision = decisions[interrupt.id];
        if (pending && decision !== undefined) pending.answer(decision);
      });
    } catch {
      setNotice(problem("승인 응답을 준비하지 못했어요. 서버 상태를 다시 불러와 주세요."));
    }
  };
  // A run rejoined after a reload streams without a local request, so both count as busy.
  const generating = isLoading || sessionGenerating;
  // What the conversation ends with: text means an answer, a tool call means work in between.
  const lastPart = messages
    .at(-1)
    ?.parts.filter((part) => part.type === "text" || part.type === "tool-call")
    .at(-1);
  const endsWithText =
    messages.at(-1)?.role === "assistant" &&
    lastPart?.type === "text" &&
    lastPart.content.trim().length > 0;
  const run = useRunState(sessionId, holder, generating, {
    waitingForApproval,
    answered: endsWithText,
  });
  const changeWorkflowPhase = async (phase: WorkflowPhase) => {
    try {
      const state = await run.setWorkflowPhase(phase);
      setNotice(done(`${phaseLabels[state.phase]} 모드로 바꿨어요.`));
      return state;
    } catch (failure) {
      const message =
        failure instanceof ApiError && failure.code === "plan_not_ready"
          ? "실행하려면 먼저 준비된 Plan이 필요해요."
          : failure instanceof ApiError && failure.code === "run_in_progress"
            ? "답변이 끝난 뒤 모드를 바꿀 수 있어요."
            : "워크플로 모드를 바꾸지 못했어요.";
      setNotice(problem(message));
      return null;
    }
  };

  const revisePlan = async () => {
    if (run.workflow?.phase !== "plan" && !(await changeWorkflowPhase("plan"))) return;
    textarea.current?.focus();
    setNotice(done("바꾸고 싶은 내용을 입력해 주세요."));
  };

  const executePlan = async () => {
    const retryingFailedVerification =
      run.workflow?.plan?.status === "executing" &&
      run.workflow.plan.verification.status === "failed";
    if (run.workflow?.phase !== "execute" && !(await changeWorkflowPhase("execute"))) return;
    setNotice(null);
    void sendMessage(
      contentOf(
        retryingFailedVerification
          ? "저장된 검증 실패 evidence를 바탕으로 구현 결함을 수정하고 다시 검증해 줘."
          : "승인한 Plan을 첫 번째 미완료 단계부터 실행하고 결과를 검증해 줘.",
        [],
      ),
    );
  };

  const controlGoal = async (action: "pause" | "resume" | "stop") => {
    try {
      await run.controlWorkflow(action);
      if (action === "pause" || action === "stop") {
        if (generating) stop();
        setNotice(done(action === "pause" ? "Goal을 일시 중지했어요." : "Goal을 중단했어요."));
        return;
      }
      setNotice(null);
      void sendMessage(contentOf("일시 중지한 Goal을 현재 상태에서 이어서 진행해 줘.", []));
    } catch {
      setNotice(problem("Goal 상태를 바꾸지 못했어요."));
    }
  };
  // The server's view is read again once the run stops, and from then on it is the latest.
  useEffect(() => setLiveContext(null), [run.context]);
  const context = liveContext ?? run.context;
  const queue = useMessageQueue(sessionId, holder, generating);
  const [submitting, setSubmitting] = useState(false);
  // Slash command suggestions for what is typed, and which one the arrow keys point at.
  const [highlight, setHighlight] = useState("");
  const suggestions = composer.kind === "compose" ? suggest(draft, slash.context) : [];
  const highlighted =
    suggestions.find((suggestion) => suggestion.text === highlight) ?? suggestions[0] ?? null;

  // Messages the run took in, shown in the conversation until it is read again with them.
  const inFlight =
    generating || waitingForApproval || catchingUp ? queue.items.filter(isTakenIn) : [];
  const takenIn = (side: Placement["side"], messageId: string) =>
    inFlight.filter((taken) => {
      const placement = placements.get(taken.id);
      return placement?.side === side && placement.messageId === messageId;
    });
  const unplaced = inFlight.filter((taken) => {
    const placement = placements.get(taken.id);
    return !placement || !messages.some((message) => message.id === placement.messageId);
  });

  const cancel = async () => {
    // Stopping only the local stream would leave the run going on the server, so ask it first.
    if (await run.cancel()) stop();
  };

  const resumeTask = async (task: TraceTaskView, confirmUncertain: boolean) => {
    if (!task.latestAttemptId) return { status: "failed" as const };
    try {
      const result = await api.resumeWorkTraceTask(
        sessionId,
        holder,
        task.id,
        task.latestAttemptId,
        confirmUncertain,
      );
      if (result.status === "queued") {
        setNotice(done("재개 요청을 저장했어요. 다음 실행 연결에서 새 attempt로 이어가요."));
        return { status: "queued" as const };
      }
      if (result.reason !== "uncertain_side_effect")
        setNotice(
          problem(
            result.reason === "stale_attempt"
              ? "작업 상태가 바뀌었어요. 최신 Work Trace를 확인해 주세요."
              : result.reason === "attempt_alive"
                ? "이미 실행 중인 attempt가 있어요."
                : "이 작업은 현재 안전하게 재개할 수 없어요.",
          ),
        );
      return result;
    } catch {
      setNotice(problem("재개 요청을 저장하지 못했어요."));
      return { status: "failed" as const };
    }
  };

  const archiveTask = async (task: TraceTaskView) => {
    try {
      const result = await api.archiveWorkTraceTask(sessionId, holder, task.id);
      if (result.status === "completed") {
        setNotice(done("작업을 보관했어요. Work Trace 기록과 project provenance는 유지돼요."));
        return { status: "archived" as const };
      }
      setNotice(problem("작업 중단을 기다리고 있어요. 완료 후 다시 확인해 주세요."));
      return result.status === "blocked"
        ? { status: "blocked" as const, reason: result.blocker }
        : { status: "failed" as const };
    } catch {
      setNotice(problem("작업을 보관하지 못했어요."));
      return { status: "failed" as const };
    }
  };

  const deleteTask = async (task: TraceTaskView) => {
    try {
      const result = await api.deleteWorkTraceTask(sessionId, holder, task.id);
      if (result.status === "completed") {
        setNotice(done("작업 원본을 삭제했어요. 채택된 project memory와 provenance는 유지돼요."));
        return { status: "deleted" as const };
      }
      setNotice(problem("작업 중단을 기다리고 있어요. 완료 후 다시 확인해 주세요."));
      return result.status === "blocked"
        ? { status: "blocked" as const, reason: result.blocker }
        : { status: "failed" as const };
    } catch {
      setNotice(problem("작업 원본을 삭제하지 못했어요."));
      return { status: "failed" as const };
    }
  };

  const ready = draftImages.images.flatMap((image) => (image.status === "ready" ? [image] : []));
  const uploading = draftImages.images.some((image) => image.status === "uploading");
  const failed = draftImages.images.some((image) => image.status === "failed");
  const shownNotice =
    notice ?? (failed ? problem("올리지 못한 이미지가 있어요. 빼고 보내 주세요.") : null);
  const editing = composer.kind === "editing" ? composer : null;
  const composerMode: ComposerMode = editing
    ? { kind: "editing" }
    : waitingForApproval
      ? { kind: "approval" }
      : generating
        ? { kind: "generating" }
        : { kind: "idle" };
  const canSend =
    (draft.trim().length > 0 || ready.length > 0) &&
    !uploading &&
    !failed &&
    !submitting &&
    !waitingForApproval &&
    !mutationBlocked;

  /** Sends the first waiting message as a new turn, if it is next in line. */
  const sendNextQueued = (items: readonly QueuedMessage[]) => {
    const next = nextInLine(items);
    if (!next) return;
    // The id tells the server which queued message this turn delivers.
    void sendMessage(contentOf(next.text, next.attachmentIds), {
      body: { queuedMessageId: next.id },
    });
  };

  // When this page's run stops: catch up with messages the run took in along the way, then, after
  // a normal finish, send what is waiting as the next turn (R03). Not after a cancel or failure.
  const wasGenerating = useRef(generating);
  const startedWorkflowPhase = useRef<WorkflowPhase | null>(null);
  const automaticVerification = useRef<string | null>(null);
  const handleRunSettled = useEffectEvent(async (finishedPhase: WorkflowPhase | null) => {
    setCatchingUp(true);
    try {
      const [items, state] = await Promise.all([queue.refresh(), run.refresh().catch(() => null)]);
      if (!items || !state || state.running || state.lastRun?.status === "interrupted") return;
      if (items.some(isTakenIn)) setMessages((await api.transcript(sessionId)).messages);
      if (state.lastRun?.status !== "completed") return;
      const waiting = nextInLine(items);
      if (waiting) {
        sendNextQueued(items);
        return;
      }
      if (
        finishedPhase === "execute" &&
        state.workflow.phase === "verify" &&
        state.workflow.plan?.status === "executing"
      ) {
        automaticVerification.current = `${sessionId}:${state.workflow.plan.version}`;
        void sendMessage(
          contentOf(
            "실행 결과를 Goal과 Plan의 acceptance criteria에 맞춰 읽기 전용으로 검증하고, evidence와 최종 상태를 기록해 줘.",
            [],
          ),
        );
      }
    } finally {
      setCatchingUp(false);
      setPlacements(new Map());
    }
  });
  useEffect(() => {
    if (!wasGenerating.current && generating)
      startedWorkflowPhase.current = run.workflow?.phase ?? null;
    const settled = wasGenerating.current && !generating;
    const finishedPhase = startedWorkflowPhase.current;
    wasGenerating.current = generating;
    if (!settled || readOnly) return;
    void handleRunSettled(finishedPhase);
  }, [generating, readOnly, run.workflow?.phase]);

  // A reload may happen after Execute finished but before its verification turn started.
  const recoverAutomaticVerification = useEffectEvent(async (planVersion: number) => {
    const key = `${sessionId}:${planVersion}`;
    if (automaticVerification.current === key) return;
    automaticVerification.current = key;
    const items = await queue.refresh();
    if (!items || nextInLine(items)) {
      automaticVerification.current = null;
      return;
    }
    void sendMessage(
      contentOf(
        "실행 결과를 Goal과 Plan의 acceptance criteria에 맞춰 읽기 전용으로 검증하고, evidence와 최종 상태를 기록해 줘.",
        [],
      ),
    );
  });
  useEffect(() => {
    const plan = run.workflow?.plan;
    if (
      generating ||
      readOnly ||
      run.workflow?.phase !== "verify" ||
      plan?.status !== "executing" ||
      plan.verification.status !== "not_run"
    )
      return;
    void recoverAutomaticVerification(plan.version);
  }, [generating, readOnly, run.workflow]);

  // Unsaved edit text is stored as it is typed, so a restart restores it as a draft.
  const saveEditDraft = useEffectEvent((id: string, text: string) =>
    queue.change(id, { action: "edit", draft: text }),
  );
  useEffect(() => {
    if (!editing) return;
    const timer = setTimeout(() => void saveEditDraft(editing.id, draft), editDraftSaveMs);
    return () => clearTimeout(timer);
  }, [draft, editing?.id]);

  const startEdit = (message: QueuedMessage) => {
    if (editing || readOnly) return;
    const text =
      message.state.kind === "editing"
        ? message.state.draft
        : message.state.kind === "held" && message.state.draft !== null
          ? message.state.draft
          : message.text;
    setComposer({ kind: "editing", id: message.id });
    caretAfterRender.current = text.length;
    setEditingDraft(text);
    setNotice(null);
    void queue.change(message.id, { action: "edit", draft: text });
  };

  const finishEdit = async (outcome: "save" | "remove") => {
    if (!editing) return;
    setComposer({ kind: "compose" });
    const text = draft.trim();
    const items = await queue.change(
      editing.id,
      outcome === "save" && text.length > 0 ? { action: "save", text } : { action: "remove" },
    );
    // Saved while nothing runs: the queue may be free to go now.
    if (items && !generating && !waitingForApproval) sendNextQueued(items);
  };

  const confirmQueued = async (message: QueuedMessage) => {
    const items = await queue.change(message.id, { action: "confirm" });
    if (items && !generating && !waitingForApproval) sendNextQueued(items);
  };

  const removeQueued = async (message: QueuedMessage) => {
    if (editing?.id === message.id) return finishEdit("remove");
    await queue.change(message.id, { action: "remove" });
  };

  /** Alt+↑ picks the last message still waiting, Alt+↓ the first. */
  const pickQueued = (direction: "up" | "down") => {
    if (editing) {
      setNotice(problem("Enter로 저장하거나 Esc로 지운 뒤 다른 메시지를 고를 수 있어요."));
      return;
    }
    const editable = queue.items.filter(isEditable);
    const message = direction === "up" ? editable.at(-1) : editable[0];
    if (message) startEdit(message);
  };

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const attach = (files: readonly File[]) => {
    if (files.length === 0) return;
    if (!imagesSupported) {
      setNotice(problem("선택한 모델은 이미지를 읽지 못해요. 이미지를 지원하는 모델을 고르세요."));
      return;
    }
    setNotice(null);
    draftImages.add(files);
  };

  /** Puts `#N` at the cursor so the text can point at a specific image. */
  const insertReference = (number: number) => {
    const element = textarea.current;
    const start = element?.selectionStart ?? draft.length;
    const end = element?.selectionEnd ?? draft.length;
    const before = draft.slice(0, start);
    const after = draft.slice(end);
    const token = `${before.length > 0 && !/\s$/.test(before) ? " " : ""}#${number}${/^\s/.test(after) ? "" : " "}`;
    caretAfterRender.current = start + token.length;
    setDraft(before + token + after);
  };

  // Writing a new value moves the caret to the end, so place it once React has committed.
  useLayoutEffect(() => {
    const caret = caretAfterRender.current;
    if (caret === null) return;
    caretAfterRender.current = null;
    textarea.current?.focus();
    textarea.current?.setSelectionRange(caret, caret);
  }, [draft]);

  /**
   * Enter. While nothing runs it sends a turn. While a run answers it queues the message for the
   * next tool-call boundary, or with `steer` (Ctrl/⌘+Shift+Enter) sends it into the answer now.
   */
  const submit = async (mode: "queue" | "steer") => {
    if (editing) {
      if (mode === "steer") setNotice(problem("편집을 끝낸 뒤 스티어링할 수 있어요."));
      else await finishEdit("save");
      return;
    }
    if (!canSend) return;
    let text = renumberReferences(
      draft.trim(),
      ready.map((image) => image.number),
    );
    // A slash command runs instead of being sent; `skill` and `recall` become a message.
    const parsed =
      ready.length === 0 ? parseSlash(text, slash.context) : { kind: "not_command" as const };
    switch (parsed.kind) {
      case "not_command":
        break;
      case "incomplete":
        return setNotice(problem(parsed.reason));
      case "command": {
        const command = parsed.command;
        switch (command.kind) {
          case "skill":
          case "recall":
            text = promptOf(command);
            break;
          case "workflow_status":
            setDraft("");
            return setNotice(workflowStatus(run.workflow));
          case "workflow": {
            const state = await changeWorkflowPhase(command.phase);
            if (!state) return;
            const request =
              command.request ||
              (command.phase === "plan"
                ? "요청에서 목표를 정리하고 실행 가능한 Plan을 읽기 전용으로 조사해 기록해 줘."
                : command.phase === "execute"
                  ? "승인한 Plan을 첫 번째 미완료 단계부터 실행해 줘."
                  : "");
            if (!request) {
              setDraft("");
              return;
            }
            text = request;
            break;
          }
          case "cancel":
            setDraft("");
            setNotice(generating ? null : problem("멈출 답변이 없어요."));
            if (generating) void cancel();
            return;
          case "compact":
            setDraft("");
            setNotice(null);
            return api.compactSession(sessionId, holder).then(
              (result) => setNotice(compacted(result)),
              (error) =>
                setNotice(
                  problem(
                    compactErrorMessage(error instanceof Error ? error : new Error(String(error))),
                  ),
                ),
            );
          case "new":
          case "agent":
          case "mode":
          case "model":
          case "settings":
            setDraft("");
            setNotice(null);
            return slash.run(command).catch(() => setNotice(problem("명령을 실행하지 못했어요.")));
        }
      }
    }
    const attachmentIds = ready.map((image) => image.attachment.id);
    const clearDraft = () => {
      setDraft("");
      draftImages.clear();
      setImageIntent(false);
      setNotice(null);
    };
    const sendTurn = () => {
      clearDraft();
      void sendMessage(contentOf(text, attachmentIds));
    };
    if (!generating && imageIntent) {
      if (attachmentIds.length > 0)
        return setNotice(problem("첫 버전의 이미지 생성은 텍스트 프롬프트만 지원해요."));
      if (!window.confirm("이미지 생성은 별도 유료 미디어 모델을 호출할 수 있어요. 실행할까요?"))
        return;
      clearDraft();
      setGeneratingImage(true);
      setGeneratedImage(null);
      try {
        setGeneratedImage(await api.generateImage(text, true));
      } catch (failure) {
        if (
          failure instanceof ApiError &&
          failure.code === "image_approval_required" &&
          failure.reason === "cross_provider" &&
          failure.approval
        ) {
          const disclosure =
            "Claude는 이미지를 직접 생성하지 않습니다. 이미지 프롬프트가 OpenAI로 전송되고 사용량은 OpenAI 계정에 귀속됩니다.";
          const once = window.confirm(`${disclosure}\n\n이번 요청에서만 허용할까요?`);
          try {
            if (once) {
              setGeneratedImage(await api.generateImage(text, true, failure.approval));
              return;
            }
            const always = window.confirm(
              `${disclosure}\n\n앞으로 Claude 대화에서 OpenAI 이미지 실행을 항상 허용할까요? 취소하면 실행하지 않습니다.`,
            );
            if (!always) return;
            await api.setCrossProviderMediaConsent("always");
            setGeneratedImage(await api.generateImage(text, true));
            return;
          } catch {
            setNotice(
              problem(
                "공급자 간 이미지 실행 승인을 적용하지 못했어요. 설정과 계정 권한을 확인해 주세요.",
              ),
            );
            return;
          }
        }
        setNotice(
          problem("이미지를 생성하지 못했어요. 설정, 계정 권한과 경로 상태를 확인해 주세요."),
        );
      } finally {
        setGeneratingImage(false);
      }
      return;
    }
    if (!generating) return sendTurn();
    if (imageIntent)
      return setNotice(problem("이미지 생성 요청은 답변이 끝난 뒤 별도 요청으로 보내 주세요."));

    setSubmitting(true);
    const outcome = await queue.add(text, attachmentIds, mode);
    setSubmitting(false);
    switch (outcome.kind) {
      case "queued":
        return clearDraft();
      case "steered": {
        // The saved conversation puts a steered message before the answer it arrived during.
        const last = messages.at(-1);
        if (last)
          place([outcome.message.id], {
            side: last.role === "assistant" ? "before" : "after",
            messageId: last.id,
          });
        return clearDraft();
      }
      case "not-running":
        return sendTurn();
      case "steer-unavailable":
        return setNotice(problem("지금은 바로 전달할 수 없어요. Enter로 대기열에 넣을 수 있어요."));
      case "failed":
        return setNotice(problem("메시지를 넣지 못했어요. 다시 시도해 주세요."));
    }
  };

  return (
    <div
      className="relative flex h-full min-h-0 flex-col"
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        // Moving onto a child also fires dragleave; only leaving the panel ends the drag.
        const next = event.relatedTarget;
        if (next instanceof Node && event.currentTarget.contains(next)) return;
        setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        attach(imageFiles(event.dataTransfer.files));
      }}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-background/80 text-sm font-medium">
          {imagesSupported ? "이미지를 놓으면 첨부돼요" : "선택한 모델은 이미지를 읽지 못해요"}
        </div>
      )}
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex max-w-3xl flex-col gap-5 px-6 py-6">
          {messages.length === 0 && (
            <Empty className="mt-24">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <MessageSquareIcon />
                </EmptyMedia>
                <EmptyTitle>새 대화</EmptyTitle>
                <EmptyDescription>
                  이전 세션과 다른 프로젝트에서 나눈 대화도 기억해서 답해요.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
          {messages.map((message, index) => (
            <Fragment key={message.id}>
              {takenIn("before", message.id).map((taken) => (
                <DeliveredMessageView key={taken.id} message={taken} />
              ))}
              <MessageView
                message={message}
                streaming={generating && index === messages.length - 1}
                awaitingApproval={awaitingApproval}
                tasksByToolCall={workTrace.tasksByToolCall}
                traceConnection={workTrace.connection}
                readOnly={readOnly}
                onResumeTask={resumeTask}
                onArchiveTask={archiveTask}
                onDeleteTask={deleteTask}
              />
              {takenIn("after", message.id).map((taken) => (
                <DeliveredMessageView key={taken.id} message={taken} />
              ))}
            </Fragment>
          ))}
          {unplaced.map((taken) => (
            <DeliveredMessageView key={taken.id} message={taken} />
          ))}
          <WorkflowArtifactPanel
            state={run.workflow}
            busy={generating}
            disabled={readOnly}
            controlling={run.controlling}
            onPause={() => void controlGoal("pause")}
            onResume={() => void controlGoal("resume")}
            onStop={() => void controlGoal("stop")}
            onRevise={() => void revisePlan()}
            onExecute={() => void executePlan()}
          />
          {(incompleteApprovalBatch || interruptErrors.length > 0 || continuationStartFailed) && (
            <Alert variant="destructive">
              <AlertTitle>승인 요청을 이어가지 못했어요</AlertTitle>
              <AlertDescription>
                <div className="flex flex-col items-start gap-3">
                  <p>
                    {continuationStartFailed
                      ? "서버에 이 승인 요청을 이어갈 실행 상태가 남아 있지 않아요. 요청을 폐기해도 셸 명령은 실행되지 않으며, 대화와 작업 evidence는 유지돼요."
                      : staleApprovalBatch || incompleteApprovalBatch
                        ? "연결이 끊긴 사이 승인 목록이 바뀌었어요. 서버의 최신 요청을 다시 불러와야 해요."
                        : (approvalErrorMessage ?? "승인 응답을 전송하지 못했어요.")}
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={readOnly || resuming || discardingInterrupts}
                    onClick={
                      continuationStartFailed
                        ? () => void discardBrokenInterrupts()
                        : retryableApprovalBatch && !staleApprovalBatch
                          ? retryInterrupts
                          : onResync
                    }
                  >
                    <RefreshCwIcon
                      className={cn(
                        "size-3.5",
                        (resuming || discardingInterrupts) && "animate-spin",
                      )}
                    />
                    {continuationStartFailed
                      ? "끊어진 요청 폐기하고 계속"
                      : retryableApprovalBatch && !staleApprovalBatch
                        ? "응답 다시 보내기"
                        : "최신 요청 불러오기"}
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          )}
          {approvals.map((approval) => (
            <ApprovalCard
              key={approval.id}
              approval={approval}
              decision={approvalDecisions[approval.id]}
              disabled={
                readOnly ||
                resuming ||
                incompleteApprovalBatch ||
                staleApprovalBatch ||
                retryableApprovalBatch ||
                continuationStartFailed
              }
              onAnswer={(approved) => stageApproval(approval.id, approved)}
            />
          ))}
          <SubagentPanel
            sessionId={sessionId}
            holder={holder}
            generating={generating}
            readOnly={readOnly}
          />
          {status === "submitted" && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner /> 생각하는 중…
            </div>
          )}
          {/* Between tool calls nothing streams, so the thread itself says the answer goes on. */}
          {generating && status !== "submitted" && !waitingForApproval && !endsWithText && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner /> 작업 중…
            </div>
          )}
          {error &&
            !continuationStartFailed &&
            !continuationReachedNextApproval &&
            run.notice === null && (
              <Alert variant="destructive">
                <AlertTitle>응답을 받지 못했어요</AlertTitle>
                <AlertDescription>{error.message}</AlertDescription>
              </Alert>
            )}
          {!generating && !waitingForApproval && run.notice && (
            <RunNoticeView notice={run.notice} />
          )}
          <div ref={bottom} />
        </div>
      </ScrollArea>

      <div className="bg-background px-6 pt-2 pb-4">
        <div className="mx-auto max-w-3xl">
          {shownNotice && (
            <p
              className={cn(
                "px-1 pb-1.5 text-xs",
                shownNotice.tone === "problem" ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {shownNotice.text}
            </p>
          )}
          {lease.state === "other" || lease.state === "free" ? (
            <ReadOnlyBar lease={lease} refused={refused} onContinue={onContinue} />
          ) : (
            <Command
              shouldFilter={false}
              loop
              vimBindings={false}
              onValueChange={setHighlight}
              variant="composer"
            >
              <form
                onKeyDown={(event) => {
                  // Buttons keep native keyboard activation, outside cmdk navigation.
                  if (event.target !== textarea.current) event.stopPropagation();
                }}
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit("queue");
                }}
              >
                <input
                  ref={filePicker}
                  type="file"
                  accept={acceptedImageTypes}
                  multiple
                  hidden
                  onChange={(event) => {
                    attach(imageFiles(event.target.files));
                    event.target.value = "";
                  }}
                />
                {suggestions.length > 0 && highlighted && (
                  <SlashPalette
                    suggestions={suggestions}
                    onPick={(suggestion) => {
                      caretAfterRender.current = suggestion.text.length;
                      setDraft(suggestion.text);
                    }}
                  />
                )}
                {generatingImage && (
                  <div className="mb-2 rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
                    승인된 미디어 경로에서 이미지를 생성하고 있어요…
                  </div>
                )}
                {generatedImage && (
                  <div className="mb-2 overflow-hidden rounded-lg border bg-card">
                    <img
                      src={generatedImage.url}
                      alt="생성된 이미지"
                      className="max-h-96 w-full object-contain"
                    />
                    <div className="space-y-1 border-t p-3 text-xs text-muted-foreground">
                      <div>
                        대화 모델: {generatedImage.initiatorChatModel} · 실행 경로:{" "}
                        {generatedImage.executorMediaRouteId}
                      </div>
                      <div>
                        실행 방식: {generatedImage.executionMode}
                        {generatedImage.estimatedCostUsd === undefined
                          ? " · 예상 비용 미확인"
                          : ` · 예상 비용 $${generatedImage.estimatedCostUsd.toFixed(4)}`}
                      </div>
                      {generatedImage.usage && (
                        <div>사용량: {JSON.stringify(generatedImage.usage)}</div>
                      )}
                    </div>
                  </div>
                )}
                <PromptInput editing={editing !== null}>
                  <QueuePanel
                    items={queue.items}
                    editingId={editing?.id ?? null}
                    readOnly={mutationBlocked}
                    onEdit={startEdit}
                    onRemove={(message) => void removeQueued(message)}
                    onConfirm={(message) => void confirmQueued(message)}
                  />
                  {!editing && draftImages.images.length > 0 && (
                    <PromptInputHeader>
                      <DraftImageTray
                        images={draftImages.images}
                        onReference={insertReference}
                        onRemove={draftImages.remove}
                      />
                    </PromptInputHeader>
                  )}
                  <PromptInputTextarea
                    ref={textarea}
                    value={draft}
                    disabled={mutationBlocked}
                    onChange={(event) => {
                      setDraft(event.target.value);
                    }}
                    onPaste={(event) => {
                      const files = imageFiles(event.clipboardData.files);
                      if (files.length === 0) return;
                      event.preventDefault();
                      attach(files);
                    }}
                    onKeyDown={(event) => {
                      // Enter that confirms Korean IME input, and Esc that cancels it, belong to the IME.
                      if (event.nativeEvent.isComposing || event.keyCode === 229) {
                        event.stopPropagation();
                        return;
                      }
                      // Preserve composer Home/End/Enter behavior instead of cmdk bindings.
                      if (
                        !suggestions.length ||
                        (event.key !== "ArrowDown" && event.key !== "ArrowUp")
                      ) {
                        event.stopPropagation();
                      }
                      if (suggestions.length > 0 && highlighted) {
                        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                          // Command owns arrow selection and built-in scrolling.
                          return;
                        }
                        // Tab, or Enter on a suggestion that is not what is typed yet, completes it.
                        const completes =
                          event.key === "Tab" ||
                          (event.key === "Enter" && !event.shiftKey && highlighted.text !== draft);
                        if (completes) {
                          event.preventDefault();
                          caretAfterRender.current = highlighted.text.length;
                          setDraft(highlighted.text);

                          return;
                        }
                      }
                      const steerKeys = event.shiftKey && (event.ctrlKey || event.metaKey);
                      if (event.key === "Enter" && steerKeys) {
                        event.preventDefault();
                        void submit("steer");
                      } else if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        void submit("queue");
                      } else if (
                        event.altKey &&
                        (event.key === "ArrowUp" || event.key === "ArrowDown")
                      ) {
                        // Ctrl+↑/↓ belong to macOS Mission Control, so the web uses Alt(⌥).
                        event.preventDefault();
                        pickQueued(event.key === "ArrowUp" ? "up" : "down");
                      } else if (event.key === "Escape") {
                        // In edit mode Esc removes the queued message and never reaches the run.
                        if (editing) void finishEdit("remove");
                        // Esc clears a draft (text and images); with nothing drafted it stops the run.
                        else if (draft.length > 0 || draftImages.images.length > 0 || imageIntent) {
                          setDraft("");
                          draftImages.clear();
                          setImageIntent(false);
                          setNotice(null);
                        } else if (generating) void cancel();
                      }
                    }}
                    placeholder={
                      waitingForApproval
                        ? "위의 승인 요청에 먼저 답해 주세요"
                        : editing
                          ? "Enter를 누르면 고친 내용을 저장해요"
                          : generating
                            ? "답변 중에도 이어서 보낼 수 있어요"
                            : run.workflow?.phase === "goal"
                              ? "달성할 결과를 입력하세요"
                              : run.workflow?.phase === "plan"
                                ? "변경 없이 조사해서 계획할 내용을 입력하세요"
                                : "메시지를 입력하세요. /로 명령을 부르고, 이미지는 붙여넣거나 끌어다 놓아요"
                    }
                    rows={1}
                  />
                  <PromptInputFooter>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <PromptInputButton
                            variant="ghost"
                            disabled={!imagesSupported || mutationBlocked || editing !== null}
                            aria-label="이미지 첨부"
                            onClick={() => filePicker.current?.click()}
                          />
                        }
                      >
                        <ImagePlusIcon />
                      </TooltipTrigger>
                      <TooltipContent>
                        {imagesSupported ? "이미지 첨부" : "선택한 모델은 이미지를 읽지 못해요"}
                      </TooltipContent>
                    </Tooltip>
                    {imageSettings?.featureAvailable && (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <PromptInputButton
                              type="button"
                              variant={imageIntent ? "secondary" : "ghost"}
                              disabled={
                                !imageSettings.imageGenerationEnabled ||
                                mutationBlocked ||
                                generating ||
                                generatingImage ||
                                editing !== null
                              }
                              aria-label="이미지 생성 요청"
                              aria-pressed={imageIntent}
                              onClick={() => setImageIntent((current) => !current)}
                            />
                          }
                        >
                          <WandSparklesIcon />
                        </TooltipTrigger>
                        <TooltipContent>
                          {imageSettings.imageGenerationEnabled
                            ? imageIntent
                              ? "이미지 생성 모드 끄기"
                              : "이번 요청에서만 이미지 생성"
                            : "설정에서 이미지 생성을 먼저 켜세요"}
                        </TooltipContent>
                      </Tooltip>
                    )}
                    <ComposerStatus mode={composerMode} />
                    <div
                      className="flex items-center rounded-md border bg-muted/30 p-0.5"
                      role="group"
                      aria-label="입력 방식"
                    >
                      {(["chat", "goal", "plan"] as const).map((phase) => (
                        <Button
                          key={phase}
                          type="button"
                          size="xs"
                          variant={
                            (run.workflow?.phase ?? "chat") === phase ? "secondary" : "ghost"
                          }
                          disabled={
                            mutationBlocked || generating || generatingImage || editing !== null
                          }
                          aria-pressed={(run.workflow?.phase ?? "chat") === phase}
                          title={
                            phase === "goal"
                              ? "결과를 맡기면 조사, 수정, 검증까지 진행해요"
                              : phase === "plan"
                                ? "프로젝트를 변경하지 않고 실행 계획을 만들어요"
                                : "일반 대화"
                          }
                          onClick={() => void changeWorkflowPhase(phase)}
                        >
                          {phaseLabels[phase]}
                        </Button>
                      ))}
                    </div>
                    <div className="ml-auto flex items-center gap-3">
                      <ComposerShortcuts mode={composerMode} />
                      {generating && !editing && (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <PromptInputButton
                                variant="outline"
                                disabled={run.cancelling || mutationBlocked}
                                aria-label={run.cancelling ? "멈추는 중" : "중지"}
                                onClick={() => void cancel()}
                              />
                            }
                          >
                            {run.cancelling ? <Spinner /> : <SquareIcon className="fill-current" />}
                          </TooltipTrigger>
                          <TooltipContent>
                            {run.cancelling ? "멈추는 중" : "중지(입력창이 비었을 때 Esc)"}
                          </TooltipContent>
                        </Tooltip>
                      )}
                      <PromptInputButton
                        type="submit"
                        variant="default"
                        disabled={editing ? mutationBlocked : !canSend}
                        aria-label={editing ? "저장" : generating ? "대기열에 넣기" : "전송"}
                      >
                        {editing ? <CheckIcon /> : <ArrowUpIcon />}
                      </PromptInputButton>
                    </div>
                  </PromptInputFooter>
                </PromptInput>
              </form>
            </Command>
          )}
          {context && (
            <div className="flex justify-end px-1 pt-1.5">
              <ContextMeter context={context} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
