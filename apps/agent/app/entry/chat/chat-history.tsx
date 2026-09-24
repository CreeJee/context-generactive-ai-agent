import type { UIMessage } from "@tanstack/ai-react";
import { MessageSquareIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { ScrollArea } from "~/components/ui/scroll-area";
import { cn } from "cn";

/** Owns history paging and scroll position; the caller owns the content of each message. */
export function ChatHistory({
  messages,
  hasOlderMessages,
  loadOlderMessages,
  renderMessage,
  children,
}: {
  messages: readonly UIMessage[];
  hasOlderMessages: boolean;
  loadOlderMessages: () => Promise<void>;
  renderMessage: (message: UIMessage, index: number) => ReactNode;
  children: ReactNode;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const topSentinel = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  const pendingPrepend = useRef<{
    count: number;
    scrollTop: number;
    scrollHeight: number;
  } | null>(null);
  const [initialScrollDone, setInitialScrollDone] = useState(false);
  const [olderLoadFailed, setOlderLoadFailed] = useState(false);
  const loadPreviousMessages = useCallback(
    async (retry = false) => {
      const scroll = viewport.current;
      if (!scroll || !hasOlderMessages || pendingPrepend.current || (olderLoadFailed && !retry))
        return;
      pendingPrepend.current = {
        count: messages.length,
        scrollTop: scroll.scrollTop,
        scrollHeight: scroll.scrollHeight,
      };
      pinnedToBottom.current = false;
      setOlderLoadFailed(false);
      try {
        await loadOlderMessages();
      } catch {
        pendingPrepend.current = null;
        setOlderLoadFailed(true);
      }
    },
    [hasOlderMessages, loadOlderMessages, messages.length, olderLoadFailed],
  );

  useLayoutEffect(() => {
    const scroll = viewport.current;
    if (!scroll || messages.length === 0) return;
    if (!initialScrollDone) {
      scroll.scrollTop = scroll.scrollHeight;
      pinnedToBottom.current = true;
      setInitialScrollDone(true);
      return;
    }
    const prepend = pendingPrepend.current;
    if (prepend) {
      if (messages.length > prepend.count) {
        // Keep the old viewport content in place when a page is inserted above it.
        scroll.scrollTop = prepend.scrollTop + scroll.scrollHeight - prepend.scrollHeight;
        pendingPrepend.current = null;
      } else if (!hasOlderMessages) {
        pendingPrepend.current = null;
      }
      return;
    }
    if (pinnedToBottom.current) scroll.scrollTop = scroll.scrollHeight;
  }, [messages, hasOlderMessages, initialScrollDone]);

  useEffect(() => {
    const scroll = viewport.current;
    const target = content.current;
    if (!scroll || !target) return;
    const observer = new ResizeObserver(() => {
      if (initialScrollDone && pinnedToBottom.current && !pendingPrepend.current)
        scroll.scrollTop = scroll.scrollHeight;
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [initialScrollDone]);

  useEffect(() => {
    const scroll = viewport.current;
    const target = topSentinel.current;
    if (!initialScrollDone || !hasOlderMessages || olderLoadFailed || !scroll || !target) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) void loadPreviousMessages();
      },
      { root: scroll, rootMargin: "200px 0px 0px 0px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasOlderMessages, initialScrollDone, loadPreviousMessages, olderLoadFailed]);

  return (
    <ScrollArea
      className="min-h-0 flex-1"
      viewportRef={viewport}
      onViewportScroll={(event) => {
        const scroll = event.currentTarget;
        pinnedToBottom.current = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 120;
      }}
    >
      <div
        ref={content}
        className={cn(
          "relative mx-auto flex max-w-3xl flex-col gap-5 px-6 pb-6",
          messages.length > 0 && "pt-6",
        )}
      >
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
        {olderLoadFailed && (
          <Button type="button" variant="outline" onClick={() => void loadPreviousMessages(true)}>
            이전 메시지를 불러오지 못했어요. 다시 시도
          </Button>
        )}
        <div ref={topSentinel} aria-hidden className="absolute top-0 h-px w-full" />
        {messages.map((message, index) => (
          <div key={message.id} data-chat-message>
            {renderMessage(message, index)}
          </div>
        ))}
        {children}
      </div>
    </ScrollArea>
  );
}
