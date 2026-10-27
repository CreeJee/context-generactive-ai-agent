import { Context, Crypto, Effect, Layer, Option, Schema, Stream } from "effect";
import { HttpApiClient } from "effect/http-api";
import { Atom } from "effect/reactivity";
import { AgUiEvent } from "../loop/chunks.ts";
import { optionalProperty } from "../optional-property.ts";
import {
  ChatApi,
  type ChatMessage,
  type MessagePart,
  type ResumeEntry,
  type RunEvent,
  type RunInput,
} from "./chat-api.ts";
import { applyEvent, caughtUp, type ChatView, streamStarted, viewOf } from "./chat-view.ts";

/**
 * A page's open sessions as atoms on `ChatApi` (docs/effect-ai-migration.md step 6): what the page
 * shows of each, and the runs it starts, answers and rejoins. The page's hook reads them with
 * `@effect/atom-react`. This module imports no server code.
 */

const makeClient = HttpApiClient.make(ChatApi);

/** The chat API, called over the page's `HttpClient`. */
export class ChatApiClient extends Context.Service<
  ChatApiClient,
  Effect.Success<typeof makeClient>
>()("memory-agent/api/chat-session/ChatApiClient") {
  static readonly layer = Layer.effect(ChatApiClient, makeClient);
}

/** How many messages the page reads at a time. */
export const pageSize = 20;

/** A session as a page has it open. */
export interface OpenSession {
  readonly view: ChatView;
  /** The run the page reads, and the last event it read; null between runs. */
  readonly reading: { readonly runId: string; readonly after: string | null } | null;
}

/** An app event a run sent, such as the context meter or a queued message it took in. */
export type CustomEvent = (typeof AgUiEvent.cases)["CUSTOM"]["Type"];

type UserContent = RunInput["messages"][number]["content"];

/** A user turn the page sends. */
export interface Send {
  /** The page that holds the session. */
  readonly holder: string;
  readonly content: UserContent;
  readonly forwardedProps?: RunInput["forwardedProps"];
}

/** The page's answers to the approvals run `parentRunId` waits for. */
export interface Answer {
  readonly holder: string;
  readonly parentRunId: string;
  readonly answers: ReadonlyArray<ResumeEntry>;
}

const isCustom = AgUiEvent.guards.CUSTOM;
const isText = Schema.is(Schema.String);

const partsOf = (content: UserContent): ReadonlyArray<MessagePart> =>
  isText(content) ? [{ type: "text", content }] : content;

/** The atoms of each session a page opens, keyed by session id. */
export const chatSessions = <E>(runtime: Atom.AtomRuntime<ChatApiClient | Crypto.Crypto, E>) =>
  Atom.family((session: string) => {
    const state = Atom.make<Option.Option<OpenSession>>(Option.none()).pipe(Atom.keepAlive);
    /** The last app event a run sent; the page subscribes to it. */
    const custom = Atom.make<Option.Option<CustomEvent>>(Option.none());

    const changed = (get: Atom.FnContext, change: (current: OpenSession) => OpenSession) =>
      Effect.sync(() => get.set(state, Option.map(get(state), change)));

    /** Reads a run's events into the view until its stream ends, then the newest page again. */
    const following = <E2>(
      get: Atom.FnContext,
      runId: string,
      events: Stream.Stream<RunEvent, E2>,
    ) =>
      changed(get, (current) => ({
        view: streamStarted(current.view),
        reading: { runId, after: null },
      })).pipe(
        Effect.andThen(
          Stream.runForEach(events, ({ id, data }) =>
            Effect.andThen(
              changed(get, (current) => ({
                view: applyEvent(current.view, data),
                reading: { runId, after: id },
              })),
              Effect.transposeOption(
                Option.map(Option.liftPredicate(data, isCustom), (event) =>
                  Effect.sync(() => get.set(custom, Option.some(event))),
                ),
              ),
            ),
          ),
        ),
        Effect.ensuring(changed(get, (current) => ({ ...current, reading: null }))),
        Effect.andThen(
          Effect.flatMap(ChatApiClient, ({ chat }) =>
            chat.snapshot({ params: { session }, query: { limit: pageSize } }),
          ),
        ),
        Effect.flatMap((snapshot) =>
          changed(get, (current) => ({ ...current, view: caughtUp(current.view, snapshot) })),
        ),
      );

    /** Reads the newest page, and rejoins the run still going. */
    const open = runtime.fn((_: void, get) =>
      Effect.gen(function* () {
        const { chat } = yield* ChatApiClient;
        const snapshot = yield* chat.snapshot({ params: { session }, query: { limit: pageSize } });
        get.set(state, Option.some({ view: viewOf(snapshot), reading: null }));
        yield* Effect.transposeOption(
          Option.map(Option.fromNullishOr(snapshot.activeRun), ({ runId }) =>
            Effect.flatMap(chat.join({ params: { session, run: runId }, query: {} }), (events) =>
              following(get, runId, events),
            ),
          ),
        );
      }),
    );

    /** Sends a user turn and reads its run. A refused turn leaves the conversation. */
    const send = runtime.fn((input: Send, get) =>
      Effect.gen(function* () {
        const { chat } = yield* ChatApiClient;
        const crypto = yield* Crypto.Crypto;
        const runId = yield* crypto.randomUUIDv7();
        const message: ChatMessage = {
          id: yield* crypto.randomUUIDv7(),
          role: "user",
          parts: partsOf(input.content),
        };
        const shown = (messages: ReadonlyArray<ChatMessage>) =>
          changed(get, (current) => ({ ...current, view: { ...current.view, messages } }));
        yield* Effect.flatMap(
          Effect.sync(() => get(state)),
          (current) =>
            Effect.transposeOption(
              Option.map(current, ({ view }) => shown([...view.messages, message])),
            ),
        );
        const events = yield* chat
          .run({
            params: { session },
            headers: { "x-session-holder": input.holder },
            payload: {
              runId,
              messages: [{ id: message.id, role: "user", content: input.content }],
              ...optionalProperty("forwardedProps", input.forwardedProps),
            },
          })
          .pipe(
            Effect.tapError(() =>
              changed(get, (current) => ({
                ...current,
                view: {
                  ...current.view,
                  messages: current.view.messages.filter(({ id }) => id !== message.id),
                },
              })),
            ),
          );
        yield* following(get, runId, events);
      }),
    );

    /** Answers the approvals a run waits for with a run that resumes it. */
    const answer = runtime.fn((input: Answer, get) =>
      Effect.gen(function* () {
        const { chat } = yield* ChatApiClient;
        const runId = yield* Effect.flatMap(Crypto.Crypto, (crypto) => crypto.randomUUIDv7());
        const events = yield* chat.run({
          params: { session },
          headers: { "x-session-holder": input.holder },
          payload: {
            runId,
            parentRunId: input.parentRunId,
            messages: [],
            resume: input.answers,
          },
        });
        yield* following(get, runId, events);
      }),
    );

    /** Reads the page of messages before those the page has. */
    const loadOlder = runtime.fn((_: void, get) =>
      Effect.gen(function* () {
        const { chat } = yield* ChatApiClient;
        const before = Option.flatMapNullishOr(get(state), ({ view }) => view.older);
        yield* Effect.transposeOption(
          Option.map(before, (before) =>
            Effect.flatMap(
              chat.snapshot({ params: { session }, query: { limit: pageSize, before } }),
              (page) =>
                changed(get, (current) => ({
                  ...current,
                  view: {
                    ...current.view,
                    messages: [...page.messages, ...current.view.messages],
                    older: page.older,
                  },
                })),
            ),
          ),
        );
      }),
    );

    return { state, custom, open, send, answer, loadOlder };
  });
