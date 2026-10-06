import {
  Cause,
  Context,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  RcMap,
  Schema,
  Semaphore,
} from "effect";

class LeaseActionFailed extends Schema.TaggedError<LeaseActionFailed>()("LeaseActionFailed", {
  cause: Schema.Defect(),
}) {}

class LeaseActionLocks extends Context.Service<
  LeaseActionLocks,
  RcMap.RcMap<string, Semaphore.Semaphore>
>()("agent/app/entry/session/lease-actions/LeaseActionLocks") {}

/** Same-session lease actions share a lock until every queued action releases it. */
export function orderedLeaseActions() {
  const runtime = ManagedRuntime.make(
    Layer.effect(
      LeaseActionLocks,
      RcMap.make({ lookup: (_sessionId: string) => Semaphore.make(1) }),
    ),
  );
  function run<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    return runtime
      .runPromiseExit(
        Effect.gen(function* () {
          const locks = yield* LeaseActionLocks;
          const lock = yield* RcMap.get(locks, sessionId);
          return yield* lock.withPermit(
            Effect.tryPromise({
              try: action,
              catch: (cause) => LeaseActionFailed.make({ cause }),
            }),
          );
        }).pipe(Effect.scoped),
      )
      .then((exit) =>
        Exit.match(exit, {
          onSuccess: (value) => value,
          onFailure: (cause) => {
            const error = Cause.squash(cause);
            // Preserve the native Promise rejection consumed by the React caller.
            throw Schema.is(LeaseActionFailed)(error) ? error.cause : error;
          },
        }),
      );
  }
  return Object.assign(run, { dispose: () => runtime.dispose() });
}
