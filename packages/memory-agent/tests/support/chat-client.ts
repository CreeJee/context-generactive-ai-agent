import { ChatClient, fetchServerSentEvents } from "@tanstack/ai-client";
import { Cause, Effect } from "effect";
import { AgentChat } from "../../src/agent/chat.ts";
import { approvalToolDefinitions, permissionReviewInterrupt } from "../../src/tools/definitions.ts";
import type { ScriptedResponder, ScriptedTurn } from "../../src/testing/scripted-adapter.ts";
import { defaultTestResponder } from "./provider.ts";
import type { AgentServices } from "./test-env.ts";
import { waitUntil } from "./wait-until.ts";

/**
 * Interrupt IDs come from tool-call IDs and are unique across the database, as provider call IDs
 * are. The default responder's fixed IDs are scoped to the conversation so sessions sharing one
 * agent never collide; the responder itself still sees the IDs it chose.
 */
export const scopedCallId = (id: string, sessionId: string) => `${id}@${sessionId}`;

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
 * reloaded tab that hydrates the session from the server before answering it.
 */
export type Connection = "send" | "restore";

/** A real TanStack chat client talking to the open agent in-process, like the browser UI does. */
export const chatClient = Effect.fnUntraced(function* (sessionId: string, connection: Connection) {
  const agent = yield* AgentChat;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<AgentServices>());
  const tools = approvalToolDefinitions;
  const interrupts = [permissionReviewInterrupt];
  const make = () => {
    switch (connection) {
      case "send":
        return new ChatClient({
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
          connection: fetchServerSentEvents(`http://127.0.0.1/api/chat?session=${sessionId}`, {
            fetchClient: (input, init) => {
              const request = new Request(input, init);
              return runPromise(
                request.method === "POST"
                  ? agent.handle(request, sessionId)
                  : agent.hydrate(request, sessionId),
              );
            },
          }),
        });
    }
  };
  const client = yield* Effect.acquireRelease(Effect.sync(make), (client) =>
    Effect.sync(() => client.dispose()),
  );
  if (connection === "restore") client.attach();
  const text = () =>
    client
      .getMessages()
      .flatMap((message) =>
        message.role === "assistant"
          ? message.parts.flatMap((part) => (part.type === "text" ? [part.content] : []))
          : [],
      )
      .join("");
  const until = (condition: () => boolean, what: string) => waitUntil(condition, what, 6_000);
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

/** Await an SDK Promise, keeping its rejection as a typed failure. */
export const sdk = <A>(operation: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: (cause) => new Cause.UnknownError(cause),
  });

/** Read a JSON response body at the HTTP boundary. */
export const json = (response: Response) => sdk(() => response.json());
