import { nativePromise } from "../runtime/native-effect.ts";
import { nativeStream } from "../runtime/native-stream.ts";
import { MutableHashMap, Option, Cause, Data, Effect, Stream, Queue, DateTime } from "effect";
import { randomUUID } from "../runtime/synchronous-crypto.ts";
import {
  EventType,
  type AdapterYieldChunk,
  type DefaultMessageMetadataByModality,
  type TextOptions,
} from "@tanstack/ai";
import {
  BaseTextAdapter,
  type StructuredOutputOptions,
  type StructuredOutputResult,
} from "@tanstack/ai/adapters";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { messageText } from "../messages/text.ts";
import { turnFailure } from "../model/external.ts";
import type { ExternalPromptOutcome } from "./agents.ts";

/** Sends one user turn to the external agent; updates arrive through `onUpdate`. */
export type ExternalTurn = (
  text: string,
  signal: AbortSignal,
  onUpdate: (update: SessionUpdate) => void,
) => Promise<ExternalPromptOutcome>;

type Item = Data.TaggedEnum<{
  text: { readonly text: string };
  done: { readonly outcome: ExternalPromptOutcome };
  error: { readonly error: Error };
}>;
const Item = Data.taggedEnum<Item>();

/**
 * TanStack text adapter for a conversation held directly with an external ACP agent. The agent
 * works with its own tools, so the run has none: its text streams as the answer, and the tool
 * calls it reports are listed after it.
 */
export class ExternalAgentAdapter extends BaseTextAdapter<
  string,
  Record<string, never>,
  ["text"],
  DefaultMessageMetadataByModality
> {
  readonly name = "external-acp";

  private readonly turn: ExternalTurn;
  /** Leads the prompt: relevant memory and how to treat it. */
  private readonly preamble: (text: string) => Promise<string>;

  constructor(agent: string, turn: ExternalTurn, preamble: (text: string) => Promise<string>) {
    super({}, agent);
    this.turn = turn;
    this.preamble = preamble;
  }

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  chatStream(options: TextOptions<Record<string, never>>): AsyncIterable<AdapterYieldChunk> {
    const turn = this.turn;
    const preamble = this.preamble;
    return nativeStream(
      Stream.suspend(() => {
        const signal = options.abortController?.signal ?? options.request?.signal ?? undefined;
        const runId = options.runId ?? randomUUID();
        const threadId = options.threadId ?? randomUUID();
        const stamp = () => ({
          model: this.model,
          timestamp: DateTime.toEpochMillis(DateTime.nowUnsafe()),
        });
        const last = options.messages.at(-1);
        const text = last?.role === "user" ? messageText(last) : "";

        const toolTitles = MutableHashMap.empty<string, { title: string; status: string }>();
        const items = Stream.callback<Item>((queue) =>
          Effect.gen(function* () {
            const push = (item: Item) => {
              Queue.offerUnsafe(queue, item);
            };
            const cancel = () => {
              Queue.endUnsafe(queue);
            };
            signal?.addEventListener("abort", cancel, { once: true });
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => signal?.removeEventListener("abort", cancel)),
            );
            if (signal?.aborted === true) {
              cancel();
              return;
            }
            yield* Effect.forkScoped(
              Effect.gen(function* () {
                const lead = yield* nativePromise(() => preamble(text));
                const outcome = yield* Effect.tryPromise({
                  try: (ownerSignal) =>
                    turn(`${lead}${text}`, signal ?? ownerSignal, (update) => {
                      switch (update.sessionUpdate) {
                        case "agent_message_chunk":
                          if (update.content.type === "text")
                            push(Item.text({ text: update.content.text }));
                          return;
                        case "tool_call":
                          MutableHashMap.set(toolTitles, update.toolCallId, {
                            title: update.title,
                            status: update.status ?? "pending",
                          });
                          return;
                        case "tool_call_update": {
                          const known = Option.getOrUndefined(
                            MutableHashMap.get(toolTitles, update.toolCallId),
                          );
                          MutableHashMap.set(toolTitles, update.toolCallId, {
                            title: update.title ?? known?.title ?? "",
                            status: update.status ?? known?.status ?? "",
                          });
                          return;
                        }
                        default:
                          return;
                      }
                    }),
                  catch: (cause) => new Cause.UnknownError(cause),
                });
                push(Item.done({ outcome }));
              }).pipe(
                // The preamble or the turn rejected; the SDK receives the rejection as thrown.
                Effect.catchTag("UnknownError", ({ cause }) =>
                  Effect.sync(() => {
                    if (signal?.aborted !== true)
                      push(
                        Item.error({
                          error: cause instanceof Error ? cause : new Error(String(cause)),
                        }),
                      );
                  }),
                ),
                Effect.onInterrupt(() =>
                  Effect.sync(() => options.abortController?.abort("stream_closed")),
                ),
                Effect.ensuring(Effect.sync(() => Queue.endUnsafe(queue))),
              ),
              { startImmediately: true },
            );
          }),
        );
        const messageId = randomUUID();
        let open = false;
        type Chunks = Generator<AdapterYieldChunk, void, unknown>;
        const textChunks = function* (text: string): Chunks {
          if (!open) {
            open = true;
            yield {
              ...stamp(),
              type: EventType.TEXT_MESSAGE_START,
              messageId,
              role: "assistant",
            };
          }
          yield {
            ...stamp(),
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId,
            delta: text,
          };
        };
        const doneChunks = function* (outcome: ExternalPromptOutcome): Chunks {
          if (signal?.aborted === true) return;
          // Synchronous SDK iterator: a failed turn is thrown as its typed error. The SDK sends its
          // `code` and `message` as the run's `RUN_ERROR`.
          const failure = turnFailure(outcome);
          if (Option.isSome(failure)) throw failure.value;
          if (MutableHashMap.size(toolTitles) > 0) {
            const list = [...MutableHashMap.values(toolTitles)]
              .map((call) => `- ${call.title} (${call.status})`)
              .join("\n");
            if (!open) {
              open = true;
              yield {
                ...stamp(),
                type: EventType.TEXT_MESSAGE_START,
                messageId,
                role: "assistant",
              };
            }
            yield {
              ...stamp(),
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId,
              delta: `\n\n외부 에이전트가 알린 도구 호출:\n${list}`,
            };
          }
          if (open) yield { ...stamp(), type: EventType.TEXT_MESSAGE_END, messageId };
          yield {
            ...stamp(),
            type: EventType.RUN_FINISHED,
            runId,
            threadId,
            finishReason: "stop",
          };
        };
        const translate = function* (item: Item): Chunks {
          yield* Item.$match(item, {
            text: ({ text }) => textChunks(text),
            error: ({ error }) => {
              throw error;
            },
            done: ({ outcome }) => doneChunks(outcome),
          });
        };
        return Stream.concat(
          Stream.make({ ...stamp(), type: EventType.RUN_STARTED, runId, threadId }),
          items.pipe(
            Stream.takeWhile(() => signal?.aborted !== true),
            Stream.flatMap((item) => Stream.fromIterable(translate(item))),
          ),
        );
      }),
    );
  }

  structuredOutput(
    _options: StructuredOutputOptions<Record<string, never>>,
  ): Promise<StructuredOutputResult<never>> {
    return Promise.reject(new Error("External agents do not produce separate structured output."));
  }
}
