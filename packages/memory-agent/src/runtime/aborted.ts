import { Effect } from "effect";

/** Completes once `signal` aborts, at once when it already has. */
export const aborted = (signal: AbortSignal) =>
  Effect.suspend(() =>
    signal.aborted
      ? Effect.void
      : Effect.callback<void>((resume) => {
          const abort = () => resume(Effect.void);
          signal.addEventListener("abort", abort, { once: true });
          return Effect.sync(() => signal.removeEventListener("abort", abort));
        }),
  );
