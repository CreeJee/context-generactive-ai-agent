import { Trans, useLingui } from "@lingui/react/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import {
  ArrowLeftIcon,
  MessageCircleQuestionIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react";
import { parseAsString, useQueryState } from "nuqs";
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Bubble, BubbleContent } from "~/components/ui/bubble";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Marker, MarkerContent, MarkerIcon } from "~/components/ui/marker";
import { Message, MessageContent } from "~/components/ui/message";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "~/components/ui/sheet";
import { Spinner } from "~/components/ui/spinner";
import { Textarea } from "~/components/ui/textarea";
import { TraceIcon, TraceLine, TraceTitle } from "~/components/ui/trace";
import { dayAndTime } from "~/lib/dates";
import type { ChatMessage } from "memory-agent/chat-api";
import { api, isApiError, type BtwThread } from "../api";
import { appQueryKeys } from "../queries/keys";
import { sessionQueries } from "../queries/session";
import { Markdown } from "./markdown";
import { RunFailureText } from "./run-failure";
import { useBtwThread } from "./use-btw-thread";

/** The evidence tools a BTW answer may use, as the user reads them. */
function toolLabel(name: string) {
  switch (name) {
    case "find_memory":
      return <Trans comment="BTW tool call: searches the project's memory">기억 검색</Trans>;
    case "read_evidence":
      return <Trans comment="BTW tool call: reads the original source text">원문 열람</Trans>;
    case "trace_evidence":
      return <Trans comment="BTW tool call: follows where a memory came from">출처 추적</Trans>;
    default:
      return name;
  }
}

function threadLabel(thread: BtwThread) {
  const createdAt = dayAndTime(thread.createdAt);
  return thread.title ?? <Trans>새 BTW · {createdAt}</Trans>;
}

/** A refusal's code as the user reads it; an unknown or missing code is a general failure. */
function refusalText(code: string | undefined) {
  switch (code) {
    case "login_required":
      return <Trans>선택한 공급자에 로그인해야 합니다.</Trans>;
    case "model_selection_required":
      return <Trans>먼저 모델을 선택해 주십시오.</Trans>;
    case "run_in_progress":
      return <Trans>이 BTW가 아직 답하는 중입니다.</Trans>;
    case "btw_not_found":
      return <Trans>이 BTW는 삭제되었습니다.</Trans>;
    case "images_not_supported":
      return <Trans>선택한 모델은 이미지를 읽지 못합니다.</Trans>;
    default:
      return <Trans>답하지 못했습니다. 잠시 후 다시 시도해 주십시오.</Trans>;
  }
}

function btwErrorMessage(error: Error) {
  return isApiError(error) ? refusalText(error.code) : <RunFailureText error={error} />;
}

function BtwMessage({ message, streaming }: { message: ChatMessage; streaming: boolean }) {
  if (message.role === "user") {
    const text = message.parts.flatMap((part) => (part.type === "text" ? [part.content] : []));
    return (
      <Message align="end">
        <MessageContent>
          <Bubble variant="muted">
            <BubbleContent>
              <p className="text-sm/relaxed whitespace-pre-wrap">{text.join("")}</p>
            </BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>
    );
  }
  return (
    <Message>
      <MessageContent>
        {message.parts.map((part, index) => {
          switch (part.type) {
            case "text":
              return <Markdown key={index} text={part.content} streaming={streaming} />;
            case "tool-call":
              return (
                <TraceLine key={part.id}>
                  <TraceIcon>
                    <SearchIcon />
                  </TraceIcon>
                  <TraceTitle>{toolLabel(part.name)}</TraceTitle>
                </TraceLine>
              );
            default:
              return null;
          }
        })}
      </MessageContent>
    </Message>
  );
}

/** One BTW thread: its saved transcript and the next side question. */
function BtwConversation({ thread }: { thread: BtwThread }) {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  /** The question on its way, which returns to the box if the server does not take it. */
  const [asked, setAsked] = useState<string | null>(null);
  const { messages, ask, isLoading, failure, error, refusal } = useBtwThread({
    threadId: thread.id,
    // The thread's title is its first question.
    onAnswered: () =>
      void queryClient.invalidateQueries({
        queryKey: appQueryKeys.session.btw(thread.projectId, thread.parentSessionId),
      }),
    // A question that did not go returns to the box, unless something new was written there.
    onNotTaken: (question) => {
      if (asked === null || question !== asked) return;
      setAsked(null);
      setDraft((current) => (current.length === 0 ? asked : current));
    },
  });
  const send = () => {
    const text = draft.trim();
    if (text.length === 0 || isLoading) return;
    setDraft("");
    setAsked(text);
    ask(text);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
        {messages.length === 0 && (
          <p className="text-sm text-muted-foreground">
            <Trans>메인 대화를 보면서 따로 묻고 싶은 것을 물어봐 주십시오.</Trans>
          </p>
        )}
        {messages.map((message, index) => (
          <BtwMessage
            key={message.id}
            message={message}
            streaming={isLoading && index === messages.length - 1}
          />
        ))}
        {isLoading && messages.at(-1)?.role === "user" && (
          <Marker role="status">
            <MarkerIcon>
              <Spinner />
            </MarkerIcon>
            <MarkerContent>
              <Trans>생각하는 중…</Trans>
            </MarkerContent>
          </Marker>
        )}
        {(error !== null || failure !== null) && (
          <Alert variant="destructive">
            <AlertTitle>
              <Trans>응답을 받지 못했습니다</Trans>
            </AlertTitle>
            <AlertDescription>
              {failure !== null ? <RunFailureText error={failure} /> : refusalText(refusal?.error)}
            </AlertDescription>
          </Alert>
        )}
      </div>
      <form
        className="flex items-end gap-2 border-t px-4 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <Textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            send();
          }}
          placeholder={t`BTW로 물어보기`}
          aria-label={t`BTW 질문`}
          className="max-h-40 min-h-10"
        />
        <Button type="submit" disabled={isLoading || draft.trim().length === 0}>
          {isLoading && <Spinner />}{" "}
          <Trans comment="Button that sends the BTW question">보내기</Trans>
        </Button>
      </form>
    </div>
  );
}

function DeleteBtwDialog({
  thread,
  onDeleted,
}: {
  thread: BtwThread;
  onDeleted: (filesPending: boolean) => void;
}) {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const remove = useMutation({
    mutationFn: () => api.deleteBtw(thread.id),
    onSuccess: (result) => {
      setOpen(false);
      void queryClient.invalidateQueries({
        queryKey: appQueryKeys.session.btw(thread.projectId, thread.parentSessionId),
      });
      onDeleted(result.filesPending);
    },
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        type="button"
        variant="ghost-muted"
        size="icon-sm"
        aria-label={t`BTW 삭제`}
        title={t`BTW 삭제`}
        onClick={() => setOpen(true)}
      >
        <Trash2Icon />
      </Button>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            <Trans>이 BTW를 삭제할까요?</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              질문·답변·근거 조회 기록과 이 BTW에만 쓰인 이미지를 이 기기의 활성 저장소에서
              지웁니다. 이미 만들어진 백업, 데이터베이스 파일에 남은 빈 공간이나 WAL 기록, 모델
              제공자에게 이미 보낸 내용은 지워진다고 보장할 수 없습니다.
            </Trans>
          </DialogDescription>
        </DialogHeader>
        {remove.error && (
          <div className="text-sm text-destructive">{btwErrorMessage(remove.error)}</div>
        )}
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>
            <Trans comment="Button that closes the delete dialog without deleting">취소</Trans>
          </DialogClose>
          <Button
            type="button"
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            {remove.isPending && <Spinner />}{" "}
            <Trans comment="Button that deletes the BTW thread">삭제</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * BTW side questions about the open conversation. Closing returns to the main conversation; the
 * BTW stays listed here for reopening until it is deleted.
 */
export function BtwPanel({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const [threadId, setThreadId] = useQueryState("btw", parseAsString);
  const [open, setOpen] = useState(threadId !== null);
  const [notice, setNotice] = useState<string | null>(null);
  const threads = useQuery({ ...sessionQueries.btw(projectId, sessionId), enabled: open });
  const selected = threads.data?.find((thread) => thread.id === threadId) ?? null;
  // Returning to the main conversation forgets the open thread, so another conversation never
  // opens with this one's BTW; the thread stays listed for reopening.
  const close = () => {
    setOpen(false);
    void setThreadId(null);
  };
  const create = useMutation({
    mutationFn: () => api.createBtw(sessionId),
    onSuccess: (thread) => {
      void queryClient.invalidateQueries({
        queryKey: appQueryKeys.session.btw(projectId, sessionId),
      });
      setNotice(null);
      void setThreadId(thread.id);
    },
  });

  return (
    <>
      {!open && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="fixed top-3 right-12 z-30"
          aria-label={t`BTW 열기`}
          onClick={() => setOpen(true)}
        >
          <MessageCircleQuestionIcon /> BTW
        </Button>
      )}
      <Sheet open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
        <SheetContent className="min-w-0 sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>
              <span className="flex items-center gap-2">
                <MessageCircleQuestionIcon aria-hidden />
                {selected !== null ? threadLabel(selected) : <Trans>BTW 별도 질문</Trans>}
              </span>
            </SheetTitle>
            <SheetDescription>
              <Trans>
                메인 대화와 이 프로젝트의 기억을 읽고 근거를 찾아 답합니다. 여기서 나눈
                질문·답변·조회 결과는 메인 대화나 검색 기억에 들어가지 않습니다. 닫아도 다시 열 수
                있게 이 BTW에만 남습니다.
              </Trans>
            </SheetDescription>
            <div className="flex items-center gap-1 pt-1">
              {selected && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void setThreadId(null)}
                >
                  <ArrowLeftIcon /> <Trans>BTW 목록</Trans>
                </Button>
              )}
              <Button type="button" variant="ghost" size="sm" onClick={close}>
                <Trans>원래 대화로 돌아가기</Trans>
              </Button>
              <span className="flex-1" />
              {selected && (
                <DeleteBtwDialog
                  thread={selected}
                  onDeleted={(filesPending) => {
                    void setThreadId(null);
                    setNotice(
                      filesPending
                        ? t`BTW를 삭제했습니다. 일부 이미지 파일은 다음 정리 때 지워집니다.`
                        : t`BTW를 삭제했습니다.`,
                    );
                  }}
                />
              )}
            </div>
          </SheetHeader>
          {selected !== null ? (
            <BtwConversation key={selected.id} thread={selected} />
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 py-3">
              {notice && <p className="text-xs text-muted-foreground">{notice}</p>}
              <Button
                type="button"
                variant="outline"
                disabled={create.isPending}
                onClick={() => create.mutate()}
              >
                {create.isPending ? <Spinner /> : <PlusIcon />} <Trans>새 BTW 열기</Trans>
              </Button>
              {create.error && (
                <div className="text-sm text-destructive">{btwErrorMessage(create.error)}</div>
              )}
              {threads.isPending && open && <Spinner />}
              {threads.data?.map((thread) => (
                <button
                  key={thread.id}
                  type="button"
                  className={cn(
                    "rounded-md px-3 py-2 text-left text-sm hover:bg-muted",
                    "flex flex-col gap-0.5",
                  )}
                  onClick={() => void setThreadId(thread.id)}
                >
                  <span className="truncate">{threadLabel(thread)}</span>
                  <span className="text-xs text-muted-foreground">
                    {dayAndTime(thread.createdAt)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
