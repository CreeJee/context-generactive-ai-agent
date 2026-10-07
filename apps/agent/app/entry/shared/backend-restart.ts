import { Function as EffectFunction } from "effect";
import { Schema } from "effect";

const BackendRestartBody = Schema.Struct({
  error: Schema.Literals(["backend_restart_required", "backend_restarting"]),
});

let restartRequired = false;
const listeners = new Set<() => void>();

const markBackendRestartRequired = () => {
  if (restartRequired) return;
  restartRequired = true;
  for (const listener of listeners) listener();
};

// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export async function responseRequiresBackendRestart(response: Response) {
  if (response.ok) return false;
  return Schema.is(BackendRestartBody)(
    await response
      .clone()
      .json()
      .catch(() => null),
  );
}

// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
const observeBackendRestart = async (response: Response) => {
  if (await responseRequiresBackendRestart(response)) markBackendRestartRequired();
  return response;
};

/** Pin requests to the backend used to build this client; never retry a rejected mutation. */
export const backendFetch: {
  (
    origin: string,
    transport: typeof fetch,
  ): (buildId: string) => ReturnType<typeof backendFetchBody>;
} & typeof backendFetchBody = EffectFunction.dual(3, backendFetchBody);
function backendFetchBody(buildId: string, origin: string, transport: typeof fetch): typeof fetch {
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), origin);
    if (buildId.length > 0 && url.origin === origin && url.pathname.startsWith("/api/")) {
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      headers.set("x-context-agent-build-id", buildId);
      return observeBackendRestart(await transport(input, { ...init, headers }));
    }
    return observeBackendRestart(await transport(input, init));
  };
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
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const backendRestartSnapshot = () => restartRequired;
