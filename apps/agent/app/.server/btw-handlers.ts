import { BtwChat } from "memory-agent";
import { Effect } from "effect";
import { rejectCrossSite } from "~/.server/http";

interface BtwRuntime {
  readonly runPromise: <A, E>(program: Effect.Effect<A, E, BtwChat>) => Promise<A>;
}

const btwNotFound = () =>
  Effect.succeed(Response.json({ error: "btw_not_found" }, { status: 404 }));

export function makeBtwHandlers(agent: BtwRuntime) {
  /** GET /api/sessions/:session/btw — the main conversation's BTW threads, newest first. */
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  function list({ params }: { params: { session: string } }) {
    return agent.runPromise(
      Effect.map(
        Effect.flatMap(BtwChat, (btw) => btw.list(params.session)),
        (threads) => Response.json(threads),
      ),
    );
  }

  /** POST /api/sessions/:session/btw — opens a new BTW thread bound to this conversation. */
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  function create({ request, params }: { request: Request; params: { session: string } }) {
    return agent.runPromise(
      Effect.gen(function* () {
        const rejected = rejectCrossSite(request);
        if (rejected !== null) return rejected;
        const thread = yield* (yield* BtwChat).create(params.session);
        return Response.json(thread, { status: 201 });
      }).pipe(
        Effect.catchReason("BtwError", "BtwParentNotFound", () =>
          Effect.succeed(Response.json({ error: "session_not_found" }, { status: 404 })),
        ),
      ),
    );
  }

  /** GET /api/btw/:thread/chat?threadId=<thread> — the saved BTW transcript, for reopening. */
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  function hydrate({ request, params }: { request: Request; params: { thread: string } }) {
    return agent.runPromise(
      Effect.flatMap(BtwChat, (btw) => btw.hydrate(request, params.thread)).pipe(
        Effect.catchReason("BtwError", "BtwThreadNotFound", btwNotFound),
      ),
    );
  }

  /** POST /api/btw/:thread/chat — one side question, streamed as Server-Sent Events. */
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  function chat({ request, params }: { request: Request; params: { thread: string } }) {
    return agent.runPromise(
      Effect.gen(function* () {
        const rejected = rejectCrossSite(request);
        if (rejected !== null) return rejected;
        return yield* (yield* BtwChat).handle(request, params.thread);
      }).pipe(
        Effect.catchReason("BtwError", "BtwThreadNotFound", btwNotFound),
        Effect.catchTag("ProviderUnavailable", (failure) =>
          Effect.succeed(
            Response.json(
              { error: "provider_unavailable", provider: failure.provider },
              { status: 503 },
            ),
          ),
        ),
      ),
    );
  }

  /**
   * DELETE /api/btw/:thread — explicit delete: the thread, its messages, tool calls and results,
   * and images no other message uses. `filesPending` means the database rows are gone but some
   * image files are removed only by the next cleanup.
   */
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  function remove({ request, params }: { request: Request; params: { thread: string } }) {
    return agent.runPromise(
      Effect.gen(function* () {
        const rejected = rejectCrossSite(request);
        if (rejected !== null) return rejected;
        if (request.method !== "DELETE")
          return Response.json({ error: "method_not_allowed" }, { status: 405 });
        yield* (yield* BtwChat).remove(params.thread);
        return Response.json({ deleted: true, filesPending: false });
      }).pipe(
        Effect.catchReasons("BtwError", {
          BtwThreadNotFound: btwNotFound,
          BtwRunInProgress: () =>
            Effect.succeed(Response.json({ error: "run_in_progress" }, { status: 409 })),
          BtwStorageFailed: () =>
            Effect.succeed(Response.json({ deleted: true, filesPending: true })),
        }),
      ),
    );
  }

  return { list, create, hydrate, chat, remove };
}
