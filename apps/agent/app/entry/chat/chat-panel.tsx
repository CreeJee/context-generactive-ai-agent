import { i18n, type MessageDescriptor } from "@lingui/core";
import { msg, ph } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Data, Effect, Fiber, Match } from "effect";
import { runUiEffect, uiPromise } from "../shared/ui-effect";
import { isTruthy } from "../../truthy.ts";
import type { Refusal } from "memory-agent/chat-api";
import type { UserContent } from "memory-agent/chat-session";
import { attachmentUrl, contextUsageEvent, queueDeliveredEvent } from "memory-agent/definitions";
import { cn } from "cn";
import type { TraceTaskView } from "memory-agent";
import { Option } from "effect";
import { useAtom, useAtomMount, useAtomSet } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import {
  type ComponentProps,
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import { useLoading } from "react-simplikit";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { RunFailureText } from "./run-failure";
import { Marker, MarkerContent, MarkerIcon } from "~/components/ui/marker";
import { Spinner } from "~/components/ui/spinner";
import { DraftImage, renumberReferences, useDraftImages } from "./draft-images";
import { missingDeliveredMessages } from "./delivered-messages";
import {
  ArchiveTaskResult,
  isApiError,
  compactErrorMessage,
  refusalOf,
  eventDecoders,
  type CompactResult,
  type ContextView,
  QueueEdit,
  QueueItemState,
  type QueuedMessage,
  ResumeTaskResult,
  type WorkflowMode,
  type WorkflowMove,
  type WorkflowState,
} from "../api";
import { ChatApprovals } from "./chat-approvals";
import { UncertainRuns } from "./uncertain-runs";
import { ChatComposer, type ChatComposerHandle } from "./chat-composer";
import { ChatHistory } from "./chat-history";
import { ContextMeter } from "./context-meter";
import { ComposerMode } from "./composer-status";
import {
  ArchiveActionResult,
  DeleteActionResult,
  DeliveredMessageView,
  MessageView,
  ResumeActionResult,
} from "./message";
import { AddOutcome, isTakenIn, useMessageQueue } from "../session/message-queue";
import { SubagentPanel } from "./subagent-panel";
import { ReadOnlyBar } from "./read-only-bar";
import { approvalAnswer, toPendingApproval } from "./pending-approval";
import { useAgentChat } from "./use-agent-chat";
import { RunNoticeView } from "../session/run-state";
import { sessionDrafts } from "../session/session-drafts";
import { useSessionLease, type PageLease } from "../session/session-lease";
import { useWorkTrace } from "../session/work-trace";
import { useBackendRestartRequired } from "../shared/use-backend-restart";
import { useImageGeneration } from "../media/use-image-generation";
import { useRunState } from "../session/use-run-state";
import { useProjectScope } from "../events/context";
import {
  useArchiveTraceTaskMutation,
  useCompactSessionMutation,
  useDeleteTraceTaskMutation,
  useResumeTraceTaskMutation,
} from "../queries/mutations/session";
import { useKanbanQuery } from "../queries/session";
import { BoardTally, OpenBoardButton, WorkflowBoard } from "./board-panel";
import {
  WorkflowArtifactPanel,
  modeLabels,
  workflowModeLabel,
  goalStatusLabels,
  planStatusLabels,
} from "./workflow-panel";
import {
  parseSlash,
  promptOf,
  SlashCommand,
  SlashParse,
  type SlashContext,
} from "./slash-commands";
import { BackgroundTaskIndicator } from "./background-task-panel";
import { runningBackgroundTasks } from "../session/background-tasks";
import { chatPrompts } from "./prompts";

/** Slash commands: what they can offer, and how the app runs the ones outside this panel. */
export interface SlashSupport {
  readonly context: SlashContext;
  readonly run: (
    command: Data.TaggedEnum.Value<
      SlashCommand,
      "new" | "agent" | "mode" | "model" | "effort" | "settings" | "report"
    >,
  ) => Promise<void>;
}

const imageFiles = (files: FileList | null) =>
  Array.from(files ?? []).filter((file) => file.type.startsWith("image/"));

/**
 * The input box either writes a new message or edits one that is waiting in the queue. The text
 * being edited is an atom, like the draft, so only the input box reads it as it is typed.
 */
type Composer = Data.TaggedEnum<{
  compose: {};
  editing: { readonly id: string; readonly text: Atom.Writable<string> };
}>;
const Composer = Data.taggedEnum<Composer>();

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
  if (!(state !== null)) return problem(i18n._(msg`워크플로 상태를 아직 불러오지 못했습니다.`));
  const goal = isTruthy(state.goal)
    ? `Goal v${state.goal.version} · ${i18n._(goalStatusLabels[state.goal.status])}`
    : i18n._(msg`Goal 없음`);
  const plan = isTruthy(state.plan)
    ? `Plan v${state.plan.version} · ${i18n._(planStatusLabels[state.plan.status])}${isTruthy(state.goal) && state.plan.goalVersion !== state.goal.version ? ` · ${i18n._(msg`Goal 변경으로 오래됨`)}` : ""}`
    : i18n._(msg`Plan 없음`);
  const mode = workflowModeLabel(state);
  // A completed workflow's label already says it is done, so it is not called a mode.
  return done(
    `${state.phase === "completed" ? mode : i18n._(msg`${mode} 모드`)} · ${goal} · ${plan}`,
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
    ...(cleared > 0 ? [i18n._(msg`지난 도구 출력 ${cleared}개를 비웠습니다.`)] : []),
    ...(summarizedTurns > 0
      ? [i18n._(msg`앞 대화 ${summarizedTurns}턴은 요약으로 보냅니다.`)]
      : []),
  ];
  const failed = summaryFailed ? [i18n._(msg`앞 대화는 요약하지 못했습니다.`)] : [];
  if (done.length === 0)
    return {
      tone: summaryFailed ? "problem" : "done",
      text: [i18n._(msg`더 줄일 내용이 없습니다. 최근 대화는 그대로 보냅니다.`), ...failed].join(
        " ",
      ),
    };
  const before = tokenCount.format(tokensBefore);
  const after = tokenCount.format(tokensAfter);
  const size = i18n._(
    msg`다음 질문부터 대화가 약 ${before} 토큰에서 ${after} 토큰으로 줄어듭니다.`,
  );
  return { tone: "done", text: [...done, ...failed, size].join(" ") };
}

/** A user turn from text and uploaded images, as the chat API takes it. */
const contentOf = (text: string, attachmentIds: readonly string[]): UserContent => [
  ...(text.length > 0 ? [{ type: "text" as const, content: text }] : []),
  ...attachmentIds.map((id) => ({
    type: "image" as const,
    source: { type: "url" as const, value: attachmentUrl(id) },
  })),
];

/** A refused turn's code as the user reads it; the other codes show as they are. */
const refusalTexts: Partial<Record<Refusal["error"], MessageDescriptor>> = {
  provider_auth_unavailable: msg`인증 상태를 확인할 수 없습니다. 잠시 후 다시 시도해 주십시오.`,
  provider_unavailable: msg`선택한 제공자를 사용할 수 없습니다. 제공자 설정을 확인해 주십시오.`,
  login_required: msg`선택한 공급자에 로그인해야 합니다.`,
  model_selection_required: msg`먼저 모델을 선택해 주십시오.`,
  images_not_supported: msg`선택한 모델은 이미지를 읽지 못합니다.`,
  run_in_progress: msg`이 대화가 아직 답하는 중입니다.`,
  session_in_use: msg`다른 창이 이 대화를 쓰고 있습니다.`,
};

/** Why the last turn got no answer: the server refused it, it was not sent, or its run failed. */
function NoAnswer({
  refusal,
  error,
}: {
  refusal: Refusal | null;
  error: { readonly message: string } | null;
}) {
  const { t } = useLingui();
  if (refusal !== null) {
    const code = refusal.error;
    const text = refusalTexts[code];
    return isTruthy(text) ? t(text) : t`서버가 요청을 거절했습니다(${code}).`;
  }
  return error !== null && <RunFailureText error={error} />;
}

/** The queued message that goes next, if the one at the front is simply waiting. */
const isEditable = (message: QueuedMessage) =>
  QueueItemState.$match(message.state, {
    waiting: () => true,
    editing: () => true,
    held: () => true,
    delivered: () => false,
    failed: () => false,
  });

/**
 * The input box with the text it writes: the session's draft, or the queued message being edited.
 * Only this reads the text, so a keystroke renders the input box and not the conversation.
 */
function DraftComposer({
  textAtom,
  canSend,
  onSubmit,
  onEditDraft,
  ...composer
}: Omit<ComponentProps<typeof ChatComposer>, "draft" | "onDraftChange" | "canSend" | "onSubmit"> & {
  readonly textAtom: Atom.Writable<string>;
  readonly canSend: (text: string) => boolean;
  readonly onSubmit: (mode: "queue" | "steer", text: string) => void;
  /** Stores the unsaved text of the queued message being edited. */
  readonly onEditDraft: (id: string, text: string) => void;
}) {
  const [text, setText] = useAtom(textAtom);
  const { editingId } = composer;
  // Unsaved edit text is stored as it is typed, so a restart restores it as a draft.
  const saveEditDraft = useEffectEvent(onEditDraft);
  useEffect(() => {
    if (editingId === null) return;
    const task = Effect.runFork(
      Effect.sleep(editDraftSaveMs).pipe(
        Effect.andThen(Effect.sync(() => saveEditDraft(editingId, text))),
      ),
    );
    return () => {
      void Effect.runFork(Fiber.interrupt(task));
    };
  }, [text, editingId]);
  return (
    <ChatComposer
      {...composer}
      draft={text}
      onDraftChange={setText}
      canSend={canSend(text)}
      onSubmit={(mode) => onSubmit(mode, text)}
    />
  );
}

/**
 * One session: follows who may change it. The conversation reads every run as it comes, whichever
 * page or the server started it (`useAgentChat`), so it is not remounted for one.
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
  const { holder, lease, refused, continueHere } = useSessionLease(sessionId);
  const [syncRevision, setSyncRevision] = useState(0);
  const reading = lease.state === "other" || lease.state === "free";
  return (
    <ChatPanel
      key={`${reading ? "read" : "write"}:sync:${syncRevision}`}
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
 * One session's live conversation. The server owns the transcript: on mount the page reads its
 * newest messages, together with any approval still waiting, so a reload shows the same card again.
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
  const { t } = useLingui();
  const projectId = useProjectScope("chat");
  // A board's loop runs the cards, so the chat model does not continue the Plan itself.
  const kanbanRunning = useKanbanQuery(projectId, sessionId).data?.active === true;
  // `mutateAsync` is the same function on every render, so the task actions built on it keep their
  // identity and a message renders again only for a change of its own.
  const { mutateAsync: resumeTrace } = useResumeTraceTaskMutation(projectId, sessionId, holder);
  const { mutateAsync: archiveTrace } = useArchiveTraceTaskMutation(projectId, sessionId, holder);
  const { mutateAsync: deleteTrace } = useDeleteTraceTaskMutation(projectId, sessionId, holder);
  const compactMutation = useCompactSessionMutation(projectId, sessionId, holder);
  const readOnly = lease.state !== "mine";
  const backendRestartRequired = useBackendRestartRequired();
  const mutationBlocked = readOnly || backendRestartRequired || !sendingEnabled;
  const workTrace = useWorkTrace(sessionId);
  const [composer, setComposer] = useState<Composer>(Composer.compose());
  const drafts = sessionDrafts(sessionId);
  useAtomMount(drafts.follow);
  // Only the input box reads the draft: the panel reading it rendered the whole conversation again
  // on every keystroke. Setting it here keeps it mounted for the panel's life.
  const setDraft = useAtomSet(drafts.text);
  // The text being edited lasts as long as the edit, also while the input box is not shown.
  useAtomMount(Composer.$is("editing")(composer) ? composer.text : drafts.text);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const media = useImageGeneration((message) => setNotice(problem(message)));
  /** The prompt waiting for the user to accept a paid image generation. */
  const [imagePrompt, setImagePrompt] = useState<string | null>(null);
  /** A move away from a running board the user is asked to confirm; `revise` focuses the composer after. */
  const [leaving, setLeaving] = useState<{
    readonly move: "chat" | WorkflowMode;
    readonly revise: boolean;
  } | null>(null);
  // What the run in progress reports; the server's record covers the time before and after it.
  const [liveContext, setLiveContext] = useState<ContextView | null>(null);
  const [placements, setPlacements] = useState<Readonly<Record<string, Placement>>>({});
  const place = (ids: readonly string[], placement: Placement) =>
    setPlacements((current) => ({
      ...current,
      ...Object.fromEntries(ids.map((id) => [id, placement])),
    }));
  const draftImages = useDraftImages();
  const composerInput = useRef<ChatComposerHandle>(null);
  const {
    messages,
    opened,
    hasOlderMessages,
    loadOlderMessages,
    sendMessage,
    stop,
    isLoading,
    sessionGenerating,
    resuming,
    failure,
    refusal,
    unsent,
    interrupts,
    answerProblem,
    resolveInterrupts,
  } = useAgentChat({
    sessionId,
    holder,
    onCustomEvent: (event) => {
      switch (event.name) {
        case contextUsageEvent: {
          const view = Option.getOrNull(eventDecoders.context(event.value));
          if (isTruthy(view)) setLiveContext(view);
          return;
        }
        case queueDeliveredEvent: {
          // Taken in at a tool call: after the message that made it, before the answer that follows.
          const last = messages.at(-1);
          const delivered = Option.getOrNull(eventDecoders.delivered(event.value));
          if (isTruthy(last) && delivered !== null)
            place(delivered.ids, { side: "after", messageId: last.id });
          void queue.refresh();
          return;
        }
      }
    },
  });
  const approvals = (interrupts?.pending ?? []).map(toPendingApproval);
  const approvalBatchKey = approvals.map((approval) => approval.id).join("\u0000");
  const waitingForApproval = interrupts !== null;
  const awaitingApproval = approvals.map((approval) => approval.toolCallId);
  // A run rejoined after a reload streams without a local request, so both count as busy.
  const generating = isLoading || sessionGenerating;
  // Sent, by the user or the orchestrator, and nothing of the answer has come yet.
  const submitted =
    generating && (messages.at(-1)?.role === "user" || messages.at(-1)?.role === "orchestrator");
  // A turn that was not sent is newer than the failure of the run before it.
  const noAnswer = unsent ?? failure;
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
  const moveWorkflow = (move: WorkflowMove) =>
    runUiEffect(
      Effect.gen(function* () {
        const state = yield* uiPromise(() => run.moveWorkflow(move));
        setNotice(
          done(
            move === "run"
              ? t`승인한 Plan을 칸반 보드에서 실행합니다.`
              : t`${ph({ mode: modeLabels[move] })} 모드로 바꿨습니다.`,
          ),
        );
        return state;
      }).pipe(
        Effect.catchTag("UnknownError", (rejected) =>
          Effect.sync(() => {
            const failure = rejected.cause;
            const message =
              isApiError(failure) &&
              (failure.code === "plan_not_ready" || failure.code === "plan_outdated")
                ? t`실행하려면 먼저 준비된 Plan이 필요합니다.`
                : isApiError(failure) && failure.code === "run_in_progress"
                  ? t`답변이 끝난 뒤 모드를 바꿀 수 있습니다.`
                  : t`워크플로 모드를 바꾸지 못했습니다.`;
            setNotice(problem(message));
            return null;
          }),
        ),
      ),
    );

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const askForRevision = () => {
    composerInput.current?.focus();
    setNotice(done(t`바꾸고 싶은 내용을 입력해 주십시오.`));
  };
  // Revising a running Plan stops the board until it is approved again, so the user confirms it.
  const revisePlan = () =>
    run.workflow?.phase === "running"
      ? setLeaving({ move: run.workflow.mode, revise: true })
      : askForRevision();

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const leaveRun = (pending: NonNullable<typeof leaving>) =>
    runUiEffect(
      Effect.gen(function* () {
        if (!isTruthy(yield* uiPromise(() => moveWorkflow(pending.move)))) return;
        if (pending.revise) askForRevision();
      }),
    );

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const executePlan = () =>
    runUiEffect(
      Effect.gen(function* () {
        // The approval starts the Plan's kanban board: card agents execute it, not this chat.
        yield* uiPromise(() => moveWorkflow("run"));
      }),
    );

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const controlGoal = (action: "pause" | "resume" | "stop") =>
    runUiEffect(
      Effect.gen(function* () {
        yield* uiPromise(() => run.controlWorkflow(action));
        if (action === "pause" || action === "stop") {
          if (generating) stop();
          setNotice(
            done(action === "pause" ? t`Goal을 일시 중지했습니다.` : t`Goal을 중단했습니다.`),
          );
          return;
        }
        setNotice(null);
        sendMessage(contentOf(chatPrompts.resumeGoal, []));
      }).pipe(
        Effect.catchTag("UnknownError", () =>
          Effect.sync(() => {
            setNotice(problem(t`Goal 상태를 바꾸지 못했습니다.`));
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
    generating || waitingForApproval
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
        if (result === "idle") setNotice(problem(t`멈출 답변이 없습니다.`));
        if (result === "failed") setNotice(problem(t`명령을 실행하지 못했습니다.`));
      }),
    );

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const resumeTask = useCallback(
    (task: TraceTaskView, confirmUncertain: boolean) =>
      runUiEffect(
        Effect.gen(function* () {
          const attemptId = task.latestAttemptId;
          if (!isTruthy(attemptId)) return ResumeActionResult.failed();
          return yield* Effect.gen(function* () {
            const result = yield* uiPromise(() =>
              resumeTrace({
                taskId: task.id,
                attemptId,
                confirmUncertain,
              }),
            );
            if (ResumeTaskResult.guards.queued(result)) {
              setNotice(
                done(t`다시 시도 요청을 저장했습니다. 다음 실행에서 새 attempt로 시작합니다.`),
              );
              return ResumeActionResult.queued();
            }
            if (result.reason !== "uncertain_side_effect")
              setNotice(
                problem(
                  result.reason === "stale_attempt"
                    ? t`작업 상태가 바뀌었습니다. 최신 Work Trace를 확인해 주십시오.`
                    : result.reason === "attempt_alive"
                      ? t`이미 실행 중인 attempt가 있습니다.`
                      : t`이 작업은 지금 다시 시도할 수 없습니다.`,
                ),
              );
            return ResumeActionResult.blocked({ reason: result.reason });
          }).pipe(
            Effect.catchTag("UnknownError", () =>
              Effect.sync(() => {
                setNotice(problem(t`다시 시도 요청을 저장하지 못했습니다.`));
                return ResumeActionResult.failed();
              }),
            ),
          );
        }),
      ),
    [resumeTrace, t],
  );

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const archiveTask = useCallback(
    (task: TraceTaskView) =>
      runUiEffect(
        Effect.gen(function* () {
          const result = yield* uiPromise(() => archiveTrace(task.id));
          if (ArchiveTaskResult.guards.completed(result)) {
            setNotice(
              done(t`작업을 보관했습니다. Work Trace 기록과 project provenance는 유지됩니다.`),
            );
            return ArchiveActionResult.archived();
          }
          setNotice(problem(t`작업 중단을 기다리고 있습니다. 완료 후 다시 확인해 주십시오.`));
          return ArchiveTaskResult.guards.blocked(result)
            ? ArchiveActionResult.blocked({ reason: result.blocker })
            : ArchiveActionResult.failed();
        }).pipe(
          Effect.catchTag("UnknownError", () =>
            Effect.sync(() => {
              setNotice(problem(t`작업을 보관하지 못했습니다.`));
              return ArchiveActionResult.failed();
            }),
          ),
        ),
      ),
    [archiveTrace, t],
  );

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const deleteTask = useCallback(
    (task: TraceTaskView) =>
      runUiEffect(
        Effect.gen(function* () {
          const result = yield* uiPromise(() => deleteTrace(task.id));
          if (ArchiveTaskResult.guards.completed(result)) {
            setNotice(
              done(t`작업 원본을 삭제했습니다. 채택된 project memory와 provenance는 유지됩니다.`),
            );
            return DeleteActionResult.deleted();
          }
          setNotice(problem(t`작업 중단을 기다리고 있습니다. 완료 후 다시 확인해 주십시오.`));
          return ArchiveTaskResult.guards.blocked(result)
            ? DeleteActionResult.blocked({ reason: result.blocker })
            : DeleteActionResult.failed();
        }).pipe(
          Effect.catchTag("UnknownError", () =>
            Effect.sync(() => {
              setNotice(problem(t`작업 원본을 삭제하지 못했습니다.`));
              return DeleteActionResult.failed();
            }),
          ),
        ),
      ),
    [deleteTrace, t],
  );

  const ready = draftImages.images.filter(DraftImage.$is("ready"));
  const uploading = draftImages.images.some(DraftImage.$is("uploading"));
  const failed = draftImages.images.some(DraftImage.$is("failed"));
  const leavingMode = modeLabels[leaving?.move ?? "plan"];
  const shownNotice =
    notice ?? (failed ? problem(t`올리지 못한 이미지가 있습니다. 빼고 보내 주십시오.`) : null);
  const editing = Composer.$is("editing")(composer) ? composer : null;
  const composerMode: ComposerMode =
    editing !== null
      ? ComposerMode.editing()
      : waitingForApproval
        ? ComposerMode.approval()
        : generating
          ? ComposerMode.generating()
          : ComposerMode.idle();
  /** Whether the typed text, with the images ready, can go now. */
  const canSend = (text: string) =>
    (text.trim().length > 0 || ready.length > 0) &&
    !uploading &&
    !failed &&
    !submitting &&
    !waitingForApproval &&
    !mutationBlocked;

  // When this page's run stops, with the messages it took in already read again, read the queue
  // and the run state again. What waits next the server sends itself (2026-11-02).
  const wasGenerating = useRef(generating);
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const handleRunSettled = useEffectEvent(() =>
    runUiEffect(
      uiPromise(() => Promise.all([queue.refresh(), run.refresh()])).pipe(
        Effect.ensuring(Effect.sync(() => setPlacements({}))),
      ),
    ),
  );
  useEffect(() => {
    const settled = wasGenerating.current && !generating;
    wasGenerating.current = generating;
    if (!settled || readOnly) return;
    void handleRunSettled();
  }, [generating, readOnly]);

  const startEdit = (message: QueuedMessage) => {
    if (editing !== null || readOnly) return;
    const text = Match.value(message.state).pipe(
      Match.tag("editing", ({ draft }) => draft),
      Match.tag("held", ({ draft }) => draft ?? message.text),
      Match.orElse(() => message.text),
    );
    setComposer(Composer.editing({ id: message.id, text: Atom.make(text) }));
    setNotice(null);
    void queue.change(message.id, QueueEdit.edit({ draft: text }));
  };

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const finishEdit = (outcome: "save" | "remove", typed = "") =>
    runUiEffect(
      Effect.gen(function* () {
        if (!(editing !== null)) return;
        setComposer(Composer.compose());
        const text = typed.trim();
        yield* uiPromise(() =>
          queue.change(
            editing.id,
            outcome === "save" && text.length > 0 ? QueueEdit.save({ text }) : QueueEdit.remove(),
          ),
        );
      }),
    );

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const confirmQueued = (message: QueuedMessage) =>
    runUiEffect(uiPromise(() => queue.change(message.id, QueueEdit.confirm())));

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const removeQueued = (message: QueuedMessage) =>
    runUiEffect(
      Effect.gen(function* () {
        if (editing?.id === message.id) return yield* uiPromise(() => finishEdit("remove"));
        yield* uiPromise(() => queue.change(message.id, QueueEdit.remove()));
      }),
    );

  /** Alt+↑ picks the last message still waiting, Alt+↓ the first. */
  const pickQueued = (direction: "up" | "down") => {
    if (editing !== null) {
      setNotice(
        problem(t`Enter(저장)나 Esc(지우기)로 편집을 끝낸 뒤 다른 메시지를 고를 수 있습니다.`),
      );
      return;
    }
    const editable = queue.items.filter(isEditable);
    const message = direction === "up" ? editable.at(-1) : editable[0];
    if (isTruthy(message)) startEdit(message);
  };

  const attach = (files: readonly File[]) => {
    if (files.length === 0) return;
    if (!imagesSupported) {
      setNotice(
        problem(t`선택한 모델은 이미지를 읽지 못합니다. 이미지를 지원하는 모델을 골라 주십시오.`),
      );
      return;
    }
    setNotice(null);
    draftImages.add(files);
  };

  /**
   * Enter. While nothing runs it sends a turn. While a run answers it queues the message for the
   * next tool-call boundary. `steer` (Ctrl/⌘+Shift+Enter) cuts the answer being written, unless it
   * has begun a tool call, and the server sends the message next, even if this page is closed.
   */
  const clearComposer = () => {
    setDraft("");
    draftImages.clear();
    media.clearIntent();
    setNotice(null);
  };
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const generateImage = (prompt: string) =>
    runUiEffect(
      Effect.gen(function* () {
        setImagePrompt(null);
        if (yield* uiPromise(() => media.generate(prompt))) clearComposer();
      }),
    );
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const submit = (mode: "queue" | "steer", typed: string) =>
    runUiEffect(
      Effect.gen(function* () {
        if (editing !== null) {
          if (mode === "steer") setNotice(problem(t`편집을 끝낸 뒤 스티어링할 수 있습니다.`));
          else yield* uiPromise(() => finishEdit("save", typed));
          return;
        }
        if (!canSend(typed)) return;
        const written = renumberReferences(
          typed.trim(),
          ready.map((image) => image.number),
        );
        const outsidePanel = (command: Parameters<SlashSupport["run"]>[0]) =>
          Effect.sync(() => {
            setDraft("");
            setNotice(null);
          }).pipe(
            Effect.andThen(uiPromise(() => slash.run(command))),
            Effect.catchTag("UnknownError", () =>
              Effect.sync(() => setNotice(problem(t`명령을 실행하지 못했습니다.`))),
            ),
            Effect.as(Option.none<string>()),
          );
        // What a command leaves to send; none when it ran instead of being sent.
        const runCommand = SlashCommand.$match({
          skill: (command) => Effect.succeedSome(promptOf(command)),
          recall: (command) => Effect.succeedSome(promptOf(command)),
          workflow_status: () =>
            Effect.sync(() => {
              setDraft("");
              setNotice(workflowStatus(run.workflow));
              return Option.none<string>();
            }),
          workflow: (command) =>
            Effect.gen(function* () {
              const state = yield* uiPromise(() => moveWorkflow(command.move));
              if (!isTruthy(state)) return Option.none<string>();
              // An approved Plan runs on its board, so running it sends the chat nothing.
              const request =
                command.request || (command.move === "plan" ? chatPrompts.planDefault : "");
              if (!(request.length > 0)) {
                setDraft("");
                return Option.none<string>();
              }
              return Option.some(request);
            }),
          cancel: () =>
            Effect.sync(() => {
              setDraft("");
              setNotice(null);
              void cancel();
              return Option.none<string>();
            }),
          compact: () =>
            Effect.sync(() => {
              setDraft("");
              setNotice(null);
            }).pipe(
              Effect.andThen(uiPromise(() => compactMutation.mutateAsync())),
              Effect.map((result) => setNotice(compacted(result))),
              Effect.catchTag("UnknownError", (failure) =>
                Effect.sync(() => {
                  setNotice(problem(compactErrorMessage(refusalOf(failure.cause))));
                }),
              ),
              Effect.as(Option.none<string>()),
            ),
          new: outsidePanel,
          agent: outsidePanel,
          mode: outsidePanel,
          model: outsidePanel,
          effort: outsidePanel,
          settings: outsidePanel,
          report: outsidePanel,
        });
        // A slash command runs instead of being sent; `skill` and `recall` become a message.
        const message = yield* SlashParse.$match(
          ready.length === 0 ? parseSlash(written, slash.context) : SlashParse.not_command(),
          {
            not_command: () => Effect.succeedSome(written),
            incomplete: ({ reason }) =>
              Effect.sync(() => {
                setNotice(problem(reason));
                return Option.none<string>();
              }),
            command: ({ command }) => runCommand(command),
          },
        );
        if (Option.isNone(message)) return;
        const text = message.value;
        const attachmentIds = ready.map((image) => image.attachment.id);
        const sendTurn = () => {
          clearComposer();
          sendMessage(contentOf(text, attachmentIds));
        };
        if (!generating && media.intent) {
          if (attachmentIds.length > 0)
            return setNotice(problem(t`첫 버전의 이미지 생성은 텍스트 프롬프트만 지원합니다.`));
          // A paid media model may run, so the dialog asks before `generateImage` does.
          return setImagePrompt(text);
        }
        if (!generating) return sendTurn();
        if (media.intent)
          return setNotice(
            problem(t`이미지 생성 요청은 답변이 끝난 뒤 별도 요청으로 보내 주십시오.`),
          );

        const outcome = yield* uiPromise(() =>
          trackSubmission(queue.add(text, attachmentIds, mode)),
        );
        AddOutcome.$match(outcome, {
          queued: clearComposer,
          "not-running": sendTurn,
          failed: () => setNotice(problem(t`메시지를 넣지 못했습니다. 다시 시도해 주십시오.`)),
        });
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
          {imagesSupported ? (
            <Trans>이미지를 놓으면 첨부됩니다</Trans>
          ) : (
            <Trans>선택한 모델은 이미지를 읽지 못합니다</Trans>
          )}
        </div>
      )}
      <ChatHistory
        messages={messages}
        opened={opened}
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
        <ChatApprovals
          key={approvalBatchKey}
          sessionId={sessionId}
          holder={holder}
          approvals={approvals}
          problem={answerProblem}
          readOnly={readOnly}
          resuming={resuming}
          onResolve={(decisions) =>
            resolveInterrupts(
              approvals.map(({ id }) => approvalAnswer({ id, approved: decisions[id] === true })),
            )
          }
          onResync={onResync}
          onProblem={(message) => setNotice(problem(message))}
        />
        <UncertainRuns
          sessionId={sessionId}
          holder={holder}
          runs={run.uncertainRuns}
          readOnly={readOnly}
          onContinued={() => void run.refresh()}
          onProblem={(message) => setNotice(problem(message))}
        />
        <SubagentPanel
          sessionId={sessionId}
          holder={holder}
          generating={generating}
          readOnly={readOnly}
        />
        {submitted && (
          <Marker role="status">
            <MarkerIcon>
              <Spinner />
            </MarkerIcon>
            <MarkerContent>
              <Trans>생각하는 중…</Trans>
            </MarkerContent>
          </Marker>
        )}
        {/* Between tool calls nothing streams, so the thread itself says the answer goes on. */}
        {generating && !submitted && !waitingForApproval && !endsWithText && (
          <Marker role="status">
            <MarkerIcon>
              <Spinner />
            </MarkerIcon>
            <MarkerContent>
              <Trans>작업 중…</Trans>
            </MarkerContent>
          </Marker>
        )}
        {(refusal !== null || noAnswer !== null) &&
          answerProblem === null &&
          run.notice === null && (
            <Alert variant="destructive">
              <AlertTitle>
                <Trans>응답을 받지 못했습니다</Trans>
              </AlertTitle>
              <AlertDescription>
                <NoAnswer refusal={refusal} error={noAnswer} />
              </AlertDescription>
            </Alert>
          )}
        {!generating && !waitingForApproval && run.notice && <RunNoticeView notice={run.notice} />}
      </ChatHistory>

      <div className="bg-background px-6 pt-2 pb-4">
        <div className="mx-auto max-w-3xl">
          <WorkflowArtifactPanel
            state={run.workflow}
            display={run.display}
            execution={run.execution}
            providerRetry={run.providerRetry}
            actions={run.actions}
            busy={generating}
            disabled={mutationBlocked}
            controlling={run.controlling}
            onPause={() => void controlGoal("pause")}
            onResume={() => void controlGoal("resume")}
            onStop={() => void controlGoal("stop")}
            onRevise={revisePlan}
            onExecute={() => void executePlan()}
            kanbanRunning={kanbanRunning}
            boardTally={<BoardTally projectId={projectId} sessionId={sessionId} />}
            boardAction={
              <OpenBoardButton
                projectId={projectId}
                sessionId={sessionId}
                holder={holder}
                disabled={readOnly || backendRestartRequired}
              />
            }
            boardSlot={
              <WorkflowBoard
                projectId={projectId}
                sessionId={sessionId}
                holder={holder}
                disabled={readOnly || backendRestartRequired}
              />
            }
          />
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
            <DraftComposer
              ref={composerInput}
              textAtom={editing?.text ?? drafts.text}
              onEditDraft={(id, text) => void queue.change(id, QueueEdit.edit({ draft: text }))}
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
              onSubmit={(mode, text) => void submit(mode, text)}
              onAttach={attach}
              onEditQueued={startEdit}
              onRemoveQueued={(message) => void removeQueued(message)}
              onConfirmQueued={(message) => void confirmQueued(message)}
              onFinishEdit={() => void finishEdit("remove")}
              onPickQueued={pickQueued}
              onCancel={() => void cancel()}
              onClear={clearComposer}
              onWorkflowMode={(mode) =>
                run.workflow?.phase === "running"
                  ? setLeaving({ move: mode, revise: false })
                  : void moveWorkflow(mode)
              }
            />
          )}
          <AlertDialog
            open={imagePrompt !== null}
            onOpenChange={(open) => {
              if (!open) setImagePrompt(null);
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  <Trans>이미지를 만들까요?</Trans>
                </AlertDialogTitle>
                <AlertDialogDescription>
                  <Trans>이미지 생성은 별도 유료 미디어 모델을 호출할 수 있습니다.</Trans>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>
                  <Trans>취소</Trans>
                </AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    if (imagePrompt !== null) void generateImage(imagePrompt);
                  }}
                >
                  <Trans comment="Dialog button that generates the image">만들기</Trans>
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <AlertDialog
            open={leaving !== null}
            onOpenChange={(open) => {
              if (!open) setLeaving(null);
            }}
          >
            <AlertDialogContent size="sm">
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {leaving?.revise === true ? (
                    <Trans>실행 중인 Plan을 고칠까요?</Trans>
                  ) : leaving?.move === "chat" ? (
                    <Trans>일반 대화로 바꿀까요?</Trans>
                  ) : (
                    <Trans>{leavingMode} 모드로 바꿀까요?</Trans>
                  )}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  <Trans>
                    보드는 새 카드를 맡기지 않고 기다립니다. 이미 진행 중인 카드는 끝까지
                    실행됩니다.
                  </Trans>{" "}
                  {leaving?.move === "goal" ? (
                    <Trans>Plan 작성자가 Plan을 다시 준비하면 바로 이어서 실행합니다.</Trans>
                  ) : leaving?.move === "plan" ? (
                    <Trans>고친 Plan을 다시 승인하면 이어서 실행합니다.</Trans>
                  ) : (
                    <Trans>Plan이나 Goal 모드에서 다시 승인하면 이어서 실행합니다.</Trans>
                  )}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>
                  <Trans comment="Dialog button: keep the running board as it is">
                    그대로 두기
                  </Trans>
                </AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    if (leaving !== null) void leaveRun(leaving);
                    setLeaving(null);
                  }}
                >
                  {leaving?.revise === true ? (
                    <Trans comment="Dialog button: go on to revise the running Plan">고치기</Trans>
                  ) : (
                    <Trans comment="Dialog button: go on to change the workflow mode">바꾸기</Trans>
                  )}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          {(context || runningBackgroundTasks(workTrace.tasks).length > 0) && (
            <div className="flex items-center gap-2 px-1 pt-1.5">
              <BackgroundTaskIndicator tasks={workTrace.tasks} />
              {context && (
                <div className="ml-auto">
                  <ContextMeter context={context} />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
