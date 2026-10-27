import type { StreamDurability } from "@tanstack/ai";
import { Cause, Effect, Result, Schema, Stream } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { AgentChat, ChatStart } from "../agent/chat.ts";
import { BtwChat } from "../btw/chat.ts";
import { AgUiEvent } from "../loop/chunks.ts";
import { logDefect } from "../runtime/logged-failures.ts";
import { ChatApi, type Refusal, type RunEvent } from "./chat-api.ts";

const decodeEvent = Schema.decodeUnknownResult(AgUiEvent);
const lost = { error: "run_events_unavailable" } as const;

/**
 * A run's events as the API streams them, read from its log after `after`. The log also holds what
 * the TanStack loop wrote for the page; entries that are not AG-UI 1.0 events are left out.
 */
const runEvents = ({ log, after }: { readonly log: StreamDurability; readonly after: string }) =>
  Stream.unwrap(
    Effect.map(Effect.abortSignal, (signal) => {
      // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
      const reader = log.read(after, signal)[Symbol.asyncIterator]();
      // A closed stream aborts the read, which ends the reader. The stream does not ask the reader
      // to return: a generator answers that only after its pending read, which waits for the log's
      // next entry, so a page that leaves a quiet run would hold its stream open until then.
      return Stream.fromAsyncIterable(
        { [Symbol.asyncIterator]: () => ({ next: () => reader.next() }) },
        () => lost,
      );
    }),
  ).pipe(
    Stream.tapError(() => Effect.logWarning("Run log unreadable")),
    Stream.filterMap(({ offset, chunk }) =>
      Result.map(decodeEvent(chunk), (data): RunEvent => ({ id: offset, event: "message", data })),
    ),
  );

/** A failure no refusal names is a defect, answered 500 as the page's route answers it. */
const orDefect = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.catch(effect, (error) =>
    Effect.andThen(logDefect("route_defect")(Cause.fail(error)), Effect.die(error)),
  );

/** The API's answer to a run it started or follows: the run's events, or the refusal. */
const answered = <E>(start: Effect.Effect<ChatStart, E>) =>
  orDefect(start).pipe(
    Effect.flatMap(
      ChatStart.$match({
        Refused: ({ refusal }) => Effect.fail(refusal),
        Following: (following) => Effect.succeed(runEvents(following)),
      }),
    ),
  );

const refused = (refusal: Refusal) => Effect.succeed(ChatStart.Refused({ refusal }));
const sessionNotFound = () => refused({ error: "session_not_found" });
const providerUnavailable = ({ provider }: { readonly provider: string }) =>
  refused({ error: "provider_unavailable", provider });

const refusedWith = (refusal: Refusal) => Effect.succeed(Result.fail(refusal));
const providerRefusal = ({ provider }: { readonly provider: string }) =>
  refusedWith({ error: "provider_unavailable", provider });
const btwNotFound = () => refusedWith({ error: "btw_not_found" });

/** The BTW group of `ChatApi`, on `BtwChat`. A BTW run's events are numbered from its start. */
export const BtwApiHandlers = HttpApiBuilder.group(
  ChatApi,
  "btw",
  Effect.fn(function* (handlers) {
    const btw = yield* BtwChat;
    return handlers.handleAll({
      messages: ({ params }) =>
        btw
          .messages(params.thread)
          .pipe(
            Effect.map(Result.succeed),
            Effect.catchReason("BtwError", "BtwThreadNotFound", btwNotFound),
            orDefect,
            Effect.flatMap(Effect.fromResult),
          ),
      ask: ({ params, payload }) =>
        btw.ask(params.thread, payload).pipe(
          Effect.catchReason("BtwError", "BtwThreadNotFound", btwNotFound),
          Effect.catchTags({
            ProviderUnavailable: providerRefusal,
            ModelUnavailable: providerRefusal,
          }),
          orDefect,
          Effect.flatMap(Effect.fromResult),
          Effect.map((events) =>
            Stream.map(Stream.zipWithIndex(events), ([data, index]): RunEvent => ({
              id: `${index}`,
              event: "message",
              data,
            })),
          ),
        ),
    });
  }),
);

/** The chat group of `ChatApi` (docs/effect-ai-migration.md step 6), on `AgentChat`. */
export const ChatApiHandlers = HttpApiBuilder.group(
  ChatApi,
  "chat",
  Effect.fn(function* (handlers) {
    const chat = yield* AgentChat;
    return handlers.handleAll({
      snapshot: ({ params, query }) =>
        chat.snapshot(params.session, query.limit, query.before).pipe(
          Effect.map(Result.succeed),
          Effect.catchTag("SessionNotFound", () =>
            Effect.succeed(Result.fail({ error: "session_not_found" } as const)),
          ),
          orDefect,
          Effect.flatMap(Effect.fromResult),
        ),
      run: ({ params, headers, payload }) =>
        chat
          .start(
            { holder: headers["x-session-holder"] ?? null, input: payload },
            params.session,
            null,
          )
          .pipe(
            Effect.catchTags({
              SessionNotFound: sessionNotFound,
              ProjectNotFound: () => refused({ error: "project_not_found" }),
              ProviderUnavailable: providerUnavailable,
              ModelUnavailable: providerUnavailable,
            }),
            answered,
          ),
      join: ({ params, query }) =>
        chat
          .follow(params.session, params.run, query.after ?? "-1")
          .pipe(Effect.catchTag("SessionNotFound", sessionNotFound), answered),
    });
  }),
);
