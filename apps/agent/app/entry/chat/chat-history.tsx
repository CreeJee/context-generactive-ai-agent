import type { UIMessage } from "@tanstack/ai-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { MessageSquareIcon } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
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
  const [initialScrollDone, setInitialScrollDone] = useState(false);
  const [olderLoadFailed, setOlderLoadFailed] = useState(false);
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => viewport.current,
    getItemKey: (index) => messages[index]?.id ?? index,
    estimateSize: () => 180,
    overscan: 5,
    anchorTo: "end",
    followOnAppend: "auto",
    scrollEndThreshold: 120,
  });

  const loadPreviousMessages = async () => {
    if (!hasOlderMessages) return;
    setOlderLoadFailed(false);
    try {
      await loadOlderMessages();
    } catch {
      setOlderLoadFailed(true);
    }
  };

  useLayoutEffect(() => {
    if (messages.length === 0 || initialScrollDone) return;
    virtualizer.scrollToEnd();
    setInitialScrollDone(true);
  }, [messages.length, initialScrollDone, virtualizer]);

  return (
    <ScrollArea
      className="min-h-0 flex-1"
      viewportRef={viewport}
      onViewportScroll={(event) => {
        if (initialScrollDone && !olderLoadFailed && event.currentTarget.scrollTop < 200)
          void loadPreviousMessages();
      }}
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-5 px-6 pb-6">
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
          <Button type="button" variant="outline" onClick={() => void loadPreviousMessages()}>
            이전 메시지를 불러오지 못했어요. 다시 시도
          </Button>
        )}
        <div
          className="relative h-(--virtual-height) w-full"
          // SAFETY: This style only sets a CSS custom property consumed by the height utility.
          style={{ "--virtual-height": `${virtualizer.getTotalSize()}px` } as React.CSSProperties}
        >
          {virtualizer.getVirtualItems().map((item) => {
            const message = messages[item.index];
            if (!message) return null;
            return (
              <div
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                className={cn(
                  "absolute top-(--virtual-start) left-0 w-full",
                  item.index === 0 ? "pt-6" : "pt-5",
                )}
                // SAFETY: This style only sets a CSS custom property consumed by the top utility.
                style={{ "--virtual-start": `${item.start}px` } as React.CSSProperties}
              >
                {renderMessage(message, item.index)}
              </div>
            );
          })}
        </div>
        {children}
      </div>
    </ScrollArea>
  );
}
