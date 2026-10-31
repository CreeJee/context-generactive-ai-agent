import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { BtwChat } from "memory-agent";
import { AppApi } from "memory-agent/app-api";
import { refusalsOnly } from "./agent-chat-refusals.ts";

/** The BTW threads group of `AppApi` (`/api/sessions/:session/btw`, `/api/btw/:thread`). */
export const BtwThreadsApiHandlers = HttpApiBuilder.group(
  AppApi,
  "btw",
  Effect.fn(function* (handlers) {
    const btw = yield* BtwChat;

    return handlers.handleAll({
      list: ({ params: { session } }) => Effect.orDie(btw.list(session)),
      create: ({ params: { session } }) =>
        btw.create(session).pipe(
          Effect.catchReason("BtwError", "BtwParentNotFound", () =>
            Effect.fail({ error: "session_not_found" } as const),
          ),
          refusalsOnly,
        ),
      remove: ({ params: { thread } }) =>
        btw.remove(thread).pipe(
          Effect.as({ deleted: true, filesPending: false } as const),
          Effect.catchReasons("BtwError", {
            BtwThreadNotFound: () => Effect.fail({ error: "btw_not_found" } as const),
            BtwRunInProgress: () => Effect.fail({ error: "run_in_progress" } as const),
            // The rows are gone; the next cleanup removes the image files left behind.
            BtwStorageFailed: () => Effect.succeed({ deleted: true, filesPending: true } as const),
          }),
          refusalsOnly,
        ),
    });
  }),
);
