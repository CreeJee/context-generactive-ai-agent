import { randomUUID } from "node:crypto";
import { Context, Effect, Layer } from "effect";
import type { RelayedApprovalView } from "./relayed-state.ts";

interface Pending {
  readonly sessionId: string;
  readonly view: RelayedApprovalView;
  readonly resolve: (approved: boolean) => void;
}

export type RelayedRequest = Omit<RelayedApprovalView, "id" | "createdAt">;

const make = Effect.gen(function* () {
  const pending = new Map<string, Pending>();

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const entry of pending.values()) entry.resolve(false);
    }),
  );

  return {
    /**
     * Waits for the user's answer to a call made where no TanStack interrupt can pause the run (a
     * subagent, an external agent). A cancelled run answers no. Kept in memory: after a restart
     * the work that asked is gone too.
     */
    ask: (sessionId: string, request: RelayedRequest, signal: AbortSignal) =>
      new Promise<boolean>((resolve) => {
        if (signal.aborted) return resolve(false);
        const id = randomUUID();
        const done = (approved: boolean) => {
          pending.delete(id);
          signal.removeEventListener("abort", cancel);
          resolve(approved);
        };
        const cancel = () => done(false);
        signal.addEventListener("abort", cancel, { once: true });
        pending.set(id, {
          sessionId,
          resolve: done,
          view: { ...request, id, createdAt: Date.now() },
        });
      }),

    pending: (sessionId: string): RelayedApprovalView[] =>
      [...pending.values()]
        .filter((entry) => entry.sessionId === sessionId)
        .map((entry) => entry.view),

    /** False when there is no such request in the session (already answered or gone). */
    answer: (sessionId: string, id: string, approved: boolean) => {
      const entry = pending.get(id);
      if (!entry || entry.sessionId !== sessionId) return false;
      entry.resolve(approved);
      return true;
    },
  };
});

/** Approval requests relayed to the page from work that runs inside a tool call. */
export class RelayedApprovals extends Context.Service<
  RelayedApprovals,
  Effect.Success<typeof make>
>()("memory-agent/RelayedApprovals") {
  static readonly layer = Layer.effect(RelayedApprovals, make);
}
