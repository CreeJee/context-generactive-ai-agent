import { Data, Effect, MutableHashSet, Function as EffectFunction } from "effect";
import { Schema } from "effect";

const BackendRestartBody = Schema.Struct({
  error: Schema.Literals(["backend_restart_required", "backend_restarting"]),
});

let restartRequired = false;
const listeners = MutableHashSet.empty<() => void>();

const markBackendRestartRequired = () => {
  if (restartRequired) return;
  restartRequired = true;
  for (const listener of listeners) listener();
};

const requiresRestart = (response: Response) =>
  response.ok
    ? Effect.succeed(false)
    : Effect.tryPromise(() => response.clone().json()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(BackendRestartBody)),
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
export const responseRequiresBackendRestart = (response: Response) =>
  Effect.runPromise(requiresRestart(response));

const observeBackendRestart = (response: Response) =>
  requiresRestart(response).pipe(
    Effect.tap((required) =>
      Effect.sync(() => {
        if (required) markBackendRestartRequired();
      }),
    ),
    Effect.as(response),
  );
class BackendTransportFailed extends Data.TaggedError("BackendTransportFailed")<{
  readonly cause: unknown;
}> {}

/** Pin requests to the backend used to build this client; never retry a rejected mutation. */
export const backendFetch: {
  (
    origin: string,
    transport: typeof fetch,
  ): (buildId: string) => ReturnType<typeof backendFetchBody>;
} & typeof backendFetchBody = EffectFunction.dual(3, backendFetchBody);
function backendFetchBody(buildId: string, origin: string, transport: typeof fetch): typeof fetch {
  return (input, init) =>
    Effect.runPromise(
      Effect.tryPromise({
        try: () => {
          const url = new URL(input instanceof Request ? input.url : String(input), origin);
          if (buildId.length > 0 && url.origin === origin && url.pathname.startsWith("/api/")) {
            const headers = new Headers(
              init?.headers ?? (input instanceof Request ? input.headers : undefined),
            );
            headers.set("x-context-agent-build-id", buildId);
            return transport(input, { ...init, headers });
          }
          return transport(input, init);
        },
        catch: (cause) => new BackendTransportFailed({ cause }),
      }).pipe(Effect.flatMap(observeBackendRestart)),
    );
}

/** Includes direct backend browsing and the chat SSE transport. */
export const appFetch: typeof fetch = (...arguments_) =>
  typeof window === "undefined"
    ? // Native Request/Response adapter preserves host and SDK stream semantics.
      fetch(...arguments_)
    : backendFetch(
        import.meta.env.VITE_CONTEXT_AGENT_BUILD_ID ?? "",
        window.location.origin,
        fetch,
      )(...arguments_);

export const subscribeBackendRestart = (listener: () => void) => {
  MutableHashSet.add(listeners, listener);
  return () => MutableHashSet.remove(listeners, listener);
};

export const backendRestartSnapshot = () => restartRequired;
