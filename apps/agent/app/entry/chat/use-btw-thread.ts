import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Option, Schema } from "effect";
import { AsyncResult } from "effect/reactivity";
import { btwThreads } from "memory-agent/btw-thread";
import { type ChatMessage, Refusal } from "memory-agent/chat-api";
import type { UserContent } from "memory-agent/chat-session";
import { useEffect } from "react";
import { chatRuntime } from "./chat-runtime";

const threads = btwThreads(chatRuntime);

const noMessages: ReadonlyArray<ChatMessage> = [];
const isRefusal = Schema.is(Refusal);

/** One BTW thread on the chat API: its saved messages, and the side questions the panel asks. */
export function useBtwThread({
  threadId,
  onAnswered,
}: {
  readonly threadId: string;
  /** Runs once a question's answer has ended, or the question was refused. */
  readonly onAnswered: () => void;
}) {
  const atoms = threads(threadId);
  const open = useAtomSet(atoms.open);
  const view = useAtomValue(atoms.view);
  const asking = useAtomValue(atoms.ask);
  const ask = useAtomSet(atoms.ask, { mode: "promiseExit" });
  useEffect(() => open(undefined), [open]);

  return {
    messages: Option.match(view, { onNone: () => noMessages, onSome: ({ messages }) => messages }),
    ask: (content: UserContent) => void ask(content).then(onAnswered),
    /** A question this panel asked is still being answered. */
    isLoading: AsyncResult.isWaiting(asking),
    /** Why the last answer failed. */
    failure: Option.getOrNull(Option.flatMapNullishOr(view, ({ failure }) => failure)),
    /** Why the server refused the last question, or why it could not be reached. */
    error: Option.getOrNull(AsyncResult.error(asking)),
    /** The server's refusal of the last question, when that is why it failed. */
    refusal: Option.getOrNull(Option.filter(AsyncResult.error(asking), isRefusal)),
  };
}
