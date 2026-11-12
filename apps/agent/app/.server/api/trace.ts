import { Effect } from "effect";
import { SecureRandom } from "effect/crypto";
import { HttpApiBuilder } from "effect/http-api";
import { AgentChat } from "memory-agent";
import { AppApi } from "memory-agent/app-api";
import { refusalsOnly } from "./agent-chat-refusals.ts";

/** The trace group of `AppApi` (`/api/sessions/:session/trace*`). */
export const TraceApiHandlers = HttpApiBuilder.group(
  AppApi,
  "trace",
  Effect.fn(function* (handlers) {
    const chat = yield* AgentChat;
    const crypto = yield* SecureRandom.SecureRandom;

    return handlers.handleAll({
      sessionTree: ({ params: { session } }) => refusalsOnly(chat.traceTree(session)),
      sessionStream: ({ params: { session }, query, headers }) =>
        refusalsOnly(chat.traceStream(session, query.after ?? headers["last-event-id"] ?? 0)),
      sessionTask: ({ params: { session, task } }) => refusalsOnly(chat.traceTask(session, task)),
      changeTask: ({ params: { session, task }, headers, payload }) =>
        Effect.gen(function* () {
          const holder = headers["x-session-holder"] ?? null;
          if (payload.intent === "resume")
            return yield* chat.requestTraceResume(
              session,
              holder,
              task,
              payload.expectedAttemptId,
              payload.confirmUncertain ?? false,
            );
          return yield* chat.lifecycleTraceTask(
            session,
            holder,
            task,
            payload.intent,
            // Browser/native SDK boundary requires a cryptographic correlation or idempotency token.
            payload.idempotencyKey ?? (yield* crypto.uuidV4()),
          );
        }).pipe(refusalsOnly),
    });
  }),
);
