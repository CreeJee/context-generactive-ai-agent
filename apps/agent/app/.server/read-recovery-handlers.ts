import {
  AgentChat,
  ReadRecoveryConfirmation,
  ReadRecoveryRevocation,
  sessionHolderHeader,
} from "memory-agent";
import { Effect, Result } from "effect";
import { readJson, rejectCrossSite } from "./http.ts";

interface RecoveryRuntime {
  readonly runPromise: <A, E>(program: Effect.Effect<A, E, AgentChat>) => Promise<A>;
}
export interface RecoveryArgs {
  readonly request: Request;
  readonly params: { readonly session: string; readonly run: string };
}

/** Operator-only HTTP action, never a model tool. Preview does not change workflow state. */
export function makeReadRecoveryHandlers(runtime: RecoveryRuntime) {
  return {
    revokeAction: ({ request, params }: RecoveryArgs) =>
      runtime.runPromise(
        Effect.gen(function* () {
          if (request.method !== "POST")
            return Response.json(
              { error: "method_not_allowed" },
              { status: 405, headers: { Allow: "POST" } },
            );
          const rejected = rejectCrossSite(request);
          if (rejected !== null) return rejected;
          const body = yield* Effect.tryPromise(() => readJson(request, ReadRecoveryRevocation));
          if (Result.isFailure(body))
            return Response.json({ error: "invalid_read_recovery_revocation" }, { status: 400 });
          return yield* Effect.flatMap(AgentChat, (chat) =>
            chat.revokeReadRecovery(
              params.session,
              request.headers.get(sessionHolderHeader),
              params.run,
              body.success,
            ),
          );
        }),
      ),
    // React Router's loader/action Promise contract is the native HTTP boundary.
    loader: ({ params }: RecoveryArgs) =>
      runtime.runPromise(
        Effect.flatMap(AgentChat, (chat) => chat.readRecovery(params.session, params.run)),
      ),
    action: ({ request, params }: RecoveryArgs) =>
      runtime.runPromise(
        Effect.gen(function* () {
          if (request.method !== "POST")
            return Response.json(
              { error: "method_not_allowed" },
              { status: 405, headers: { Allow: "POST" } },
            );
          const rejected = rejectCrossSite(request);
          if (rejected !== null) return rejected;
          const body = yield* Effect.tryPromise(() => readJson(request, ReadRecoveryConfirmation));
          if (Result.isFailure(body))
            return Response.json({ error: "invalid_read_recovery_confirmation" }, { status: 400 });
          return yield* Effect.flatMap(AgentChat, (chat) =>
            chat.confirmReadRecovery(
              params.session,
              request.headers.get(sessionHolderHeader),
              params.run,
              body.success,
            ),
          );
        }),
      ),
  };
}
