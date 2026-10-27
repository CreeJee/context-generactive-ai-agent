import type { StreamDurability } from "@tanstack/ai";
import { Cause, Effect, Result, Schema, Stream } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { AgentChat, ChatStart } from "../agent/chat.ts";
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
    Effect.map(Effect.abortSignal, (signal) =>
      // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
      Stream.fromAsyncIterable(log.read(after, signal), () => lost),
    ),
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
        // The API runs only the Effect AI loop, so it never gets one of the page's own responses.
        Answered: () => Effect.die("The chat API got a response only the page's route sends"),
        Following: (following) => Effect.succeed(runEvents(following)),
      }),
    ),
  );

const refused = (refusal: Refusal) => Effect.succeed(ChatStart.Refused({ refusal }));
const sessionNotFound = () => refused({ error: "session_not_found" });
const providerUnavailable = ({ provider }: { readonly provider: string }) =>
  refused({ error: "provider_unavailable", provider });

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
            {
              holder: headers["x-session-holder"] ?? null,
              // The session is the thread; the API takes no client tools or context.
              body: Effect.succeed({
                ...payload,
                threadId: params.session,
                tools: [],
                context: [],
              }),
            },
            params.session,
            null,
            "api",
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
