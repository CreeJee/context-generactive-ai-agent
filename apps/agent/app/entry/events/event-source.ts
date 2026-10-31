import { Result } from "effect";
import { Schema } from "effect";
import { AppChangedEvent, AppReadyEvent } from "memory-agent/app-api";

export type EventConnectionState = "connecting" | "live" | "reconnecting";

interface EventSourceLike {
  addEventListener(type: string, listener: (event: Event) => void): void;
  close(): void;
}

export interface ConnectAppEventsOptions {
  readonly url: () => string;
  readonly signal?: AbortSignal;
  readonly createSource?: (url: string) => EventSourceLike;
  readonly onChanged: (event: AppChangedEvent) => void;
  readonly onReady: (event: AppReadyEvent) => void;
  readonly onStatus?: (status: EventConnectionState) => void;
  readonly onDecodeError?: (error: AppEventDecodeFailed) => void;
}

/** An app event whose payload is not the event the server promised; the payload is not kept. */
export class AppEventDecodeFailed extends Schema.TaggedError<
  AppEventDecodeFailed,
  { readonly brand: unique symbol }
>()("AppEventDecodeFailed", {
  event: Schema.Literals(["changed", "ready"]),
  reason: Schema.Literals(["not_message", "invalid_payload"]),
}) {}

const decodeChangedPayload = Schema.decodeUnknownResult(Schema.fromJsonString(AppChangedEvent));
const decodeReadyPayload = Schema.decodeUnknownResult(Schema.fromJsonString(AppReadyEvent));

// Synchronous codecs at the native EventSource boundary; a failure goes to the caller's callback.
const failed = (event: AppEventDecodeFailed["event"], reason: AppEventDecodeFailed["reason"]) =>
  AppEventDecodeFailed.make({ event, reason });
const changedOf = (event: Event) =>
  event instanceof MessageEvent
    ? Result.mapError(decodeChangedPayload(event.data), () => failed("changed", "invalid_payload"))
    : Result.fail(failed("changed", "not_message"));
const readyOf = (event: Event) =>
  event instanceof MessageEvent
    ? Result.mapError(decodeReadyPayload(event.data), () => failed("ready", "invalid_payload"))
    : Result.fail(failed("ready", "not_message"));

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
  const decodeChanged = (event: Event) =>
    Result.match(changedOf(event), {
      onSuccess: options.onChanged,
      onFailure: (failure) => options.onDecodeError?.(failure),
    });
  const decodeReady = (event: Event) =>
    Result.match(readyOf(event), {
      onSuccess: options.onReady,
      onFailure: (failure) => options.onDecodeError?.(failure),
    });
  source.addEventListener("open", () => options.onStatus?.("live"));
  source.addEventListener("error", () => options.onStatus?.("reconnecting"));
  source.addEventListener("ready", decodeReady);
  source.addEventListener("changed", decodeChanged);
  options.signal?.addEventListener("abort", close, { once: true });
  options.onStatus?.("connecting");
  if (options.signal?.aborted === true) close();
  return close;
}
