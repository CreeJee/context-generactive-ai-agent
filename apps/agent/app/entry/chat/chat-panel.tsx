import { Effect, Fiber } from "effect";
import { runUiEffect, uiPromise, uiFailure } from "../shared/ui-effect";
import { isTruthy } from "../../truthy.ts";
import { fetchServerSentEvents, useChat } from "@tanstack/ai-react";
import { useQueryClient } from "@tanstack/react-query";
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
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useLoading } from "react-simplikit";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Marker, MarkerContent, MarkerIcon } from "~/components/ui/marker";
import { Spinner } from "~/components/ui/spinner";
import { renumberReferences, useDraftImages } from "./draft-images";
import { missingDeliveredMessages } from "./delivered-messages";
import { interruptContinuationState } from "../session/interrupt-recovery";
import {
  isApiError,
  chatFetch,
  compactErrorMessage,
  eventDecoders,
  type CompactResult,
  type ContextView,
  type QueuedMessage,
  type QueueSnapshot,
  type WorkflowPhase,
  type WorkflowState,
} from "../api";
import { ChatApprovals } from "./chat-approvals";
import { ChatComposer, type ChatComposerHandle } from "./chat-composer";
import { ChatHistory } from "./chat-history";
import { ContextMeter } from "./context-meter";
import { type ComposerMode } from "./composer-status";
import { DeliveredMessageView, MessageView } from "./message";
import { isTakenIn, useMessageQueue } from "../session/message-queue";
import { SubagentPanel } from "./subagent-panel";
import { ReadOnlyBar } from "./read-only-bar";
import { toPendingApproval, type ApprovalInterrupts, type ApprovalTools } from "./pending-approval";
import { RunNoticeView } from "../session/run-state";
import { sessionDraftsAtom } from "../session/session-drafts";
import { useSessionLease, type PageLease } from "../session/session-lease";
import { useWorkTrace } from "../session/work-trace";
import { useBackendRestartRequired } from "../shared/use-backend-restart";
import { useImageGeneration } from "../media/use-image-generation";
import { useRunState } from "../session/use-run-state";
import { useSessionEventScope } from "../events/context";
import { sessionQueries } from "../queries/session";
import {
  useArchiveTraceTaskMutation,
  useCompactSessionMutation,
  useDeleteTraceTaskMutation,
  useResumeTraceTaskMutation,
} from "../queries/mutations/session";
import {
  WorkflowArtifactPanel,
  phaseLabels,
  workflowModeLabel,
  goalStatusLabels,
  planStatusLabels,
} from "./workflow-panel";
import { parseSlash, promptOf, type SlashCommand, type SlashContext } from "./slash-commands";

/** Slash commands: what they can offer, and how the app runs the ones outside this panel. */
export interface SlashSupport {
  readonly context: SlashContext;
  readonly run: (
    command: Extract<
      SlashCommand,
      { kind: "new" | "agent" | "mode" | "model" | "settings" | "report" }
    >,
  ) => Promise<void>;
}

// Stable references: useChat treats a new array as changed options on every render.
const approvalInterrupts: ApprovalInterrupts = [permissionReviewInterrupt];

const imageFiles = (files: FileList | null) =>
  Array.from(files ?? []).filter((file) => file.type.startsWith("image/"));

/** The input box either writes a new message or edits one that is waiting in the queue. */
type Composer =
  | { readonly kind: "compose" }
  | { readonly kind: "editing"; readonly id: string; readonly draft: string };

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

function workflowStatus(state: WorkflowState | null): Notice {
  if (!(state !== null)) return problem("워크플로 상태를 아직 불러오지 못했어요.");
  const goal = isTruthy(state.goal)
    ? `Goal v${state.goal.version} · ${goalStatusLabels[state.goal.status]}`
    : "Goal 없음";
  const plan = isTruthy(state.plan)
    ? `Plan v${state.plan.version} · ${planStatusLabels[state.plan.status]}${isTruthy(state.goal) && state.plan.goalVersion !== state.goal.version ? " · Goal 변경으로 오래됨" : ""}`
    : "Plan 없음";
  const mode = workflowModeLabel(state);
  return done(`${mode}${mode === "완료" ? "" : " 모드"} · ${goal} · ${plan}`);
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
  sendingEnabled,
}: {
  sessionId: string;
  imagesSupported: boolean;
  slash: SlashSupport;
  sendingEnabled: boolean;
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
      sendingEnabled={sendingEnabled}
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
  sendingEnabled,
}: {
  sessionId: string;
  holder: string;
  lease: PageLease;
  refused: boolean;
  onContinue: () => void;
  onResync: () => void;
  imagesSupported: boolean;
  slash: SlashSupport;
  sendingEnabled: boolean;
}) {
  const queryClient = useQueryClient();
  const { projectId } = useSessionEventScope();
  if (!isTruthy(projectId)) throw new Error("Chat requires an active project");
  const resumeTraceMutation = useResumeTraceTaskMutation(projectId, sessionId, holder);
  const archiveTraceMutation = useArchiveTraceTaskMutation(projectId, sessionId, holder);
  const deleteTraceMutation = useDeleteTraceTaskMutation(projectId, sessionId, holder);
  const compactMutation = useCompactSessionMutation(projectId, sessionId, holder);
  const readOnly = lease.state !== "mine";
  const backendRestartRequired = useBackendRestartRequired();
  const mutationBlocked = readOnly || backendRestartRequired || !sendingEnabled;
  const workTrace = useWorkTrace(sessionId);
  const [composer, setComposer] = useState<Composer>({ kind: "compose" });
  const [sessionDrafts, setSessionDrafts] = useAtom(sessionDraftsAtom);
  const composeDraft = sessionDrafts[sessionId] ?? "";
  const draft = composer.kind === "editing" ? composer.draft : composeDraft;
  const setDraft = (next: string) => {
    if (composer.kind === "editing") {
      setComposer((current) =>
        current.kind === "editing" ? { ...current, draft: next } : current,
      );
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
  const [notice, setNotice] = useState<Notice | null>(null);
  const media = useImageGeneration((message) => setNotice(problem(message)));
  // What the run in progress reports; the server's record covers the time before and after it.
  const [liveContext, setLiveContext] = useState<ContextView | null>(null);
  const [placements, setPlacements] = useState<Readonly<Record<string, Placement>>>({});
  // Set while the conversation is read again after a run, so taken-in messages do not blink out.
  const [catchingUp, setCatchingUp] = useState(false);
  const place = (ids: readonly string[], placement: Placement) =>
    setPlacements((current) => ({
      ...current,
      ...Object.fromEntries(ids.map((id) => [id, placement])),
    }));
  const draftImages = useDraftImages();
  const composerInput = useRef<ChatComposerHandle>(null);
  const {
    messages,
    setMessages,
    hasOlderMessages,
    loadOlderMessages,
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
      fetchClient: chatFetch,
    }),
    threadId: sessionId,
    persistence: true,
    // Enables TanStack's server-authoritative delta protocol: hydrated and completed message ids are
    // remembered, so the next turn sends only messages the server has not persisted already.
    // Keep first delivery bounded; earlier turns remain available via loadOlderMessages.
    history: { pageSize: 20 },
    // The same definitions the server uses, so approval requests can be matched and answered:
    // tool approvals in `ask` mode, permission reviews in `auto` mode.
    tools: approvalToolDefinitions,
    interrupts: approvalInterrupts,
    onCustomEvent: (eventType, data) => {
      switch (eventType) {
        case contextUsageEvent: {
          const view = Option.getOrNull(eventDecoders.context(data));
          if (isTruthy(view)) setLiveContext(view);
          return;
        }
        case queueDeliveredEvent: {
          // Taken in at a tool call: after the message that made it, before the answer that follows.
          const last = messages.at(-1);
          const delivered = Option.getOrNull(eventDecoders.delivered(data));
          if (isTruthy(last) && delivered !== null)
            place(delivered.ids, { side: "after", messageId: last.id });
          void queue.refresh();
          return;
        }
      }
    },
  });
  const approvals = interrupts.flatMap((interrupt) => toPendingApproval(interrupt) ?? []);
  const approvalBatchKey = approvals.map((approval) => approval.id).join("\u0000");
  const waitingForApproval = interrupts.length > 0;
  const awaitingApproval = approvals.map((approval) => approval.toolCallId);
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
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const changeWorkflowPhase = (phase: WorkflowPhase) =>
    runUiEffect(
      Effect.gen(function* () {
        const state = yield* uiPromise(() => run.setWorkflowPhase(phase));
        setNotice(done(`${phaseLabels[state.phase]} 모드로 바꿨어요.`));
        return state;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            const failure = uiFailure(cause);
            const message =
              isApiError(failure) &&
              (failure.code === "plan_not_ready" || failure.code === "plan_outdated")
                ? "실행하려면 먼저 준비된 Plan이 필요해요."
                : isApiError(failure) && failure.code === "run_in_progress"
                  ? "답변이 끝난 뒤 모드를 바꿀 수 있어요."
                  : "워크플로 모드를 바꾸지 못했어요.";
            setNotice(problem(message));
            return null;
          }),
        ),
      ),
    );

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const revisePlan = () =>
    runUiEffect(
      Effect.gen(function* () {
        if (
          run.workflow?.phase !== "plan" &&
          !isTruthy(yield* uiPromise(() => changeWorkflowPhase("plan")))
        )
          return;
        composerInput.current?.focus();
        setNotice(done("바꾸고 싶은 내용을 입력해 주세요."));
      }),
    );

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const executePlan = () =>
    runUiEffect(
      Effect.gen(function* () {
        const retryingFailedVerification =
          run.workflow?.plan?.status === "executing" &&
          run.workflow.plan.verification.status === "failed";
        // Even a continuation rechecks the current server policy before dispatching another turn.
        if (!isTruthy(yield* uiPromise(() => changeWorkflowPhase("execute")))) return;
        setNotice(null);
        void sendMessage(
          contentOf(
            retryingFailedVerification
              ? "저장된 검증 실패 evidence를 바탕으로 구현 결함을 수정하고 다시 검증해 줘."
              : "승인한 Plan을 첫 번째 미완료 단계부터 실행하고 결과를 검증하며, 검증된 결과를 확인 하고 단계가 완료될때까지 반복하여 플랜을 완결성있게 마무리해줘",
            [],
          ),
        );
      }),
    );

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const controlGoal = (action: "pause" | "resume" | "stop") =>
    runUiEffect(
      Effect.gen(function* () {
        yield* uiPromise(() => run.controlWorkflow(action));
        if (action === "pause" || action === "stop") {
          if (generating) stop();
          setNotice(done(action === "pause" ? "Goal을 일시 중지했어요." : "Goal을 중단했어요."));
          return;
        }
        setNotice(null);
        void sendMessage(contentOf("일시 중지한 Goal을 현재 상태에서 이어서 진행해 줘.", []));
      }).pipe(
        Effect.catchCause(() =>
          Effect.sync(() => {
            setNotice(problem("Goal 상태를 바꾸지 못했어요."));
          }),
        ),
      ),
    );
  // The server's view is read again once the run stops, and from then on it is the latest.
  useEffect(() => setLiveContext(null), [run.context]);
  const context = liveContext ?? run.context;
  const queue = useMessageQueue(sessionId, holder, generating);
  const [submitting, trackSubmission] = useLoading();

  // Messages the run took in, shown in the conversation until it is read again with them.
  const inFlight =
    generating || waitingForApproval || catchingUp
      ? missingDeliveredMessages(queue.items.filter(isTakenIn), messages)
      : [];
  const takenIn = (side: Placement["side"], messageId: string) =>
    inFlight.filter((taken) => {
      const placement = placements[taken.id];
      return placement?.side === side && placement.messageId === messageId;
    });
  const unplaced = inFlight.filter((taken) => {
    const placement = placements[taken.id];
    return !isTruthy(placement) || !messages.some((message) => message.id === placement.messageId);
  });

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const cancel = () =>
    runUiEffect(
      Effect.gen(function* () {
        // Stopping only the local stream would leave the run going on the server, so ask it first.
        const result = yield* uiPromise(() => run.cancel());
        if (result !== "failed") stop();
        if (result === "idle") setNotice(problem("멈출 답변이 없어요."));
        if (result === "failed") setNotice(problem("명령을 실행하지 못했어요."));
      }),
    );

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const resumeTask = (task: TraceTaskView, confirmUncertain: boolean) =>
    runUiEffect(
      Effect.gen(function* () {
        const attemptId = task.latestAttemptId;
        if (!isTruthy(attemptId)) return { status: "failed" as const };
        return yield* Effect.gen(function* () {
          const result = yield* uiPromise(() =>
            resumeTraceMutation.mutateAsync({
              taskId: task.id,
              attemptId,
              confirmUncertain,
            }),
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
        }).pipe(
          Effect.catchCause(() =>
            Effect.sync(() => {
              setNotice(problem("재개 요청을 저장하지 못했어요."));
              return { status: "failed" as const };
            }),
          ),
        );
      }),
    );

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const archiveTask = (task: TraceTaskView) =>
    runUiEffect(
      Effect.gen(function* () {
        const result = yield* uiPromise(() => archiveTraceMutation.mutateAsync(task.id));
        if (result.status === "completed") {
          setNotice(done("작업을 보관했어요. Work Trace 기록과 project provenance는 유지돼요."));
          return { status: "archived" as const };
        }
        setNotice(problem("작업 중단을 기다리고 있어요. 완료 후 다시 확인해 주세요."));
        return result.status === "blocked"
          ? { status: "blocked" as const, reason: result.blocker }
          : { status: "failed" as const };
      }).pipe(
        Effect.catchCause(() =>
          Effect.sync(() => {
            setNotice(problem("작업을 보관하지 못했어요."));
            return { status: "failed" as const };
          }),
        ),
      ),
    );

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const deleteTask = (task: TraceTaskView) =>
    runUiEffect(
      Effect.gen(function* () {
        const result = yield* uiPromise(() => deleteTraceMutation.mutateAsync(task.id));
        if (result.status === "completed") {
          setNotice(done("작업 원본을 삭제했어요. 채택된 project memory와 provenance는 유지돼요."));
          return { status: "deleted" as const };
        }
        setNotice(problem("작업 중단을 기다리고 있어요. 완료 후 다시 확인해 주세요."));
        return result.status === "blocked"
          ? { status: "blocked" as const, reason: result.blocker }
          : { status: "failed" as const };
      }).pipe(
        Effect.catchCause(() =>
          Effect.sync(() => {
            setNotice(problem("작업 원본을 삭제하지 못했어요."));
            return { status: "failed" as const };
          }),
        ),
      ),
    );

  const ready = draftImages.images.flatMap((image) => (image.status === "ready" ? [image] : []));
  const uploading = draftImages.images.some((image) => image.status === "uploading");
  const failed = draftImages.images.some((image) => image.status === "failed");
  const shownNotice =
    notice ?? (failed ? problem("올리지 못한 이미지가 있어요. 빼고 보내 주세요.") : null);
  const editing = composer.kind === "editing" ? composer : null;
  const composerMode: ComposerMode =
    editing !== null
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

  const pendingQueuedStart = useRef(false);
  /** The snapshot only hints when to start; the server selects the current queued turn. */
  const sendNextQueued = (snapshot: QueueSnapshot) => {
    if (snapshot.nextDelivery.kind !== "ready") return;
    if (mutationBlocked) {
      pendingQueuedStart.current = true;
      return;
    }
    pendingQueuedStart.current = false;
    // A content-less placeholder is replaced by the server's current queued turn.
    void sendMessage(contentOf("", []), { body: { queuedNext: true } });
  };

  // When this page's run stops: catch up with messages the run took in along the way, then, after
  // a normal finish, send what is waiting as the next turn (R03). Not after a cancel or failure.
  const wasGenerating = useRef(generating);
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const handleRunSettled = useEffectEvent(() =>
    runUiEffect(
      Effect.gen(function* () {
        setCatchingUp(true);
        return yield* Effect.gen(function* () {
          const [snapshot, state] = yield* uiPromise(() =>
            Promise.all([queue.refresh(), run.refresh()]),
          );
          if (
            !isTruthy(snapshot) ||
            !isTruthy(state) ||
            isTruthy(state.running) ||
            state.lastRun?.status === "interrupted"
          )
            return;
          if (snapshot.items.some(isTakenIn))
            setMessages(
              (yield* uiPromise(() =>
                queryClient.fetchQuery(sessionQueries.transcript(projectId, sessionId)),
              )).messages,
            );
          if (state.lastRun?.status === "completed" && snapshot.nextDelivery.kind === "ready")
            sendNextQueued(snapshot);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              setCatchingUp(false);
              setPlacements({});
            }),
          ),
        );
      }),
    ),
  );
  useEffect(() => {
    const settled = wasGenerating.current && !generating;
    wasGenerating.current = generating;
    if (!settled || readOnly) return;
    void handleRunSettled();
  }, [generating, readOnly]);
  useEffect(() => {
    if (!pendingQueuedStart.current || mutationBlocked || generating || waitingForApproval) return;
    pendingQueuedStart.current = false;
    // Read current server run/queue state again; do not dispatch an old snapshot
    // when provider readiness or ownership returns after the run finished.
    void handleRunSettled();
  }, [mutationBlocked, generating, waitingForApproval]);

  // Unsaved edit text is stored as it is typed, so a restart restores it as a draft.
  const saveEditDraft = useEffectEvent((id: string, text: string) =>
    queue.change(id, { action: "edit", draft: text }),
  );
  useEffect(() => {
    if (!(editing !== null)) return;
    const task = Effect.runFork(
      Effect.sleep(editDraftSaveMs).pipe(
        Effect.andThen(Effect.sync(() => void saveEditDraft(editing.id, draft))),
      ),
    );
    return () => {
      void Effect.runFork(Fiber.interrupt(task));
    };
  }, [draft, editing?.id]);

  const startEdit = (message: QueuedMessage) => {
    if (editing !== null || readOnly) return;
    const text =
      message.state.kind === "editing"
        ? message.state.draft
        : message.state.kind === "held" && message.state.draft !== null
          ? message.state.draft
          : message.text;
    setComposer({ kind: "editing", id: message.id, draft: text });
    setNotice(null);
    void queue.change(message.id, { action: "edit", draft: text });
  };

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const finishEdit = (outcome: "save" | "remove") =>
    runUiEffect(
      Effect.gen(function* () {
        if (!(editing !== null)) return;
        setComposer({ kind: "compose" });
        const text = draft.trim();
        const snapshot = yield* uiPromise(() =>
          queue.change(
            editing.id,
            outcome === "save" && text.length > 0 ? { action: "save", text } : { action: "remove" },
          ),
        );
        // Saved while nothing runs: the queue may be free to go now.
        if (isTruthy(snapshot) && !generating && !waitingForApproval) sendNextQueued(snapshot);
      }),
    );

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const confirmQueued = (message: QueuedMessage) =>
    runUiEffect(
      Effect.gen(function* () {
        const snapshot = yield* uiPromise(() => queue.change(message.id, { action: "confirm" }));
        if (isTruthy(snapshot) && !generating && !waitingForApproval) sendNextQueued(snapshot);
      }),
    );

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const removeQueued = (message: QueuedMessage) =>
    runUiEffect(
      Effect.gen(function* () {
        if (editing?.id === message.id) return yield* uiPromise(() => finishEdit("remove"));
        yield* uiPromise(() => queue.change(message.id, { action: "remove" }));
      }),
    );

  /** Alt+↑ picks the last message still waiting, Alt+↓ the first. */
  const pickQueued = (direction: "up" | "down") => {
    if (editing !== null) {
      setNotice(problem("Enter로 저장하거나 Esc로 지운 뒤 다른 메시지를 고를 수 있어요."));
      return;
    }
    const editable = queue.items.filter(isEditable);
    const message = direction === "up" ? editable.at(-1) : editable[0];
    if (isTruthy(message)) startEdit(message);
  };

  const attach = (files: readonly File[]) => {
    if (files.length === 0) return;
    if (!imagesSupported) {
      setNotice(problem("선택한 모델은 이미지를 읽지 못해요. 이미지를 지원하는 모델을 고르세요."));
      return;
    }
    setNotice(null);
    draftImages.add(files);
  };

  /**
   * Enter. While nothing runs it sends a turn. While a run answers it queues the message for the
   * next tool-call boundary. With `steer` (Ctrl/⌘+Shift+Enter) the server also sends it as the
   * next turn if the answer ends first, so it reaches the model even if this page is closed.
   */
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const submit = (mode: "queue" | "steer") =>
    runUiEffect(
      Effect.gen(function* () {
        if (editing !== null) {
          if (mode === "steer") setNotice(problem("편집을 끝낸 뒤 스티어링할 수 있어요."));
          else yield* uiPromise(() => finishEdit("save"));
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
                const state = yield* uiPromise(() => changeWorkflowPhase(command.phase));
                if (!isTruthy(state)) return;
                const request =
                  command.request ||
                  (command.phase === "plan"
                    ? "요청에서 목표를 정리하고 실행 가능한 Plan을 읽기 전용으로 조사해 기록해 줘."
                    : command.phase === "execute"
                      ? "승인한 Plan을 첫 번째 미완료 단계부터 실행해 줘."
                      : "");
                if (!(request.length > 0)) {
                  setDraft("");
                  return;
                }
                text = request;
                break;
              }
              case "cancel":
                setDraft("");
                setNotice(null);
                void cancel();
                return;
              case "compact":
                setDraft("");
                setNotice(null);
                return yield* uiPromise(() => compactMutation.mutateAsync()).pipe(
                  Effect.map((result) => setNotice(compacted(result))),
                  Effect.catch((failure) =>
                    Effect.sync(() => {
                      const error = failure.cause;
                      setNotice(
                        problem(
                          compactErrorMessage(
                            error instanceof Error ? error : new Error(String(error)),
                          ),
                        ),
                      );
                    }),
                  ),
                );
              case "new":
              case "agent":
              case "mode":
              case "model":
              case "settings":
              case "report":
                setDraft("");
                setNotice(null);
                return yield* uiPromise(() => slash.run(command)).pipe(
                  Effect.catch(() =>
                    Effect.sync(() => setNotice(problem("명령을 실행하지 못했어요."))),
                  ),
                );
            }
          }
        }
        const attachmentIds = ready.map((image) => image.attachment.id);
        const clearDraft = () => {
          setDraft("");
          draftImages.clear();
          media.clearIntent();
          setNotice(null);
        };
        const sendTurn = () => {
          clearDraft();
          void sendMessage(contentOf(text, attachmentIds));
        };
        if (!generating && media.intent) {
          if (attachmentIds.length > 0)
            return setNotice(problem("첫 버전의 이미지 생성은 텍스트 프롬프트만 지원해요."));
          if (
            !window.confirm("이미지 생성은 별도 유료 미디어 모델을 호출할 수 있어요. 실행할까요?")
          )
            return;
          if (yield* uiPromise(() => media.generate(text))) clearDraft();
          return;
        }
        if (!generating) return sendTurn();
        if (media.intent)
          return setNotice(problem("이미지 생성 요청은 답변이 끝난 뒤 별도 요청으로 보내 주세요."));

        const outcome = yield* uiPromise(() =>
          trackSubmission(queue.add(text, attachmentIds, mode)),
        );
        switch (outcome.kind) {
          case "queued":
            return clearDraft();
          case "not-running":
            return sendTurn();
          case "failed":
            return setNotice(problem("메시지를 넣지 못했어요. 다시 시도해 주세요."));
        }
      }),
    );

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
      <ChatHistory
        messages={messages}
        hasOlderMessages={hasOlderMessages}
        loadOlderMessages={loadOlderMessages}
        renderMessage={(message, index) => (
          <>
            {takenIn("before", message.id).map((taken) => (
              <DeliveredMessageView key={taken.id} message={taken} />
            ))}
            <MessageView
              message={message}
              streaming={generating && index === messages.length - 1}
              awaitingApproval={awaitingApproval}
              tasks={workTrace.tasks}
              traceConnection={workTrace.connection}
              readOnly={readOnly}
              onResumeTask={resumeTask}
              onArchiveTask={archiveTask}
              onDeleteTask={deleteTask}
            />
            {takenIn("after", message.id).map((taken) => (
              <DeliveredMessageView key={taken.id} message={taken} />
            ))}
          </>
        )}
      >
        {unplaced.map((taken) => (
          <DeliveredMessageView key={taken.id} message={taken} />
        ))}
        <WorkflowArtifactPanel
          state={run.workflow}
          execution={run.execution}
          providerRetry={run.providerRetry}
          actions={run.actions}
          busy={generating}
          disabled={mutationBlocked}
          controlling={run.controlling}
          onPause={() => void controlGoal("pause")}
          onResume={() => void controlGoal("resume")}
          onStop={() => void controlGoal("stop")}
          onRevise={() => void revisePlan()}
          onExecute={() => void executePlan()}
        />
        <ChatApprovals
          key={approvalBatchKey}
          sessionId={sessionId}
          holder={holder}
          approvals={approvals}
          incomplete={incompleteApprovalBatch}
          stale={staleApprovalBatch}
          retryable={retryableApprovalBatch}
          continuationLost={continuationStartFailed}
          errorCount={interruptErrors.length}
          errorMessage={approvalErrorMessage ?? null}
          readOnly={readOnly}
          resuming={resuming}
          onResolve={(decisions) =>
            resolveInterrupts((interrupt) => {
              const pending = toPendingApproval(interrupt);
              const decision = decisions[interrupt.id];
              if (pending !== null && decision !== undefined) pending.answer(decision);
            })
          }
          onRetry={retryInterrupts}
          onResync={onResync}
          onProblem={(message) => setNotice(problem(message))}
        />
        <SubagentPanel
          sessionId={sessionId}
          holder={holder}
          generating={generating}
          readOnly={readOnly}
        />
        {status === "submitted" && (
          <Marker role="status">
            <MarkerIcon>
              <Spinner />
            </MarkerIcon>
            <MarkerContent>생각하는 중…</MarkerContent>
          </Marker>
        )}
        {/* Between tool calls nothing streams, so the thread itself says the answer goes on. */}
        {generating && status !== "submitted" && !waitingForApproval && !endsWithText && (
          <Marker role="status">
            <MarkerIcon>
              <Spinner />
            </MarkerIcon>
            <MarkerContent>작업 중…</MarkerContent>
          </Marker>
        )}
        {error &&
          !continuationStartFailed &&
          !continuationReachedNextApproval &&
          run.notice === null && (
            <Alert variant="destructive">
              <AlertTitle>응답을 받지 못했어요</AlertTitle>
              <AlertDescription>
                {isApiError(error) && error.code === "provider_auth_unavailable"
                  ? "인증 상태를 확인할 수 없어요. 잠시 후 다시 시도해 주세요."
                  : isApiError(error) && error.code === "provider_unavailable"
                    ? "선택한 제공자를 사용할 수 없어요. 제공자 설정을 확인해 주세요."
                    : error.message}
              </AlertDescription>
            </Alert>
          )}
        {!generating && !waitingForApproval && run.notice && <RunNoticeView notice={run.notice} />}
      </ChatHistory>

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
            <ChatComposer
              ref={composerInput}
              draft={draft}
              onDraftChange={setDraft}
              editingId={editing?.id ?? null}
              slashContext={slash.context}
              draftImages={draftImages}
              queueItems={queue.items}
              imageSettings={media.settings}
              imageIntent={media.intent}
              onToggleImageIntent={media.toggleIntent}
              generatingImage={media.generating}
              generatedImage={media.asset}
              imagesSupported={imagesSupported}
              mutationBlocked={mutationBlocked}
              generating={generating}
              waitingForApproval={waitingForApproval}
              canSend={canSend}
              composerMode={composerMode}
              run={run}
              onSubmit={(mode) => void submit(mode)}
              onAttach={attach}
              onEditQueued={startEdit}
              onRemoveQueued={(message) => void removeQueued(message)}
              onConfirmQueued={(message) => void confirmQueued(message)}
              onFinishEdit={() => void finishEdit("remove")}
              onPickQueued={pickQueued}
              onCancel={() => void cancel()}
              onClear={() => {
                setDraft("");
                draftImages.clear();
                media.clearIntent();
                setNotice(null);
              }}
              onWorkflowPhase={(phase) => void changeWorkflowPhase(phase)}
            />
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
