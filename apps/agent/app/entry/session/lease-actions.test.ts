import { it } from "@effect/vitest";
import { Cause, Deferred, Effect, Fiber } from "effect";
import { expect, vi } from "vite-plus/test";
import { orderedLeaseActions } from "./lease-actions";

const leaseActions = Effect.acquireRelease(Effect.sync(orderedLeaseActions), (run) =>
  Effect.promise(() => run.dispose()),
);
const result = <A>(promise: Promise<A>) =>
  Effect.tryPromise({
    try: () => promise,
    catch: (cause) => new Cause.UnknownError(cause),
  });

it.live("re-entry waits for the previous claim and release in the same session", () =>
  Effect.gen(function* () {
    const run = yield* leaseActions;
    const context = yield* Effect.context();
    const execute = Effect.runPromiseWith(context);
    const entered = yield* Deferred.make<void>();
    const released = yield* Deferred.make<void>();
    yield* Effect.addFinalizer(() => Deferred.succeed(released, undefined));
    const calls: string[] = [];
    const claim = run("A", () =>
      execute(
        Effect.gen(function* () {
          calls.push("claim");
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(released);
        }),
      ),
    );
    const release = run("A", () => {
      calls.push("release");
      return Promise.resolve();
    });
    const reentry = run("A", () => {
      calls.push("reentry");
      return Promise.resolve();
    });
    yield* Deferred.await(entered);
    expect(calls).toEqual(["claim"]);
    yield* Deferred.succeed(released, undefined);
    yield* Effect.forEach([claim, release, reentry], result, { concurrency: 3 });
    expect(calls).toEqual(["claim", "release", "reentry"]);
  }),
);

it.live("another session does not wait for a slow lease request", () =>
  Effect.gen(function* () {
    const run = yield* leaseActions;
    const execute = Effect.runPromiseWith(yield* Effect.context());
    const released = yield* Deferred.make<void>();
    yield* Effect.addFinalizer(() => Deferred.succeed(released, undefined));
    const slow = run("A", () => execute(Deferred.await(released)));
    const other = vi.fn(() => Promise.resolve("mine"));
    expect(yield* result(run("B", other))).toBe("mine");
    expect(other).toHaveBeenCalledOnce();
    yield* Deferred.succeed(released, undefined);
    yield* result(slow);
  }),
);

it.live("a failed release does not prevent a later claim", () =>
  Effect.gen(function* () {
    const run = yield* leaseActions;
    const error = new Error("release failed");
    const release = run("A", () => Promise.reject(error));
    const claim = run("A", () => Promise.resolve("mine"));
    expect((yield* Effect.flip(result(release))).cause).toBe(error);
    expect(yield* result(claim)).toBe("mine");
  }),
);

it.live("disposing the owner cancels queued actions before they acquire the lock", () =>
  Effect.gen(function* () {
    const run = yield* leaseActions;
    const execute = Effect.runPromiseWith(yield* Effect.context());
    const entered = yield* Deferred.make<void>();
    const released = yield* Deferred.make<void>();
    yield* Effect.addFinalizer(() => Deferred.succeed(released, undefined));
    yield* Effect.forkScoped(
      Effect.suspend(() =>
        result(
          run("A", () =>
            execute(
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(released))),
            ),
          ),
        ),
      ).pipe(Effect.ignore),
    );
    yield* Deferred.await(entered);
    const queued = vi.fn(() => Promise.resolve("mine"));
    const submitted = yield* Deferred.make<void>();
    const waiting = yield* Effect.forkScoped(
      Effect.gen(function* () {
        const pending = run("A", queued);
        yield* Deferred.succeed(submitted, undefined);
        return yield* Effect.flip(result(pending));
      }),
    );
    yield* Deferred.await(submitted);
    yield* Effect.promise(() => run.dispose());
    expect((yield* Fiber.join(waiting)).cause).toBeDefined();
    expect(queued).not.toHaveBeenCalled();
    yield* Deferred.succeed(released, undefined);
  }),
);
