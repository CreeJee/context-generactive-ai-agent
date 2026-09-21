import { Schema } from "effect";
import { AppChangedEvent, AppReadyEvent } from "./contracts";

export type EventConnectionState = "connecting" | "live" | "reconnecting";

interface EventSourceLike {
  addEventListener(type: string, listener: (event: Event) => void): void;
  close(): void;
}

export interface ConnectAppEventsOptions {
  readonly url: () => string;
  readonly signal?: AbortSignal;
  readonly createSource?: (url: string) => EventSourceLike;
  readonly onChanged: (event: typeof AppChangedEvent.Type) => void;
  readonly onReady: (event: typeof AppReadyEvent.Type) => void;
  readonly onStatus?: (status: EventConnectionState) => void;
  readonly onDecodeError?: (error: Error) => void;
}

const changedDecode = Schema.decodeUnknownSync(AppChangedEvent);
const readyDecode = Schema.decodeUnknownSync(AppReadyEvent);
const textDecode = Schema.decodeUnknownSync(Schema.String);

const payloadOf = (event: Event) => {
  if (!(event instanceof MessageEvent)) throw new Error("SSE payload is not a MessageEvent");
  return JSON.parse(textDecode(event.data));
};

export function connectAppEvents(options: ConnectAppEventsOptions) {
  const createSource = options.createSource ?? ((url: string) => new EventSource(url));
  const source = createSource(options.url());
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    source.close();
    options.signal?.removeEventListener("abort", close);
  };
  const decodeChanged = (event: Event) => {
    try {
      options.onChanged(changedDecode(payloadOf(event)));
    } catch (error) {
      options.onDecodeError?.(error instanceof Error ? error : new Error("Invalid changed event"));
    }
  };
  const decodeReady = (event: Event) => {
    try {
      options.onReady(readyDecode(payloadOf(event)));
    } catch (error) {
      options.onDecodeError?.(error instanceof Error ? error : new Error("Invalid ready event"));
    }
  };
  source.addEventListener("open", () => options.onStatus?.("live"));
  source.addEventListener("error", () => options.onStatus?.("reconnecting"));
  source.addEventListener("ready", decodeReady);
  source.addEventListener("changed", decodeChanged);
  options.signal?.addEventListener("abort", close, { once: true });
  options.onStatus?.("connecting");
  if (options.signal?.aborted) close();
  return close;
}
