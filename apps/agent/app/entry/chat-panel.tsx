import { fetchServerSentEvents, useChat } from "@tanstack/ai-react";
import { ArrowUpIcon, CheckIcon, ImagePlusIcon, MessageSquareIcon, SquareIcon } from "lucide-react";
import {
  approvalToolDefinitions,
  attachmentUrl,
  permissionReviewInterrupt,
  sessionHolderHeader,
} from "memory-agent/definitions";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
import { ScrollArea } from "~/components/ui/scroll-area";
import { Spinner } from "~/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import {
  ApprovalCard,
  toPendingApproval,
  type ApprovalInterrupts,
  type ApprovalTools,
} from "./approval";
import { acceptedImageTypes, renumberReferences, useDraftImages } from "./draft-images";
import { DraftImageTray } from "./images";
import { api, type QueuedMessage } from "./api";
import { ComposerShortcuts, ComposerStatus, type ComposerMode } from "./composer-status";
import { MessageView } from "./message";
import { isPending, useMessageQueue } from "./message-queue";
import { QueuePanel } from "./queue-panel";
import { SubagentPanel } from "./subagent-panel";
import { ReadOnlyBar } from "./read-only-bar";
import { RunNoticeView, useRunState } from "./run-state";
import { useSessionLease, type PageLease } from "./session-lease";
import { SlashPalette } from "./slash-palette";
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
type Composer =
  | { readonly kind: "compose" }
  /** `stash` is the new message the user was writing before picking the queued one. */
  | { readonly kind: "editing"; readonly id: string; readonly stash: string };

/** Unsaved edit text is stored after typing pauses this long. */
const editDraftSaveMs = 400;

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
  const reading = lease.state === "other" || lease.state === "free";
  return (
    <ChatPanel
      key={reading ? `read:${revision}` : "write"}
      sessionId={sessionId}
      holder={holder}
      lease={lease}
      refused={refused}
      onContinue={() => void continueHere()}
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
  imagesSupported,
  slash,
}: {
  sessionId: string;
  holder: string;
  lease: PageLease;
  refused: boolean;
  onContinue: () => void;
  imagesSupported: boolean;
  slash: SlashSupport;
}) {
  const readOnly = lease.state !== "mine";
  const [draft, setDraft] = useState("");
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
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
  } = useChat<ApprovalTools, undefined, unknown, ApprovalInterrupts>({
    connection: fetchServerSentEvents(`/api/chat?session=${encodeURIComponent(sessionId)}`, {
      // The server refuses sends and approval answers from a page that does not hold the session.
      headers: { [sessionHolderHeader]: holder },
    }),
    threadId: sessionId,
    persistence: true,
    // The same definitions the server uses, so approval requests can be matched and answered:
    // tool approvals in `ask` mode, permission reviews in `auto` mode.
    tools: approvalToolDefinitions,
    interrupts: approvalInterrupts,
  });
  const approvals = interrupts.flatMap((interrupt) => toPendingApproval(interrupt) ?? []);
  const waitingForApproval = interrupts.length > 0;
  const awaitingApproval = new Set(approvals.map((approval) => approval.toolCallId));
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
  const queue = useMessageQueue(sessionId, holder, generating);
  const [composer, setComposer] = useState<Composer>({ kind: "compose" });
  const [submitting, setSubmitting] = useState(false);
  // Slash command suggestions for what is typed, and which one the arrow keys point at.
  const [highlight, setHighlight] = useState(0);
  const suggestions = composer.kind === "compose" ? suggest(draft, slash.context) : [];
  const highlighted = suggestions[Math.min(highlight, suggestions.length - 1)] ?? null;

  const cancel = async () => {
    // Stopping only the local stream would leave the run going on the server, so ask it first.
    if (await run.cancel()) stop();
  };

  const ready = draftImages.images.flatMap((image) => (image.status === "ready" ? [image] : []));
  const uploading = draftImages.images.some((image) => image.status === "uploading");
  const failed = draftImages.images.some((image) => image.status === "failed");
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
    !readOnly;

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
  useEffect(() => {
    const settled = wasGenerating.current && !generating;
    wasGenerating.current = generating;
    if (!settled || readOnly) return;
    void (async () => {
      const [items, state] = await Promise.all([
        queue.refresh(),
        api.sessionRunState(sessionId, holder).catch(() => null),
      ]);
      if (!items || !state || state.running || state.lastRun?.status === "interrupted") return;
      const tookInQueued = items.some(
        (message) => message.state.kind === "delivered" && message.state.via !== "next_turn",
      );
      if (tookInQueued) setMessages((await api.transcript(sessionId)).messages);
      if (state.lastRun?.status === "completed") sendNextQueued(items);
    })();
    // Runs only on the generating → idle edge.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [generating]);

  // Unsaved edit text is stored as it is typed, so a restart restores it as a draft.
  useEffect(() => {
    if (!editing) return;
    const timer = setTimeout(
      () => void queue.change(editing.id, { action: "edit", draft }),
      editDraftSaveMs,
    );
    return () => clearTimeout(timer);
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, editing?.id]);

  const startEdit = (message: QueuedMessage) => {
    if (editing || readOnly) return;
    const text =
      message.state.kind === "editing"
        ? message.state.draft
        : message.state.kind === "held" && message.state.draft !== null
          ? message.state.draft
          : message.text;
    setComposer({ kind: "editing", id: message.id, stash: draft });
    caretAfterRender.current = text.length;
    setDraft(text);
    setNotice(null);
    void queue.change(message.id, { action: "edit", draft: text });
  };

  const finishEdit = async (outcome: "save" | "remove") => {
    if (!editing) return;
    setComposer({ kind: "compose" });
    setDraft(editing.stash);
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
      setNotice("Enter로 저장하거나 Esc로 지운 뒤 다른 메시지를 고를 수 있어요.");
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
      setNotice("선택한 모델은 이미지를 읽지 못해요. 이미지를 지원하는 모델을 고르세요.");
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
      if (mode === "steer") setNotice("편집을 끝낸 뒤 스티어링할 수 있어요.");
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
        return setNotice(parsed.reason);
      case "command": {
        const command = parsed.command;
        switch (command.kind) {
          case "skill":
          case "recall":
            text = promptOf(command);
            break;
          case "cancel":
            setDraft("");
            setNotice(generating ? null : "멈출 답변이 없어요.");
            if (generating) void cancel();
            return;
          case "new":
          case "agent":
          case "mode":
          case "model":
          case "settings":
            setDraft("");
            setNotice(null);
            return slash.run(command).catch(() => setNotice("명령을 실행하지 못했어요."));
        }
      }
    }
    const attachmentIds = ready.map((image) => image.attachment.id);
    const clearDraft = () => {
      setDraft("");
      draftImages.clear();
      setNotice(null);
    };
    const sendTurn = () => {
      clearDraft();
      void sendMessage(contentOf(text, attachmentIds));
    };
    if (!generating) return sendTurn();

    setSubmitting(true);
    const outcome = await queue.add(text, attachmentIds, mode);
    setSubmitting(false);
    switch (outcome.kind) {
      case "queued":
      case "steered":
        return clearDraft();
      case "not-running":
        return sendTurn();
      case "steer-unavailable":
        return setNotice("지금은 바로 전달할 수 없어요. Enter로 대기열에 넣을 수 있어요.");
      case "failed":
        return setNotice("메시지를 넣지 못했어요. 다시 시도해 주세요.");
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
            <MessageView
              key={message.id}
              message={message}
              streaming={generating && index === messages.length - 1}
              awaitingApproval={awaitingApproval}
            />
          ))}
          {approvals.map((approval) => (
            <ApprovalCard key={approval.id} approval={approval} disabled={readOnly} />
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
          {error && run.notice === null && (
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
          {(notice ?? failed) && (
            <p className="px-1 pb-1.5 text-xs text-destructive">
              {notice ?? "올리지 못한 이미지가 있어요. 빼고 보내 주세요."}
            </p>
          )}
          {lease.state === "other" || lease.state === "free" ? (
            <ReadOnlyBar lease={lease} refused={refused} onContinue={onContinue} />
          ) : (
            <form
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
                  highlighted={highlighted}
                  onPick={(suggestion) => {
                    caretAfterRender.current = suggestion.text.length;
                    setDraft(suggestion.text);
                    setHighlight(0);
                  }}
                />
              )}
              <PromptInput editing={editing !== null}>
                <QueuePanel
                  items={queue.items}
                  editingId={editing?.id ?? null}
                  readOnly={readOnly}
                  showDelivered={generating || waitingForApproval}
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
                  disabled={readOnly}
                  onChange={(event) => {
                    setDraft(event.target.value);
                    setHighlight(0);
                  }}
                  onPaste={(event) => {
                    const files = imageFiles(event.clipboardData.files);
                    if (files.length === 0) return;
                    event.preventDefault();
                    attach(files);
                  }}
                  onKeyDown={(event) => {
                    // Enter that confirms Korean IME input, and Esc that cancels it, belong to the IME.
                    if (event.nativeEvent.isComposing) return;
                    if (suggestions.length > 0 && highlighted) {
                      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                        event.preventDefault();
                        const step = event.key === "ArrowDown" ? 1 : -1;
                        setHighlight(
                          (Math.min(highlight, suggestions.length - 1) +
                            step +
                            suggestions.length) %
                            suggestions.length,
                        );
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
                        setHighlight(0);
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
                      else if (draft.length > 0 || draftImages.images.length > 0) {
                        setDraft("");
                        draftImages.clear();
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
                          disabled={!imagesSupported || readOnly || editing !== null}
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
                  <ComposerStatus mode={composerMode} />
                  <div className="ml-auto flex items-center gap-3">
                    <ComposerShortcuts mode={composerMode} />
                    {generating && !editing && (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <PromptInputButton
                              variant="outline"
                              disabled={run.cancelling || readOnly}
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
                      disabled={editing ? readOnly : !canSend}
                      aria-label={editing ? "저장" : generating ? "대기열에 넣기" : "전송"}
                    >
                      {editing ? <CheckIcon /> : <ArrowUpIcon />}
                    </PromptInputButton>
                  </div>
                </PromptInputFooter>
              </PromptInput>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
