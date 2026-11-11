import {
  Clock,
  Deferred,
  Duration,
  Effect,
  Exit,
  Function as EffectFunction,
  Option,
  Queue,
  Result,
  Schedule,
  Stream,
} from "effect";
import { Schema } from "effect";
import { AppChangedEvent, AppReadyEvent } from "memory-agent/app-api";

/** The next try once the server has been out of reach for 30 s. */
export type NextAttempt =
  /** It starts in `seconds`, or at once on `reconnectNow`. */
  | { readonly _tag: "waiting"; readonly seconds: number; readonly reconnectNow: () => void }
  | { readonly _tag: "trying" };

/** The live update stream as the page sees it. */
export type EventConnection =
  /** Opening the stream: at first, and when a hidden tab is shown again. */
  | { readonly _tag: "connecting" }
  | { readonly _tag: "live" }
  /** The stream was lost less than 30 s ago and is tried again on its own. */
  | { readonly _tag: "reconnecting" }
  /** No stream for 30 s or more; tries go on. */
  | { readonly _tag: "unreachable"; readonly nextAttempt: NextAttempt };

type EventSourceLike = Stream.EventListener<Event> & { close(): void };

/** The page signals that end a wait: the tab shown again and the network back. */
export interface PageSignals {
  readonly document: Stream.EventListener<Event> & { readonly hidden: boolean };
  readonly window: Stream.EventListener<Event>;
}

export interface ConnectAppEventsOptions {
  readonly url: string;
  readonly createSource?: (url: string) => EventSourceLike;
  readonly page?: PageSignals;
  readonly onChanged: (event: AppChangedEvent) => void;
  readonly onReady: (event: AppReadyEvent) => void;
  readonly onStatus: (status: EventConnection) => void;
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

const firstDelays = [1, 2, 5, 10] as const;
const laterDelay = 30;
/** How long the page goes without a stream before it says the server cannot be reached. */
const unreachableAfter = Duration.seconds(30);

/** The wait before try number `attempt` (0 is the first try after the stream was lost). */
const reconnectDelay = (attempt: number) => Duration.seconds(firstDelays[attempt] ?? laterDelay);

/** Since when the page has been without a stream, and how many tries it has made since. */
interface Lost {
  readonly since: number;
  readonly attempts: number;
}

/** What happens to one stream: it opens, then the source fails or the page closes it when hidden. */
type StreamEvent =
  | { readonly _tag: "opened" }
  | { readonly _tag: "failed" }
  | { readonly _tag: "hidden" };
const opened: StreamEvent = { _tag: "opened" };
const failed: StreamEvent = { _tag: "failed" };
const hidden: StreamEvent = { _tag: "hidden" };

const connecting: EventConnection = { _tag: "connecting" };
const live: EventConnection = { _tag: "live" };
const reconnecting: EventConnection = { _tag: "reconnecting" };

/**
 * Keeps one live update stream open while the tab is visible, until interrupted.
 *
 * The page owns every reconnect instead of the browser's own retry: a native EventSource gives up
 * for good after an HTTP error (a 502 from the dev proxy while the backend is down), and owning the
 * retries is what lets the banner say when the next one starts. A lost stream is tried again after
 * 1, 2, 5, and 10 s, then every 30 s; the network coming back or the tab being shown tries at once.
 */
export const appEvents = (options: ConnectAppEventsOptions): Effect.Effect<never> => {
  const createSource = options.createSource ?? ((url: string) => new EventSource(url));
  const page = options.page ?? { document, window };
  const emit = (status: EventConnection) => Effect.sync(() => options.onStatus(status));
  const first = (target: Stream.EventListener<Event>, type: string) =>
    Stream.fromEventListener<Event>(target, type).pipe(Stream.runHead, Effect.asVoid);
  /** The tab being shown again. */
  const shown = Stream.fromEventListener<Event>(page.document, "visibilitychange").pipe(
    Stream.filter(() => !page.document.hidden),
    Stream.runHead,
    Effect.asVoid,
  );
  const untilVisible = Effect.suspend(() => (page.document.hidden ? shown : Effect.void));
  const decodeChanged = (event: Event) =>
    Option.match(changedOf(event), { onNone: EffectFunction.constVoid, onSome: options.onChanged });
  const decodeReady = (event: Event) =>
    Option.match(readyOf(event), { onNone: EffectFunction.constVoid, onSome: options.onReady });

  /** Opens a stream and holds it until it fails or the tab is hidden; says whether it opened. */
  const openStream = Queue.unbounded<StreamEvent>().pipe(
    // Listens in the same step that opens the source, so no event comes before a listener.
    Effect.tap((events) => {
      const onHidden = () => {
        if (page.document.hidden) Queue.offerUnsafe(events, hidden);
      };
      return Effect.acquireRelease(
        Effect.sync(() => {
          const source = createSource(options.url);
          source.addEventListener("ready", decodeReady);
          source.addEventListener("changed", decodeChanged);
          source.addEventListener("open", () => Queue.offerUnsafe(events, opened));
          source.addEventListener("error", () => Queue.offerUnsafe(events, failed));
          page.document.addEventListener("visibilitychange", onHidden);
          return source;
        }),
        (source) =>
          Effect.sync(() => {
            page.document.removeEventListener("visibilitychange", onHidden);
            source.close();
          }),
      );
    }),
    Effect.flatMap((events) =>
      Stream.fromQueue(events).pipe(
        Stream.tap((event) => Effect.when(emit(live), Effect.succeed(event._tag === "opened"))),
        Stream.takeUntil((event) => event._tag !== "opened"),
        Stream.runCollect,
      ),
    ),
    Effect.map((events) => ({
      wasLive: events.some((event) => event._tag === "opened"),
      end: events.at(-1)?._tag === "hidden" ? hidden : failed,
    })),
    Effect.scoped,
  );

  /** The millis left until the page says the server cannot be reached; 0 or less once it does. */
  const untilUnreachable = (lost: Lost) =>
    Clock.currentTimeMillis.pipe(
      Effect.map((now) => lost.since + Duration.toMillis(unreachableAfter) - now),
    );

  /** Waits for the next try, saying from 30 s on that the server cannot be reached. */
  const waitForNextTry = (lost: Lost) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const nextAt = now + Duration.toMillis(reconnectDelay(lost.attempts));
      const clicked = yield* Deferred.make<void>();
      const reconnectNow = () => void Deferred.doneUnsafe(clicked, Exit.void);
      const countdown = Clock.currentTimeMillis.pipe(
        Effect.flatMap((at) =>
          emit({
            _tag: "unreachable",
            nextAttempt: {
              _tag: "waiting",
              seconds: Math.ceil((nextAt - at) / 1000),
              reconnectNow,
            },
          }),
        ),
        Effect.repeat(Schedule.spaced("1 second")),
      );
      const left = yield* untilUnreachable(lost);
      yield* Effect.when(emit(reconnecting), Effect.succeed(left > 0));
      const banner = Effect.sleep(left).pipe(
        Effect.andThen(countdown),
        Effect.andThen(Effect.never),
      );
      yield* Effect.raceAll([
        Effect.sleep(nextAt - now),
        Deferred.await(clicked),
        first(page.window, "online"),
        shown,
        banner,
      ]);
    });

  /** The status while a try is under way. */
  const trying = (lost: Option.Option<Lost>) =>
    Option.match(lost, {
      onNone: () => Effect.succeed(connecting),
      onSome: (since) =>
        untilUnreachable(since).pipe(
          Effect.map((left): EventConnection =>
            left > 0 ? reconnecting : { _tag: "unreachable", nextAttempt: { _tag: "trying" } },
          ),
        ),
    });

  /** One try: open a stream, hold it while it lasts, and wait before the next try if it failed. */
  const attempt = (lost: Option.Option<Lost>) =>
    Effect.gen(function* () {
      yield* untilVisible;
      yield* emit(yield* trying(lost));
      const { end, wasLive } = yield* openStream;
      // A stream that opened was live: what comes next is a fresh loss, or a fresh start once shown.
      const before = wasLive ? Option.none<Lost>() : lost;
      if (end._tag === "hidden") return before;
      const now = yield* Clock.currentTimeMillis;
      const next = Option.match(before, {
        onNone: (): Lost => ({ since: now, attempts: 0 }),
        onSome: ({ since, attempts }): Lost => ({ since, attempts: attempts + 1 }),
      });
      yield* waitForNextTry(next);
      return Option.some(next);
    });

  // Tail recursion through flatMap, so a page open for days does not keep a frame per reconnect.
  const loop = (lost: Option.Option<Lost>): Effect.Effect<never> =>
    attempt(lost).pipe(Effect.flatMap(loop));
  return loop(Option.none());
};
