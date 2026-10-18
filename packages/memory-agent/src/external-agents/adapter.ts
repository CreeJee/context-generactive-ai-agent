import { nativePromise } from "../runtime/native-effect.ts";
import { nativeStream } from "../runtime/native-stream.ts";
import { MutableHashMap, Option, Cause, Effect, Stream, Queue, DateTime, Schema } from "effect";
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
import type { ExternalPromptOutcome } from "./agents.ts";

/** Sends one user turn to the external agent; updates arrive through `onUpdate`. */
export type ExternalTurn = (
  text: string,
  signal: AbortSignal,
  onUpdate: (update: SessionUpdate) => void,
) => Promise<ExternalPromptOutcome>;

type Item =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "done"; readonly outcome: ExternalPromptOutcome }
  | { readonly kind: "error"; readonly error: Error };

/** A turn that ended without an answer; the SDK shows its message as the run's error. */
export class ExternalAgentTurnFailed extends Schema.TaggedError<ExternalAgentTurnFailed>()(
  "ExternalAgentTurnFailed",
  {
    reason: Schema.Union([
      /** `detail` is the agent's or the connection's own reason. */
      Schema.TaggedStruct("Unavailable", { detail: Schema.String }),
      Schema.TaggedStruct("Failed", { detail: Schema.String }),
      /** The connection dropped mid-answer; the prompt was not sent again. */
      Schema.TaggedStruct("Disconnected", {}),
    ]),
  },
) {
  override get message() {
    switch (this.reason._tag) {
      case "Unavailable":
        return `외부 에이전트를 쓸 수 없어요: ${this.reason.detail}`;
      case "Failed":
        return `외부 에이전트가 오류로 끝냈어요: ${this.reason.detail}`;
      case "Disconnected":
        return "외부 에이전트 연결이 끊겼어요. 보낸 요청은 다시 보내지 않았어요.";
    }
  }
}

/** Why a turn did not produce an answer, or null when it did. */
function failureOf(outcome: ExternalPromptOutcome): ExternalAgentTurnFailed | null {
  switch (outcome.status) {
    case "completed":
    case "cancelled":
      return null;
    case "unavailable":
      return new ExternalAgentTurnFailed({
        reason: { _tag: "Unavailable", detail: outcome.reason },
      });
    case "failed":
      return new ExternalAgentTurnFailed({ reason: { _tag: "Failed", detail: outcome.error } });
    case "disconnected":
      return new ExternalAgentTurnFailed({ reason: { _tag: "Disconnected" } });
  }
}

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
                            push({ kind: "text", text: update.content.text });
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
                push({ kind: "done", outcome });
              }).pipe(
                // The preamble or the turn rejected; the SDK receives the rejection as thrown.
                Effect.catchTag("UnknownError", ({ cause }) =>
                  Effect.sync(() => {
                    if (signal?.aborted !== true)
                      push({
                        kind: "error",
                        error: cause instanceof Error ? cause : new Error(String(cause)),
                      });
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
        const translate = function* (item: Item): Generator<AdapterYieldChunk, void, unknown> {
          switch (item.kind) {
            case "text":
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
                delta: item.text,
              };
              break;
            case "error":
              throw item.error;
            case "done": {
              if (signal?.aborted === true) return;
              const failure = failureOf(item.outcome);
              // Synchronous SDK iterator: a failed turn is thrown as its typed error.
              if (failure !== null) throw failure;
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
              return;
            }
          }
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
