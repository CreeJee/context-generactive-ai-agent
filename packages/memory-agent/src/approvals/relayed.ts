// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { randomUUID } from "node:crypto";
import { Clock, Cause, Context, Deferred, Effect, Exit, HashMap, Layer, Option, Ref } from "effect";
import type { RelayedApprovalView } from "./relayed-state.ts";

interface Pending {
  readonly sequence: number;
  readonly sessionId: string;
  readonly view: RelayedApprovalView;
  readonly done: Deferred.Deferred<boolean>;
}

export type RelayedRequest = Omit<RelayedApprovalView, "id" | "createdAt">;

const make = Effect.gen(function* () {
  const pending = yield* Ref.make(HashMap.empty<string, Pending>());
  let nextSequence = 0;
  let closed = false;

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      closed = true;
      const outstanding = yield* Ref.getAndSet(pending, HashMap.empty());
      for (const entry of HashMap.values(outstanding)) yield* Deferred.succeed(entry.done, false);
    }),
  );

  const context = yield* Effect.context<never>();
  const run = Effect.runPromiseExitWith(context);
  const runSync = Effect.runSyncWith(context);

  return {
    /**
     * Waits for the user's answer to a call made where no TanStack interrupt can pause the run (a
     * subagent, an external agent). A cancelled run answers no. Kept in memory: after a restart
     * the work that asked is gone too.
     */
    ask: (sessionId: string, request: RelayedRequest, signal: AbortSignal) =>
      signal.aborted || closed
        ? Promise.resolve(false)
        : run(
            Effect.gen(function* () {
              const effectClock = yield* Clock.Clock;

              const id: string = randomUUID();
              const done = yield* Deferred.make<boolean>();
              yield* Ref.update(pending, (entries) =>
                HashMap.set(entries, id, {
                  sequence: nextSequence++,
                  sessionId,
                  done,
                  view: { ...request, id, createdAt: effectClock.currentTimeMillisUnsafe() },
                }),
              );
              return yield* Deferred.await(done).pipe(
                Effect.ensuring(Ref.update(pending, HashMap.remove(id))),
              );
            }),
            { signal },
          ).then((exit) =>
            Exit.match(exit, {
              onSuccess: (approved) => approved,
              onFailure: (cause) => {
                if (Cause.hasInterrupts(cause)) return false;
                throw Cause.squash(cause);
              },
            }),
          ),

    pending: (sessionId: string): RelayedApprovalView[] =>
      [...HashMap.values(runSync(Ref.get(pending)))]
        .filter((entry) => entry.sessionId === sessionId)
        .sort((left, right) => left.sequence - right.sequence)
        .map((entry) => entry.view),

    /** False when there is no such request in the session (already answered or gone). */
    answer: (sessionId: string, id: string, approved: boolean) => {
      const entry = runSync(
        Ref.modify(pending, (entries) => {
          const found = Option.getOrUndefined(HashMap.get(entries, id));
          return found?.sessionId === sessionId
            ? [found, HashMap.remove(entries, id)]
            : [undefined, entries];
        }),
      );
      if (!(entry !== undefined)) return false;
      Deferred.doneUnsafe(entry.done, Effect.succeed(approved));
      return true;
    },
  };
});

/** Approval requests relayed to the page from work that runs inside a tool call. */
export class RelayedApprovals extends Context.Service<
  RelayedApprovals,
  Effect.Success<typeof make>
>()("memory-agent/approvals/relayed/RelayedApprovals") {
  static readonly layer = Layer.effect(RelayedApprovals, make);
}
