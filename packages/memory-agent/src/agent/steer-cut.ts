import { EventType, type AdapterYieldChunk } from "@tanstack/ai";
import { Cause, DateTime, Deferred, Effect, Exit, Stream } from "effect";
import type { RunTextAdapter } from "../providers/contracts.ts";
import { nativeStream } from "../runtime/native-stream.ts";

/** The model response being streamed now, as far as the run has received it. */
interface Streaming {
  readonly cut: Deferred.Deferred<void>;
  runId: string | undefined;
  threadId: string | undefined;
  readonly openText: Set<string>;
  readonly openReasoning: Set<string>;
  toolCall: boolean;
  finished: boolean;
}

export interface SteerCut {
  /**
   * Ends the response streaming now as if the model had stopped there. False when no response is
   * streaming, or it has begun a tool call: that call must run, and the message joins the request
   * after it.
   */
  readonly cut: () => boolean;
}

/**
 * Lets a steered message interrupt the answer: the run's adapter can stop its current response
 * where it is, closing what it opened, so the run completes and the steered message follows at
 * once as the next turn. Reasoning cut before its encrypted value is not replayed by the adapters.
 */
export const steerCuttable = (adapter: RunTextAdapter): SteerCut => {
  let current: Streaming | null = null;
  const original = adapter.chatStream.bind(adapter);
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  adapter.chatStream = (options) => {
    const streaming: Streaming = {
      cut: Deferred.makeUnsafe<void>(),
      runId: options.runId,
      threadId: options.threadId,
      openText: new Set(),
      openReasoning: new Set(),
      toolCall: false,
      finished: false,
    };
    const track = (chunk: AdapterYieldChunk) => {
      switch (chunk.type) {
        case EventType.RUN_STARTED:
          streaming.runId = chunk.runId;
          streaming.threadId = chunk.threadId;
          break;
        case EventType.TEXT_MESSAGE_START:
          streaming.openText.add(chunk.messageId);
          break;
        case EventType.TEXT_MESSAGE_END:
          streaming.openText.delete(chunk.messageId);
          break;
        case EventType.REASONING_MESSAGE_START:
          streaming.openReasoning.add(chunk.messageId);
          break;
        case EventType.REASONING_MESSAGE_END:
          streaming.openReasoning.delete(chunk.messageId);
          break;
        case EventType.TOOL_CALL_START:
          streaming.toolCall = true;
          break;
        case EventType.RUN_FINISHED:
          streaming.finished = true;
          break;
      }
    };
    const closing = (): AdapterYieldChunk[] => {
      const stamp = {
        model: adapter.model,
        timestamp: DateTime.toEpochMillis(DateTime.nowUnsafe()),
      };
      return [
        ...[...streaming.openReasoning].map((messageId): AdapterYieldChunk => ({
          ...stamp,
          type: EventType.REASONING_MESSAGE_END,
          messageId,
        })),
        ...[...streaming.openText].map((messageId): AdapterYieldChunk => ({
          ...stamp,
          type: EventType.TEXT_MESSAGE_END,
          messageId,
        })),
        {
          ...stamp,
          type: EventType.RUN_FINISHED,
          runId: streaming.runId ?? "",
          threadId: streaming.threadId ?? "",
          finishReason: "stop",
        },
      ];
    };
    return nativeStream(
      Stream.fromAsyncIterable(original(options), (cause) => new Cause.UnknownError(cause)).pipe(
        Stream.interruptWhen(Deferred.await(streaming.cut)),
        // Tracked once emitted, so a cut closes exactly what the run has received.
        Stream.tap((chunk) => Effect.sync(() => track(chunk))),
        Stream.concat(
          Stream.suspend(() =>
            Deferred.isDoneUnsafe(streaming.cut) && !streaming.finished
              ? Stream.fromIterable(closing())
              : Stream.empty,
          ),
        ),
        Stream.ensuring(
          Effect.sync(() => {
            if (current === streaming) current = null;
          }),
        ),
        Stream.onStart(Effect.sync(() => (current = streaming))),
      ),
    );
  };
  return {
    cut: () => {
      if (current === null || current.toolCall || current.finished) return false;
      return Deferred.doneUnsafe(current.cut, Exit.void);
    },
  };
};
