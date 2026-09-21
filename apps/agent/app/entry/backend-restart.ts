import { Schema } from "effect";

const BackendRestartBody = Schema.Struct({
  error: Schema.Literal("backend_restart_required", "backend_restarting"),
});

let restartRequired = false;
const listeners = new Set<() => void>();

const markBackendRestartRequired = () => {
  if (restartRequired) return;
  restartRequired = true;
  for (const listener of listeners) listener();
};

export async function responseRequiresBackendRestart(response: Response) {
  if (response.ok) return false;
  return Schema.is(BackendRestartBody)(
    await response
      .clone()
      .json()
      .catch(() => null),
  );
}

const observeBackendRestart = async (response: Response) => {
  if (await responseRequiresBackendRestart(response)) markBackendRestartRequired();
  return response;
};

/** Every browser request, including the chat SSE transport, reports a stale development backend. */
export const appFetch: typeof fetch = async (...arguments_) =>
  observeBackendRestart(await fetch(...arguments_));

export const subscribeBackendRestart = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const backendRestartSnapshot = () => restartRequired;
