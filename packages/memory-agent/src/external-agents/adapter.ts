import { randomUUID } from "node:crypto";
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
import { messageText } from "../codex/history.ts";
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

/** Why a turn did not produce an answer, as the page shows it. */
function failureOf(outcome: ExternalPromptOutcome): string | null {
  switch (outcome.status) {
    case "completed":
    case "cancelled":
      return null;
    case "unavailable":
      return `외부 에이전트를 쓸 수 없어요: ${outcome.reason}`;
    case "failed":
      return `외부 에이전트가 오류로 끝냈어요: ${outcome.error}`;
    case "disconnected":
      return "외부 에이전트 연결이 끊겼어요. 보낸 요청은 다시 보내지 않았어요.";
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

  constructor(
    agent: string,
    private readonly turn: ExternalTurn,
    /** Leads the prompt: relevant memory and how to treat it. */
    private readonly preamble: (text: string) => Promise<string>,
  ) {
    super({}, agent);
  }

  async *chatStream(options: TextOptions<Record<string, never>>): AsyncIterable<AdapterYieldChunk> {
    const signal =
      options.abortController?.signal ?? options.request?.signal ?? new AbortController().signal;
    const runId = options.runId ?? randomUUID();
    const threadId = options.threadId ?? randomUUID();
    const stamp = () => ({ model: this.model, timestamp: Date.now() });
    const last = options.messages.at(-1);
    const text = last?.role === "user" ? messageText(last) : "";

    const queue: Item[] = [];
    let wake: (() => void) | null = null;
    const push = (item: Item) => {
      queue.push(item);
      wake?.();
    };
    const toolTitles = new Map<string, { title: string; status: string }>();
    void this.preamble(text)
      .then((lead) =>
        this.turn(`${lead}${text}`, signal, (update) => {
          switch (update.sessionUpdate) {
            case "agent_message_chunk":
              if (update.content.type === "text") push({ kind: "text", text: update.content.text });
              return;
            case "tool_call":
              toolTitles.set(update.toolCallId, {
                title: update.title,
                status: update.status ?? "pending",
              });
              return;
            case "tool_call_update": {
              const known = toolTitles.get(update.toolCallId);
              toolTitles.set(update.toolCallId, {
                title: update.title ?? known?.title ?? "",
                status: update.status ?? known?.status ?? "",
              });
              return;
            }
            default:
              return;
          }
        }),
      )
      .then(
        (outcome) => push({ kind: "done", outcome }),
        (error) =>
          push({ kind: "error", error: error instanceof Error ? error : new Error(String(error)) }),
      );

    const messageId = randomUUID();
    let open = false;
    yield { ...stamp(), type: EventType.RUN_STARTED, runId, threadId };
    for (;;) {
      if (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve));
      wake = null;
      const item = queue.shift();
      if (!item) continue;
      switch (item.kind) {
        case "text":
          if (!open) {
            open = true;
            yield { ...stamp(), type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" };
          }
          yield { ...stamp(), type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: item.text };
          break;
        case "error":
          throw item.error;
        case "done": {
          if (signal.aborted) return;
          const failure = failureOf(item.outcome);
          if (failure) throw new Error(failure);
          if (toolTitles.size > 0) {
            const list = [...toolTitles.values()]
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
          yield { ...stamp(), type: EventType.RUN_FINISHED, runId, threadId, finishReason: "stop" };
          return;
        }
      }
    }
  }

  structuredOutput(
    _options: StructuredOutputOptions<Record<string, never>>,
  ): Promise<StructuredOutputResult<never>> {
    return Promise.reject(new Error("External agents do not produce separate structured output."));
  }
}
