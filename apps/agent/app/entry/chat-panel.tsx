import { fetchServerSentEvents, useChat, type UIMessage } from "@tanstack/ai-react";
import { ArrowUpIcon, MessageSquareIcon, SquareIcon } from "lucide-react";
import { approvalToolDefinitions, permissionReviewInterrupt } from "memory-agent/definitions";
import { useEffect, useRef, useState } from "react";
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
import { api } from "./api";
import {
  ApprovalCard,
  toPendingApproval,
  type ApprovalInterrupts,
  type ApprovalTools,
} from "./approval";
import { MessageView } from "./message";

// Stable references: useChat treats a new array as changed options on every render.
const approvalInterrupts: ApprovalInterrupts = [permissionReviewInterrupt];

function Conversation({ sessionId, history }: { sessionId: string; history: UIMessage[] }) {
  const [draft, setDraft] = useState("");
  const bottom = useRef<HTMLDivElement>(null);
  const { messages, sendMessage, stop, isLoading, error, status, interrupts } = useChat<
    ApprovalTools,
    undefined,
    unknown,
    ApprovalInterrupts
  >({
    connection: fetchServerSentEvents(`/api/chat?session=${encodeURIComponent(sessionId)}`),
    initialMessages: history,
    // The same definitions the server uses, so approval requests can be matched and answered:
    // tool approvals in `ask` mode, permission reviews in `auto` mode.
    tools: approvalToolDefinitions,
    interrupts: approvalInterrupts,
  });
  const approvals = interrupts.flatMap((interrupt) => toPendingApproval(interrupt) ?? []);
  const waitingForApproval = interrupts.length > 0;
  const awaitingApproval = new Set(approvals.map((approval) => approval.toolCallId));

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const submit = () => {
    const text = draft.trim();
    if (!text || isLoading || waitingForApproval) return;
    setDraft("");
    void sendMessage(text);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
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
              streaming={isLoading && index === messages.length - 1}
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
          {error && (
            <Alert variant="destructive">
              <AlertTitle>응답을 받지 못했어요</AlertTitle>
              <AlertDescription>{error.message}</AlertDescription>
            </Alert>
          )}
          <div ref={bottom} />
        </div>
      </ScrollArea>

      <div className="border-t bg-background px-6 py-4">
        <form
          className="mx-auto flex max-w-3xl items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends; Shift+Enter adds a line; Enter that confirms Korean IME input does nothing.
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
            }}
            placeholder={
              waitingForApproval
                ? "위의 승인 요청에 먼저 답해 주세요"
                : "메시지를 입력하세요 (Enter 전송 · Shift+Enter 줄바꿈)"
            }
            className="max-h-48 min-h-10 resize-none"
            rows={1}
          />
          {isLoading ? (
            <Button type="button" variant="outline" size="icon-lg" onClick={stop} aria-label="중지">
              <SquareIcon />
            </Button>
          ) : (
            <Button
              type="submit"
              size="icon-lg"
              disabled={!draft.trim() || waitingForApproval}
              aria-label="전송"
            >
              <ArrowUpIcon />
            </Button>
          )}
        </form>
      </div>
    </div>
  );
}

/** Loads a session's stored transcript, then hands it to the live conversation. */
export function ChatPanel({ sessionId }: { sessionId: string }) {
  const [history, setHistory] = useState<UIMessage[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setHistory(null);
    setFailed(false);
    api.messages(sessionId).then(
      (messages) => active && setHistory(messages),
      () => active && setFailed(true),
    );
    return () => {
      active = false;
    };
  }, [sessionId]);

  if (failed)
    return (
      <Alert variant="destructive" className="m-6 w-auto">
        <AlertTitle>대화 기록을 불러오지 못했어요</AlertTitle>
      </Alert>
    );
  if (!history)
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Spinner />
      </div>
    );
  return <Conversation key={sessionId} sessionId={sessionId} history={history} />;
}
