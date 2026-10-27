import { chatRoute } from "./chat-route.ts";
import { ChatClient, fetchServerSentEvents } from "@tanstack/ai-client";
import { Cause, Crypto, Effect, Function as EffectFunction, MutableRef, Stream } from "effect";
import { AgentChat } from "../../src/agent/chat.ts";
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
import { optionalProperty } from "../../src/optional-property.ts";
import { chatApi } from "./chat-api.ts";
import { approvalToolDefinitions, permissionReviewInterrupt } from "../../src/tools/definitions.ts";
import type { ScriptedResponder, ScriptedTurn } from "../../src/testing/scripted-adapter.ts";
import { defaultTestResponder } from "./provider.ts";
import type { AgentServices } from "./test-env.ts";
import { type WaitCondition, waitUntil } from "./wait-until.ts";

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
  const sessionId = invocation.threadId ?? "";
  const suffix = scopedCallId("", sessionId);
  const messages = invocation.messages.map((message) =>
    message.role === "tool" && message.toolCallId?.endsWith(suffix) === true
      ? { ...message, toolCallId: message.toolCallId.slice(0, -suffix.length) }
      : message,
  );
  return Promise.resolve(defaultTestResponder({ ...invocation, messages })).then(
    (turn): ScriptedTurn =>
      turn.toolCalls === undefined
        ? turn
        : {
            ...turn,
            toolCalls: turn.toolCalls.map((call) => ({
              ...call,
              id: scopedCallId(call.id, sessionId),
            })),
          },
  );
};

/**
 * How the page talks to the agent: `send` is a fresh tab posting a message, `restore` is a
 * reloaded tab that hydrates the session from the server before answering it. `page` is the
 * page's own client: it hydrates too, and a turn sends only the messages the server has not stored.
 */
export type Connection = "send" | "restore" | "page";

/** A real TanStack chat client talking to the open agent in-process, like the browser UI does. */
export const chatClient = Effect.fnUntraced(function* (sessionId: string, connection: Connection) {
  const agent = yield* AgentChat;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<AgentServices>());
  const tools = approvalToolDefinitions;
  const interrupts = [permissionReviewInterrupt];
  const sessionConnection = () =>
    fetchServerSentEvents(`http://127.0.0.1/api/chat?session=${sessionId}`, {
      fetchClient: (input, init) => {
        const request = new Request(input, init);
        return runPromise(chatRoute(agent, request, sessionId));
      },
    });
  const make = () => {
    switch (connection) {
      case "send":
        return new ChatClient({
          threadId: sessionId,
          tools,
          interrupts,
          connection: fetchServerSentEvents("http://127.0.0.1/api/chat", {
            fetchClient: (input, init) =>
              runPromise(agent.handle(new Request(input, init), sessionId)),
          }),
        });
      case "restore":
        return new ChatClient({
          threadId: sessionId,
          persistence: true,
          tools,
          interrupts,
          connection: sessionConnection(),
        });
      case "page":
        return new ChatClient({
          threadId: sessionId,
          persistence: true,
          // As in the page's chat panel.
          history: { pageSize: 20 },
          tools,
          interrupts,
          connection: sessionConnection(),
        });
    }
  };
  const client = yield* Effect.acquireRelease(Effect.sync(make), (client) =>
    Effect.sync(() => client.dispose()),
  );
  if (connection !== "send") client.attach();
  const text = () =>
    client
      .getMessages()
      .flatMap((message) =>
        message.role === "assistant"
          ? message.parts.flatMap((part) => (part.type === "text" ? [part.content] : []))
          : [],
      )
      .join("");
  const until = <E = never, R = never>(condition: WaitCondition<E, R>, what: string) =>
    waitUntil(condition, what, 6_000);
  return {
    client,
    text,
    until,
    send: (message: string) => sdk(() => client.sendMessage(message)),
    /** Wait for the scripted model's answer after the shell call, then for the run to end. */
    answered: Effect.fnUntraced(function* (prefix: string, what: string) {
      yield* until(() => text().startsWith(prefix), what);
      yield* until(() => !client.getIsLoading(), "the run to finish");
    }),
    pendingInterrupt: until(() => client.getInterrupts().length === 1, "the pending interrupt"),
  };
});

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
  const view = MutableRef.make(viewOf(yield* newest));
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
    view: () => MutableRef.get(view),
    texts,
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

/** Await an SDK Promise, keeping its rejection as a typed failure. */
export const sdk = <A>(operation: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: (cause) => new Cause.UnknownError(cause),
  });

/** Read a JSON response body at the HTTP boundary. */
export const json = (response: Response) => sdk(() => response.json());
