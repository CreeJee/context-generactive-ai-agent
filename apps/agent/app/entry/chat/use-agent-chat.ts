import { useAtomSet, useAtomSubscribe, useAtomValue } from "@effect/atom-react";
import { Match, Option, Schema } from "effect";
import { Sse } from "effect/encoding";
import { AsyncResult, Atom } from "effect/reactivity";
import { type ChatMessage, Refusal, type ResumeEntry } from "memory-agent/chat-api";
import { chatSessions, type CustomEvent, type Send } from "memory-agent/chat-session";
import { useEffect } from "react";
import { chatRuntime } from "./chat-runtime";

/** The page's sessions on the chat API. */
const sessions = chatSessions(chatRuntime);

const noMessages: ReadonlyArray<ChatMessage> = [];
const isRefusal = Schema.is(Refusal);
const isCoded = Schema.is(Schema.Struct({ error: Schema.String }));
const isRetry = Schema.is(Schema.instanceOf(Sse.Retry));

/**
 * An error the page folds under its general wording: the code it carries, a stream the server
 * asked to read again, or its own text.
 */
const shownText = Match.type<
  { readonly error: string } | Sse.Retry | { readonly message: string }
>().pipe(
  Match.when(isCoded, ({ error }) => error),
  Match.when(isRetry, () => "run_stream_retry"),
  Match.orElse(({ message }) => message),
);

/**
 * Why the page's answers to the approvals did not go on: they never reached the server, the server
 * refused them, or the run they started failed with the approvals still pending.
 */
export type AnswerProblem = "unsent" | "refused" | "lost";

/**
 * One session's conversation on the chat API. It opens the session's newest messages and rejoins
 * a run still going; `onCustomEvent` gets the app events runs send.
 */
export function useAgentChat({
  sessionId,
  holder,
  onCustomEvent,
}: {
  readonly sessionId: string;
  /** The page that holds the session; the server refuses another page's turns and answers. */
  readonly holder: string;
  readonly onCustomEvent: (event: CustomEvent) => void;
}) {
  const atoms = sessions(sessionId);
  const open = useAtomSet(atoms.open);
  const state = useAtomValue(atoms.state);
  const sending = useAtomValue(atoms.send);
  const answering = useAtomValue(atoms.answer);
  const send = useAtomSet(atoms.send);
  const answer = useAtomSet(atoms.answer);
  const loadOlder = useAtomSet(atoms.loadOlder, { mode: "promise" });
  useAtomSubscribe(atoms.custom, (event) => Option.map(event, onCustomEvent));
  useEffect(() => open(undefined), [open]);

  const view = Option.map(state, (current) => current.view);
  const interrupts = Option.getOrNull(
    Option.flatMapNullishOr(view, ({ interrupts }) => interrupts),
  );
  const failure = Option.getOrNull(Option.flatMapNullishOr(view, ({ failure }) => failure));
  const sendError = AsyncResult.error(sending);
  return {
    messages: Option.match(view, { onNone: () => noMessages, onSome: ({ messages }) => messages }),
    hasOlderMessages: Option.exists(view, ({ older }) => older !== null),
    loadOlderMessages: () => loadOlder(undefined),
    sendMessage: (content: Send["content"], forwardedProps?: Send["forwardedProps"]) =>
      send({ holder, content, forwardedProps }),
    /** Stops reading the run here; the server's run goes on until it is cancelled there. */
    stop: () => {
      send(Atom.Interrupt);
      answer(Atom.Interrupt);
    },
    /** A turn or an answer this page sent is still going. */
    isLoading: AsyncResult.isWaiting(sending) || AsyncResult.isWaiting(answering),
    /** The page reads a run, its own or one it rejoined, until the newest page is read after it. */
    sessionGenerating: Option.exists(state, ({ reading }) => reading !== null),
    /** The page's answers to the approvals are on their way. */
    resuming: AsyncResult.isWaiting(answering),
    /** Why the last run failed. */
    failure,
    /** The server's refusal of the last turn. */
    refusal: Option.getOrNull(Option.filter(sendError, isRefusal)),
    /** Why the last turn could not be sent or its run read, when the server did not refuse it. */
    unsent: Option.getOrNull(
      Option.flatMap(sendError, (error) =>
        isRefusal(error) ? Option.none() : Option.some({ message: shownText(error) }),
      ),
    ),
    interrupts,
    answerProblem: Option.match(AsyncResult.error(answering), {
      onSome: (error): AnswerProblem => (isRefusal(error) ? "refused" : "unsent"),
      onNone: () =>
        AsyncResult.isSuccess(answering) && failure !== null && interrupts !== null
          ? ("lost" as const)
          : null,
    }),
    resolveInterrupts: (answers: ReadonlyArray<ResumeEntry>) => {
      if (interrupts !== null) answer({ holder, parentRunId: interrupts.runId, answers });
    },
  };
}
