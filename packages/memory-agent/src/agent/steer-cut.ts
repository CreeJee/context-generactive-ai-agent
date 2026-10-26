import { EventType, type AdapterYieldChunk } from "@tanstack/ai";
import {
  Cause,
  DateTime,
  Deferred,
  Effect,
  Exit,
  HashSet,
  Match,
  MutableRef,
  Option,
  Stream,
} from "effect";
import { type LanguageModel, Response } from "effect/ai";
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

/** What the response being streamed has opened, as far as the run has received it. */
interface Opened {
  readonly cut: Deferred.Deferred<void>;
  readonly text: HashSet.HashSet<string>;
  readonly reasoning: HashSet.HashSet<string>;
  /** The response began a tool call, which must run. */
  readonly toolCall: boolean;
  readonly finished: boolean;
}

const openedBy = (opened: Opened, part: Response.AnyPart): Opened =>
  Match.value(part).pipe(
    Match.discriminators("type")({
      "text-start": ({ id }) => ({ ...opened, text: HashSet.add(opened.text, id) }),
      "text-end": ({ id }) => ({ ...opened, text: HashSet.remove(opened.text, id) }),
      "reasoning-start": ({ id }) => ({ ...opened, reasoning: HashSet.add(opened.reasoning, id) }),
      "reasoning-end": ({ id }) => ({
        ...opened,
        reasoning: HashSet.remove(opened.reasoning, id),
      }),
      "tool-params-start": () => ({ ...opened, toolCall: true }),
      "tool-call": () => ({ ...opened, toolCall: true }),
      finish: () => ({ ...opened, finished: true }),
    }),
    Match.orElse(() => opened),
  );

/** The parts that end a cut response: what it opened, closed, and a stop that reports no usage. */
const closing = (opened: Opened): ReadonlyArray<Response.AnyPart> => [
  ...[...opened.reasoning].map((id) => Response.makePart("reasoning-end", { id })),
  ...[...opened.text].map((id) => Response.makePart("text-end", { id })),
  Response.makePart("finish", {
    reason: "stop",
    usage: Response.Usage.make({ inputTokens: {}, outputTokens: {} }),
  }),
];

/**
 * {@link steerCuttable} for an Effect AI model: the run's model can stop its current response where
 * it is, closing what it opened, so the run completes and the steered message follows at once as
 * the next turn.
 */
export const steerCuttableModel = (model: LanguageModel.LanguageModel) => {
  const current = MutableRef.make(Option.none<MutableRef.MutableRef<Opened>>());
  const cuttable = <E, R>(parts: Stream.Stream<Response.AnyPart, E, R>) =>
    Stream.suspend(() => {
      const opened = MutableRef.make<Opened>({
        cut: Deferred.makeUnsafe<void>(),
        text: HashSet.empty(),
        reasoning: HashSet.empty(),
        toolCall: false,
        finished: false,
      });
      const { cut } = MutableRef.get(opened);
      return parts.pipe(
        Stream.interruptWhen(Deferred.await(cut)),
        // Tracked once received, so a cut closes exactly what the run has.
        Stream.tap((part) =>
          Effect.sync(() => MutableRef.update(opened, (was) => openedBy(was, part))),
        ),
        Stream.concat(
          Stream.suspend(() =>
            Deferred.isDoneUnsafe(cut) && !MutableRef.get(opened).finished
              ? Stream.fromIterable(closing(MutableRef.get(opened)))
              : Stream.empty,
          ),
        ),
        Stream.onStart(Effect.sync(() => MutableRef.set(current, Option.some(opened)))),
        Stream.ensuring(
          Effect.sync(() =>
            MutableRef.update(
              current,
              Option.filter((streaming) => streaming !== opened),
            ),
          ),
        ),
      );
    });
  const steer: SteerCut = {
    cut: () =>
      Option.exists(MutableRef.get(current), (streaming) => {
        const { cut, toolCall, finished } = MutableRef.get(streaming);
        return !toolCall && !finished && Deferred.doneUnsafe(cut, Exit.void);
      }),
  };
  return {
    // SAFETY: the parts pass through unchanged; a cut adds only ends of what the response opened
    // and a finish, which every request's part type has.
    model: {
      ...model,
      streamText: ((options: Parameters<LanguageModel.LanguageModel["streamText"]>[0]) =>
        cuttable(model.streamText(options))) as LanguageModel.LanguageModel["streamText"],
    },
    steer,
  };
};
