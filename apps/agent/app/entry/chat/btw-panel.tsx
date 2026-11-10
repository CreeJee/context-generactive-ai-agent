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
import { problemText } from "../shared/copy-templates";
import { chatCopy } from "./copy";
import { Markdown } from "./markdown";
import { RunFailureText } from "./run-failure";
import { useBtwThread } from "./use-btw-thread";

const copy = chatCopy.btw;

/** The evidence tools a BTW answer may use, as the user reads them. */
function toolLabel(name: string) {
  switch (name) {
    case "find_memory":
      return copy.tools.find_memory;
    case "read_evidence":
      return copy.tools.read_evidence;
    case "trace_evidence":
      return copy.tools.trace_evidence;
    default:
      return name;
  }
}

const threadLabel = (thread: BtwThread) =>
  thread.title ?? copy.newThread(dayAndTime(thread.createdAt));

const unanswered = problemText(copy.unanswered);

/** A refusal's code as the user reads it; an unknown or missing code is a general failure. */
function refusalText(code: string | undefined) {
  switch (code) {
    case "login_required":
      return copy.refusals.login_required;
    case "model_selection_required":
      return copy.refusals.model_selection_required;
    case "run_in_progress":
      return copy.refusals.run_in_progress;
    case "btw_not_found":
      return copy.refusals.btw_not_found;
    case "images_not_supported":
      return copy.refusals.images_not_supported;
    default:
      return unanswered;
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
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const { messages, ask, isLoading, failure, error, refusal } = useBtwThread({
    threadId: thread.id,
    // The thread's title is its first question.
    onAnswered: () =>
      void queryClient.invalidateQueries({
        queryKey: appQueryKeys.session.btw(thread.projectId, thread.parentSessionId),
      }),
  });
  const send = () => {
    const text = draft.trim();
    if (text.length === 0 || isLoading) return;
    setDraft("");
    ask(text);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
        {messages.length === 0 && <p className="text-sm text-muted-foreground">{copy.empty}</p>}
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
            <MarkerContent>{copy.thinking}</MarkerContent>
          </Marker>
        )}
        {(error !== null || failure !== null) && (
          <Alert variant="destructive">
            <AlertTitle>{copy.noResponse}</AlertTitle>
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
          placeholder={copy.placeholder}
          aria-label={copy.inputLabel}
          className="max-h-40 min-h-10"
        />
        <Button type="submit" disabled={isLoading || draft.trim().length === 0}>
          {isLoading && <Spinner />} {copy.send}
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
        aria-label={copy.deleteLabel}
        title={copy.deleteLabel}
        onClick={() => setOpen(true)}
      >
        <Trash2Icon />
      </Button>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{copy.deleteConfirm.title}</DialogTitle>
          <DialogDescription>{copy.deleteConfirm.body}</DialogDescription>
        </DialogHeader>
        {remove.error && (
          <div className="text-sm text-destructive">{btwErrorMessage(remove.error)}</div>
        )}
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>
            {copy.deleteConfirm.choices.cancel}
          </DialogClose>
          <Button
            type="button"
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            {remove.isPending && <Spinner />} {copy.deleteConfirm.choices.delete}
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
          aria-label={copy.open}
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
                {selected !== null ? threadLabel(selected) : copy.sheetTitle}
              </span>
            </SheetTitle>
            <SheetDescription>{copy.separate}</SheetDescription>
            <div className="flex items-center gap-1 pt-1">
              {selected && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void setThreadId(null)}
                >
                  <ArrowLeftIcon /> {copy.backToList}
                </Button>
              )}
              <Button type="button" variant="ghost" size="sm" onClick={close}>
                {copy.backToChat}
              </Button>
              <span className="flex-1" />
              {selected && (
                <DeleteBtwDialog
                  thread={selected}
                  onDeleted={(filesPending) => {
                    void setThreadId(null);
                    setNotice(filesPending ? copy.deletedFilesPending : copy.deleted);
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
                {create.isPending ? <Spinner /> : <PlusIcon />} {copy.create}
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
