import { useAtomSet, useAtomSubscribe, useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import type { ChatMessage, ResumeEntry } from "memory-agent/chat-api";
import { chatSessions, type CustomEvent, type Send } from "memory-agent/chat-session";
import { useEffect } from "react";
import { chatRuntime } from "./chat-runtime";

/** The page's sessions on the chat API (docs/effect-ai-migration.md step 6). */
const sessions = chatSessions(chatRuntime);

const noMessages: ReadonlyArray<ChatMessage> = [];

/**
 * One session's conversation, in place of TanStack's `useChat` (step 7 moves the page to it). It
 * opens the session's newest messages and rejoins a run still going; `onCustomEvent` gets the app
 * events runs send.
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
  const loadOlder = useAtomSet(atoms.loadOlder);
  useAtomSubscribe(atoms.custom, (event) => Option.map(event, onCustomEvent));
  useEffect(() => open(undefined), [open]);

  const view = Option.map(state, (current) => current.view);
  const interrupts = Option.getOrNull(
    Option.flatMapNullishOr(view, ({ interrupts }) => interrupts),
  );
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
    /** The page reads a run, its own or one it rejoined. */
    sessionGenerating: Option.exists(state, ({ reading }) => reading !== null),
    /** Why the last run failed. */
    failure: Option.getOrNull(Option.flatMapNullishOr(view, ({ failure }) => failure)),
    /** Why the server refused the last turn or answer, or why it could not be reached. */
    error: Option.getOrNull(
      Option.orElse(AsyncResult.error(sending), () => AsyncResult.error(answering)),
    ),
    interrupts,
    resolveInterrupts: (answers: ReadonlyArray<ResumeEntry>) => {
      if (interrupts !== null) answer({ holder, parentRunId: interrupts.runId, answers });
    },
  };
}
