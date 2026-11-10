import { Trans, useLingui } from "@lingui/react/macro";
import { runUiEffect, uiPromise } from "../shared/ui-effect";
import { Effect } from "effect";
import { ArrowDownIcon, MessageSquareIcon, RefreshCwIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "~/components/ui/message-scroller";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "cn";
import type { ChatMessage } from "memory-agent/chat-api";

/** How close to the bottom, in pixels, still counts as reading the newest message. */
const followDistance = 120;

/**
 * Owns history paging; the message scroller keeps the newest message in view and holds the
 * reading position when an older page is inserted above it. The caller owns each message.
 */
export function ChatHistory({
  messages,
  opened,
  openFailed,
  onReopen,
  hasOlderMessages,
  loadOlderMessages,
  renderMessage,
  children,
}: {
  messages: readonly ChatMessage[];
  /** The conversation was read; only then do no messages show it as new. */
  opened: boolean;
  /** The conversation could not be read; `onReopen` reads it again. */
  openFailed: boolean;
  onReopen: () => void;
  hasOlderMessages: boolean;
  loadOlderMessages: () => Promise<void>;
  renderMessage: (message: ChatMessage, index: number) => ReactNode;
  children: ReactNode;
}) {
  const { t } = useLingui();
  const viewport = useRef<HTMLDivElement>(null);
  const topSentinel = useRef<HTMLDivElement>(null);
  const loading = useRef(false);
  const [olderLoadFailed, setOlderLoadFailed] = useState(false);
  const loadPreviousMessages = useCallback(
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    (retry = false) =>
      runUiEffect(
        Effect.gen(function* () {
          if (!hasOlderMessages || loading.current || (olderLoadFailed && !retry)) return;
          loading.current = true;
          setOlderLoadFailed(false);
          yield* uiPromise(loadOlderMessages).pipe(
            Effect.catchTag("UnknownError", () => Effect.sync(() => setOlderLoadFailed(true))),
            Effect.ensuring(
              Effect.sync(() => {
                loading.current = false;
              }),
            ),
          );
        }),
      ),
    [hasOlderMessages, loadOlderMessages, olderLoadFailed],
  );

  // Recreated as messages arrive, so a page that leaves the top still in view asks for the next.
  useEffect(() => {
    const scroll = viewport.current;
    const target = topSentinel.current;
    if (
      messages.length === 0 ||
      !hasOlderMessages ||
      olderLoadFailed ||
      !(scroll !== null) ||
      !(target !== null)
    )
      return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) void loadPreviousMessages();
      },
      { root: scroll, rootMargin: "200px 0px 0px 0px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasOlderMessages, loadPreviousMessages, messages.length, olderLoadFailed]);

  return (
    <MessageScrollerProvider autoScroll scrollEdgeThreshold={followDistance}>
      <MessageScroller className="flex-1">
        <MessageScrollerViewport
          ref={viewport}
          aria-label={t({
            message: "대화",
            comment: "Accessible name of the scrolling message list",
          })}
        >
          <div ref={topSentinel} aria-hidden className="absolute top-0 h-px w-full" />
          {/* Every child is a scroller item: the first message must come first, so the
              scroller can tell an older page was inserted above it. */}
          <MessageScrollerContent
            className={cn("mx-auto max-w-3xl gap-5 px-4 pb-6", messages.length > 0 && "pt-6")}
          >
            {!opened && !openFailed && (
              <Spinner
                className="mx-auto mt-24"
                aria-label={t({
                  message: "대화를 불러오는 중",
                  comment: "Accessible label of the spinner shown while the conversation loads",
                })}
              />
            )}
            {openFailed && (
              <Empty role="alert" className="mt-24">
                <EmptyHeader>
                  <EmptyTitle>
                    <Trans>대화를 불러오지 못했습니다</Trans>
                  </EmptyTitle>
                  <EmptyDescription>
                    <Trans>서버에 연결되지 않았을 수 있습니다. 다시 시도해 주십시오.</Trans>
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button type="button" variant="outline" size="sm" onClick={onReopen}>
                    <RefreshCwIcon />
                    <Trans comment="Button that loads the conversation again after it failed to load">
                      다시 시도
                    </Trans>
                  </Button>
                </EmptyContent>
              </Empty>
            )}
            {opened && messages.length === 0 && (
              <Empty className="mt-24">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <MessageSquareIcon />
                  </EmptyMedia>
                  <EmptyTitle>
                    <Trans comment="Title of an empty conversation">새 대화</Trans>
                  </EmptyTitle>
                  <EmptyDescription>
                    <Trans>이전 세션과 다른 프로젝트에서 나눈 대화도 기억해서 답합니다.</Trans>
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
            {messages.map((message, index) => (
              <MessageScrollerItem key={message.id} messageId={message.id}>
                {renderMessage(message, index)}
              </MessageScrollerItem>
            ))}
            {children}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        {olderLoadFailed && (
          <Button
            type="button"
            variant="outline"
            className="absolute top-2 left-1/2 -translate-x-1/2"
            onClick={() => void loadPreviousMessages(true)}
          >
            <Trans>이전 메시지를 불러오지 못했습니다. 다시 시도</Trans>
          </Button>
        )}
        <MessageScrollerButton>
          <ArrowDownIcon />
          <span className="sr-only">
            <Trans comment="Button that scrolls the conversation to the newest message">
              맨 아래로
            </Trans>
          </span>
        </MessageScrollerButton>
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
