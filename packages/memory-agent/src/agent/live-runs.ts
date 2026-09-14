import type { StreamChunk } from "@tanstack/ai";

/** A run whose model stream is still being produced in this process. */
export interface LiveRun {
  readonly runId: string;
  readonly controller: AbortController;
  /** Resolves once the stream has ended: finished, paused for approval, failed or cancelled. */
  readonly ended: Promise<void>;
}

/**
 * The runs this process is producing, one per session. A reload or a closed tab does not end a
 * run (its output keeps going to the durable log), so this, not the HTTP request, is what a
 * cancel reaches and what stops a second run from starting in the same session.
 */
export class LiveRuns {
  readonly #bySession = new Map<string, LiveRun>();

  get(sessionId: string): LiveRun | null {
    return this.#bySession.get(sessionId) ?? null;
  }

  /**
   * Claims the session for a new run and returns its stream wrapped so the claim is released when
   * the stream ends. Null when another run is still producing in the session.
   */
  claim(
    sessionId: string,
    runId: string,
    controller: AbortController,
    /** Runs once the stream has ended and the session is free again. */
    onEnded: () => void = () => {},
  ): { readonly track: (stream: AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk> } | null {
    if (this.#bySession.has(sessionId)) return null;
    let release = () => {};
    const ended = new Promise<void>((resolve) => {
      release = () => {
        if (this.#bySession.get(sessionId) === run) this.#bySession.delete(sessionId);
        onEnded();
        resolve();
      };
    });
    const run: LiveRun = { runId, controller, ended };
    this.#bySession.set(sessionId, run);
    return {
      track: async function* (stream) {
        try {
          yield* stream;
        } finally {
          release();
        }
      },
    };
  }
}
