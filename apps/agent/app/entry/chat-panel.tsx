import { fetchServerSentEvents, useChat } from "@tanstack/ai-react";
import { ArrowUpIcon, ImagePlusIcon, MessageSquareIcon, SquareIcon } from "lucide-react";
import {
  approvalToolDefinitions,
  attachmentUrl,
  permissionReviewInterrupt,
} from "memory-agent/definitions";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Spinner } from "~/components/ui/spinner";
import { Textarea } from "~/components/ui/textarea";
import { cn } from "~/lib/utils";
import {
  ApprovalCard,
  toPendingApproval,
  type ApprovalInterrupts,
  type ApprovalTools,
} from "./approval";
import { acceptedImageTypes, renumberReferences, useDraftImages } from "./draft-images";
import { DraftImageTray } from "./images";
import { MessageView } from "./message";
import { RunNoticeView, useRunState } from "./run-state";

// Stable references: useChat treats a new array as changed options on every render.
const approvalInterrupts: ApprovalInterrupts = [permissionReviewInterrupt];

const imageFiles = (files: FileList | null) =>
  Array.from(files ?? []).filter((file) => file.type.startsWith("image/"));

/**
 * One session's live conversation. The server owns the transcript: on mount the chat hydrates it by
 * session id, together with any approval still waiting, so a reload shows the same card again.
 */
export function ChatPanel({
  sessionId,
  imagesSupported,
}: {
  sessionId: string;
  imagesSupported: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const draftImages = useDraftImages();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const caretAfterRender = useRef<number | null>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const { messages, sendMessage, stop, isLoading, sessionGenerating, error, status, interrupts } =
    useChat<ApprovalTools, undefined, unknown, ApprovalInterrupts>({
      connection: fetchServerSentEvents(`/api/chat?session=${encodeURIComponent(sessionId)}`),
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
  const run = useRunState(sessionId, generating);

  const cancel = async () => {
    // Stopping only the local stream would leave the run going on the server, so ask it first.
    if (await run.cancel()) stop();
  };

  const ready = draftImages.images.flatMap((image) => (image.status === "ready" ? [image] : []));
  const uploading = draftImages.images.some((image) => image.status === "uploading");
  const failed = draftImages.images.some((image) => image.status === "failed");
  const canSend =
    (draft.trim().length > 0 || ready.length > 0) &&
    !uploading &&
    !failed &&
    !generating &&
    !waitingForApproval;

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

  const submit = () => {
    if (!canSend) return;
    const text = renumberReferences(
      draft.trim(),
      ready.map((image) => image.number),
    );
    setDraft("");
    draftImages.clear();
    void sendMessage({
      content: [
        ...(text.length > 0 ? [{ type: "text" as const, content: text }] : []),
        ...ready.map((image) => ({
          type: "image" as const,
          source: {
            type: "url" as const,
            value: attachmentUrl(image.attachment.id),
            mimeType: image.attachment.mimeType,
          },
        })),
      ],
    });
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
            <ApprovalCard key={approval.id} approval={approval} />
          ))}
          {status === "submitted" && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner /> 생각하는 중…
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

      <div className="border-t bg-background px-6 py-4">
        <DraftImageTray
          images={draftImages.images}
          onReference={insertReference}
          onRemove={draftImages.remove}
        />
        {(notice ?? failed) && (
          <p className="mx-auto max-w-3xl pb-2 text-xs text-destructive">
            {notice ?? "올리지 못한 이미지가 있어요. 빼고 보내 주세요."}
          </p>
        )}
        <form
          className="mx-auto flex max-w-3xl items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
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
          <Button
            type="button"
            variant="ghost"
            size="icon-lg"
            disabled={!imagesSupported}
            title={imagesSupported ? "이미지 첨부" : "선택한 모델은 이미지를 읽지 못해요"}
            aria-label="이미지 첨부"
            onClick={() => filePicker.current?.click()}
          >
            <ImagePlusIcon />
          </Button>
          <Textarea
            ref={textarea}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onPaste={(event) => {
              const files = imageFiles(event.clipboardData.files);
              if (files.length === 0) return;
              event.preventDefault();
              attach(files);
            }}
            onKeyDown={(event) => {
              // Enter that confirms Korean IME input, and Esc that cancels it, belong to the IME.
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              } else if (event.key === "Escape") {
                // Esc clears a draft (text and images); with nothing drafted it stops the run.
                if (draft.length > 0 || draftImages.images.length > 0) {
                  setDraft("");
                  draftImages.clear();
                  setNotice(null);
                } else if (generating) void cancel();
              }
            }}
            placeholder={
              waitingForApproval
                ? "위의 승인 요청에 먼저 답해 주세요"
                : "메시지를 입력하세요 (Enter 전송 · Shift+Enter 줄바꿈 · 이미지 붙여넣기/끌어놓기)"
            }
            className={cn("max-h-48 min-h-10 resize-none")}
            rows={1}
          />
          {generating ? (
            <Button
              type="button"
              variant="outline"
              size="icon-lg"
              disabled={run.cancelling}
              onClick={() => void cancel()}
              aria-label={run.cancelling ? "멈추는 중" : "중지"}
              title={run.cancelling ? "멈추는 중" : "중지 (입력창이 비었을 때 Esc)"}
            >
              {run.cancelling ? <Spinner /> : <SquareIcon />}
            </Button>
          ) : (
            <Button type="submit" size="icon-lg" disabled={!canSend} aria-label="전송">
              <ArrowUpIcon />
            </Button>
          )}
        </form>
      </div>
    </div>
  );
}
