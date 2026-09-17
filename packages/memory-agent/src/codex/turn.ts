import { EventEmitter } from "node:events";
import pDefer, { type DeferredPromise } from "p-defer";
import { pEventIterator } from "p-event";
import { Schema } from "effect";
import type { Json } from "./app-server.ts";

export interface TurnUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface ToolResult {
  readonly text: string;
  readonly success: boolean;
}

/** A codex `item/tool/call` request held open until TanStack has executed the tool. */
export interface PendingToolCall {
  readonly callId: string;
  readonly name: string;
  /** JSON arguments exactly as codex sent them. */
  readonly arguments: string;
  readonly result: DeferredPromise<ToolResult>;
}

export type TurnEvent =
  /** `itemId` is the codex message the text belongs to; a turn can write several. */
  | { readonly kind: "delta"; readonly text: string; readonly itemId: string | null }
  | { readonly kind: "toolCall"; readonly call: PendingToolCall }
  | { readonly kind: "usage"; readonly usage: TurnUsage };

// A type literal (not an interface) so it satisfies p-event's event-map index signature.
type TurnEvents = {
  event: [event: TurnEvent];
  completed: [];
  failed: [message: string];
};

export const DeltaNotification = Schema.Struct({
  threadId: Schema.String,
  itemId: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  delta: Schema.String,
});
export const TurnCompletedNotification = Schema.Struct({
  threadId: Schema.String,
  turn: Schema.Struct({ id: Schema.String, status: Schema.String }),
});
export const TokenUsageNotification = Schema.Struct({
  threadId: Schema.String,
  tokenUsage: Schema.Struct({
    last: Schema.Struct({
      inputTokens: Schema.Number,
      outputTokens: Schema.Number,
      totalTokens: Schema.Number,
    }),
    /** The tokens the model may read, as codex counts them for this model. */
    modelContextWindow: Schema.optionalWith(Schema.NullOr(Schema.Number), { default: () => null }),
  }),
});
export const ErrorNotification = Schema.Struct({
  threadId: Schema.optional(Schema.String),
  willRetry: Schema.optional(Schema.Boolean),
});
export const ToolCallRequest = Schema.Struct({
  threadId: Schema.String,
  callId: Schema.String,
  tool: Schema.String,
  arguments: Schema.Unknown,
});

/**
 * One running codex turn on one thread. The codex bridge feeds it notifications and tool
 * requests for its thread; the adapter reads them in order from `events`.
 */
export class CodexTurn extends EventEmitter<TurnEvents> {
  turnId: string | null = null;
  finished = false;
  /** Tool calls handed to TanStack whose results have not been sent back to codex yet. */
  readonly awaiting = new Map<string, PendingToolCall>();
  /**
   * Subscribed before anything is emitted and buffered by p-event, so events that arrive while
   * TanStack runs tools between two chatStream calls wait for the next call. Ends on
   * "completed", throws on "failed". Read with next(), not for-await, which would close it.
   */
  readonly events: AsyncIterator<TurnEvent>;

  readonly threadId: string;
  readonly model: string;

  constructor(threadId: string, model: string) {
    super();
    this.threadId = threadId;
    this.model = model;
    this.events = pEventIterator<TurnEvents, "event">(this, "event", {
      resolutionEvents: ["completed"],
      rejectionEvents: ["failed"],
    })[Symbol.asyncIterator]();
  }

  push(event: TurnEvent) {
    if (!this.finished) this.emit("event", event);
  }

  /** Answers codex's tool request once TanStack provides the result. */
  requestTool(callId: string, name: string, argumentsJson: string): Promise<Json> {
    const call: PendingToolCall = {
      callId,
      name,
      arguments: argumentsJson,
      result: pDefer<ToolResult>(),
    };
    this.awaiting.set(callId, call);
    this.push({ kind: "toolCall", call });
    return call.result.promise.then((result) => {
      this.awaiting.delete(callId);
      return { contentItems: [{ type: "inputText", text: result.text }], success: result.success };
    });
  }

  /** Ends the turn. `failure` is a user-safe message when codex reported an error. */
  finish(failure?: string) {
    if (this.finished) return;
    this.finished = true;
    // Codex must not wait forever on calls TanStack will never execute.
    for (const call of this.awaiting.values())
      call.result.resolve({ text: "Tool call was not executed.", success: false });
    if (failure === undefined) this.emit("completed");
    else this.emit("failed", failure);
  }
}
