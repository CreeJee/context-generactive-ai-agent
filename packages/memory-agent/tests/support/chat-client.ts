import {
  Cause,
  Crypto,
  Effect,
  Function as EffectFunction,
  MutableRef,
  Option,
  Schema,
  Stream,
} from "effect";
import {
  type ChatMessage,
  maxPageSize,
  MessagePart,
  type PendingInterrupts,
  type RunEvent,
  type RunInput,
} from "../../src/api/chat-api.ts";
import { partsOf, type UserContent } from "../../src/api/chat-session.ts";
import {
  applyEvent,
  caughtUp,
  type ChatView,
  streamStarted,
  viewOf,
} from "../../src/api/chat-view.ts";
import { AgUiEvent } from "../../src/loop/chunks.ts";
import { optionalProperty } from "../../src/optional-property.ts";
import { chatApi } from "./chat-api.ts";
import type { ScriptedResponder, ScriptedTurn } from "../../src/testing/scripted-model.ts";
import { defaultTestResponder } from "./provider.ts";

/**
 * Interrupt IDs come from tool-call IDs and are unique across the database, as provider call IDs
 * are. The default responder's fixed IDs are scoped to the conversation so sessions sharing one
 * agent never collide; the responder itself still sees the IDs it chose.
 */
export const scopedCallId: {
  (sessionId: string): (id: string) => string;
  (id: string, sessionId: string): string;
} = EffectFunction.dual(2, (id: string, sessionId: string) => `${id}@${sessionId}`);

export const sessionScopedResponder: ScriptedResponder = (invocation) => {
  const sessionId = invocation.run.threadId;
  const suffix = scopedCallId("", sessionId);
  const history = invocation.history.map((message) =>
    message.role === "tool" && message.toolCallId.endsWith(suffix)
      ? { ...message, toolCallId: message.toolCallId.slice(0, -suffix.length) }
      : message,
  );
  const turn: ScriptedTurn = defaultTestResponder({ ...invocation, history });
  return turn.toolCalls === undefined
    ? turn
    : {
        ...turn,
        toolCalls: turn.toolCalls.map((call) => ({
          ...call,
          id: scopedCallId(call.id, sessionId),
        })),
      };
};

/** An approval a session waits for, as the page lists it. */
export type PendingApproval = PendingInterrupts["pending"][number];

/**
 * A browser tab on the chat API, answered in-process by the agent open now. It reads the session as
 * the page's hook does (`src/api/chat-session.ts`): the newest messages, then each run it starts or
 * answers, then the newest messages again.
 */
export const openPage = Effect.fnUntraced(function* (
  session: string,
  holder: string | null = null,
) {
  const api = yield* chatApi;
  const crypto = yield* Crypto.Crypto;
  const headers = holder === null ? {} : { "x-session-holder": holder };
  const newest = api.snapshot({ params: { session }, query: { limit: maxPageSize } });
  const opened = yield* newest;
  const view = MutableRef.make(viewOf(opened));
  const changed = (change: (current: ChatView) => ChatView) =>
    Effect.sync(() => MutableRef.update(view, change));
  /** Reads a run's events into the view until its stream ends, then the newest messages again. */
  const following = <E>(events: Stream.Stream<RunEvent, E>) =>
    changed(streamStarted).pipe(
      Effect.andThen(Stream.runForEach(events, ({ data }) => changed(applyEvent(data)))),
      Effect.andThen(newest),
      Effect.flatMap((snapshot) => changed(caughtUp(snapshot))),
    );
  const texts = (role: ChatMessage["role"]) =>
    MutableRef.get(view)
      .messages.filter((message) => message.role === role)
      .map((message) =>
        message.parts
          .flatMap((part) => (MessagePart.guards.text(part) ? [part.content] : []))
          .join(""),
      );
  return {
    /** The session as the page opened it. */
    opened,
    view: () => MutableRef.get(view),
    texts,
    /** Rejoins the run still going when the page opened, as a reload does, and reads it to its end. */
    rejoin: Effect.transposeOption(
      Option.map(Option.fromNullishOr(opened.activeRun), ({ runId }) =>
        Effect.flatMap(api.join({ params: { session, run: runId }, query: {} }), following),
      ),
    ),
    /** Every assistant message's text, in order. */
    answer: () => texts("assistant").join(""),
    pending: (): ReadonlyArray<PendingApproval> => MutableRef.get(view).interrupts?.pending ?? [],
    /** Sends a user turn and reads its run to the end. A refused turn leaves the conversation. */
    send: Effect.fnUntraced(function* (
      content: UserContent,
      forwardedProps?: RunInput["forwardedProps"],
    ) {
      const id = yield* crypto.randomUUIDv7();
      yield* changed((current) => ({
        ...current,
        messages: [...current.messages, { id, role: "user", parts: partsOf(content) }],
      }));
      const events = yield* api
        .run({
          params: { session },
          headers,
          payload: {
            runId: yield* crypto.randomUUIDv7(),
            messages: [{ id, role: "user", content }],
            ...optionalProperty("forwardedProps", forwardedProps),
          },
        })
        .pipe(
          Effect.tapError(() =>
            changed((current) => ({
              ...current,
              messages: current.messages.filter((message) => message.id !== id),
            })),
          ),
        );
      yield* following(events);
    }),
    /** Answers every approval the session waits for, and reads the run that resumes it. */
    resolve: Effect.fnUntraced(function* (approved: (pending: PendingApproval) => boolean) {
      const waiting = yield* Effect.fromNullishOr(MutableRef.get(view).interrupts);
      const events = yield* api.run({
        params: { session },
        headers,
        payload: {
          runId: yield* crypto.randomUUIDv7(),
          parentRunId: waiting.runId,
          messages: [],
          resume: waiting.pending.map((pending) => ({
            interruptId: pending.id,
            status: "resolved",
            payload: { approved: approved(pending) },
          })),
        },
      });
      yield* following(events);
    }),
  };
});

export type ChatPage = Effect.Success<ReturnType<typeof openPage>>;

/** Reads a run's stream to its end: the events, without their places in the log. */
export const eventsOf = <E>(events: Stream.Stream<RunEvent, E>) =>
  Effect.map(Stream.runCollect(events), (all) => all.map(({ data }) => data));

/** Sends one user turn on the chat API, as the page does, and collects its run's events. */
export const runTurn = Effect.fnUntraced(function* (
  session: string,
  runId: string,
  content: UserContent,
) {
  const api = yield* chatApi;
  return yield* eventsOf(
    yield* api.run({
      params: { session },
      headers: {},
      payload: { runId, messages: [{ id: runId, role: "user", content }] },
    }),
  );
});

const encodeEvents = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(AgUiEvent)));

/** A run's events as the page reads them off the wire. */
export const wireOf = (events: ReadonlyArray<AgUiEvent>) => encodeEvents(events);

/** The text a run's events stream, in order. */
export const streamedText = (events: ReadonlyArray<AgUiEvent>) =>
  events
    .flatMap((event) => (AgUiEvent.guards.TEXT_MESSAGE_CONTENT(event) ? [event.delta] : []))
    .join("");

/** The tool results a run's events carry, in order. */
export const toolResults = (events: ReadonlyArray<AgUiEvent>) =>
  events.flatMap((event) => (AgUiEvent.guards.TOOL_CALL_RESULT(event) ? [event.content] : []));

/** Await an SDK Promise, keeping its rejection as a typed failure. */
export const sdk = <A>(operation: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: (cause) => new Cause.UnknownError(cause),
  });

/** Read a JSON response body at the HTTP boundary. */
export const json = (response: Response) => sdk(() => response.json());
