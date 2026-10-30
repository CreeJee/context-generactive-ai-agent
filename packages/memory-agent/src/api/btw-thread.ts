import { Crypto, Effect, Option, Stream } from "effect";
import { Atom } from "effect/reactivity";
import type { ChatMessage } from "./chat-api.ts";
import { ChatApiClient, partsOf, type UserContent } from "./chat-session.ts";
import { applyEvent, type ChatView, streamStarted, viewOf } from "./chat-view.ts";
import { keptAtomGroups } from "./kept-atom-groups.ts";

/**
 * A page's open BTW threads as atoms on `ChatApi`: what the panel shows of each, and the side
 * questions it asks. This module imports no server code.
 */

/** The view of a BTW thread; a thread has no older pages or approvals. */
const threadView = (messages: ReadonlyArray<ChatMessage>): ChatView =>
  viewOf({ messages, older: null, activeRun: null, interrupts: null });

/** The atoms of each BTW thread a page opens, keyed by thread id. */
export const btwThreads = <E>(runtime: Atom.AtomRuntime<ChatApiClient | Crypto.Crypto, E>) =>
  keptAtomGroups((thread: string) => {
    const view = Atom.make<Option.Option<ChatView>>(Option.none()).pipe(Atom.keepAlive);

    // Written through the call's own `get`, not the registry: once a newer call replaces this one,
    // its late writes are dropped instead of overwriting the newer question's view.
    const changed = (get: Atom.FnContext, change: (current: ChatView) => ChatView) =>
      Effect.sync(() => get.set(view, Option.map(get(view), change)));
    const saved = Effect.flatMap(ChatApiClient, ({ btw }) => btw.messages({ params: { thread } }));

    /** Reads the thread's saved messages. */
    const open = runtime.fn((_: void, get) =>
      Effect.flatMap(saved, (messages) =>
        Effect.sync(() => get.set(view, Option.some(threadView(messages)))),
      ),
    );

    /**
     * Asks a side question and reads its answer, then the saved thread again. A refused question
     * leaves the thread.
     */
    const ask = runtime.fn((content: UserContent, get) =>
      Effect.gen(function* () {
        const { btw } = yield* ChatApiClient;
        const crypto = yield* Crypto.Crypto;
        const runId = yield* crypto.randomUUIDv7();
        const message: ChatMessage = {
          id: yield* crypto.randomUUIDv7(),
          role: "user",
          parts: partsOf(content),
        };
        yield* changed(get, (current) => ({
          ...streamStarted(current),
          messages: [...current.messages, message],
        }));
        const events = yield* btw
          .ask({
            params: { thread },
            payload: { runId, message: { id: message.id, role: "user", content } },
          })
          .pipe(
            Effect.tapError(() =>
              changed(get, (current) => ({
                ...current,
                messages: current.messages.filter(({ id }) => id !== message.id),
              })),
            ),
          );
        yield* Stream.runForEach(events, ({ data }) => changed(get, applyEvent(data)));
        const messages = yield* saved;
        yield* changed(get, (current) => ({ ...threadView(messages), failure: current.failure }));
      }),
    );

    return { view, open, ask };
  });
