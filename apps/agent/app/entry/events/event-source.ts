import { Function as EffectFunction, Option, Result } from "effect";
import { Schema } from "effect";
import { AppChangedEvent, AppReadyEvent } from "memory-agent/app-api";

export type EventConnectionState = "connecting" | "live" | "reconnecting";

interface EventSourceLike {
  addEventListener(type: string, listener: (event: Event) => void): void;
  close(): void;
}

export interface ConnectAppEventsOptions {
  readonly url: () => string;
  readonly createSource?: (url: string) => EventSourceLike;
  readonly onChanged: (event: AppChangedEvent) => void;
  readonly onReady: (event: AppReadyEvent) => void;
  readonly onStatus?: (status: EventConnectionState) => void;
}

const decodeChangedPayload = Schema.decodeUnknownResult(Schema.fromJsonString(AppChangedEvent));
const decodeReadyPayload = Schema.decodeUnknownResult(Schema.fromJsonString(AppReadyEvent));

// Synchronous codecs at the native EventSource boundary; a payload that is not the promised event is dropped.
const changedOf = (event: Event) =>
  event instanceof MessageEvent
    ? Result.getSuccess(decodeChangedPayload(event.data))
    : Option.none();
const readyOf = (event: Event) =>
  event instanceof MessageEvent ? Result.getSuccess(decodeReadyPayload(event.data)) : Option.none();

export function connectAppEvents(options: ConnectAppEventsOptions) {
  const createSource = options.createSource ?? ((url: string) => new EventSource(url));
  const source = createSource(options.url());
  const decodeChanged = (event: Event) =>
    Option.match(changedOf(event), { onNone: EffectFunction.constVoid, onSome: options.onChanged });
  const decodeReady = (event: Event) =>
    Option.match(readyOf(event), { onNone: EffectFunction.constVoid, onSome: options.onReady });
  source.addEventListener("open", () => options.onStatus?.("live"));
  source.addEventListener("error", () => options.onStatus?.("reconnecting"));
  source.addEventListener("ready", decodeReady);
  source.addEventListener("changed", decodeChanged);
  options.onStatus?.("connecting");
  return () => source.close();
}
