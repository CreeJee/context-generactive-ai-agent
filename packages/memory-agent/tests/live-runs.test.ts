import { Context, Deferred, Effect, Fiber, Layer, Stream } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { createLiveRuns } from "../src/agent/live-runs.ts";
import { RunCancellations } from "../src/runtime/run-cancellation.ts";
import { RunFailed } from "../src/loop/run.ts";

const fixture = Effect.gen(function* () {
  const cancellations = Context.get(yield* Layer.build(RunCancellations.layer), RunCancellations);
  const first = yield* cancellations.allocate("service_shutdown");
  const second = yield* cancellations.allocate("service_shutdown");
  return { runs: yield* createLiveRuns, first: first.controller, second: second.controller };
});

describe("createLiveRuns", () => {
  it.effect("run end waits for settlement before releasing its lifetime", () =>
    Effect.gen(function* () {
      const { runs, first } = yield* fixture;
      const settling = yield* Deferred.make<void>();
      const complete = yield* Deferred.make<void>();
      const claim = yield* runs.claim(
        "session",
        "first",
        first,
        undefined,
        Effect.void,
        undefined,
        Deferred.succeed(settling, undefined).pipe(Effect.andThen(Deferred.await(complete))),
      );
      const active = runs.get("session");
      if (claim === null || active === null) throw new Error("Missing active run");
      const release = yield* Effect.forkChild(claim.release);
      const ended = yield* Effect.forkChild(active.ended);
      yield* Deferred.await(settling);
      expect(release.pollUnsafe()).toBeUndefined();
      expect(ended.pollUnsafe()).toBeUndefined();
      yield* Deferred.succeed(complete, undefined);
      yield* Fiber.join(release);
      yield* Fiber.join(ended);
      expect(runs.get("session")).toBeNull();
    }),
  );
  it.effect("one session has one active stream and releases its claim on completion", () =>
    Effect.gen(function* () {
      const { runs, first, second } = yield* fixture;
      const claim = yield* runs.claim("session", "first", first);
      expect(claim).not.toBeNull();
      if (claim === null) return;
      expect(yield* runs.claim("session", "second", second)).toBeNull();
      yield* Stream.runDrain(claim.track(Stream.empty));
      expect(runs.get("session")).toBeNull();
      expect(yield* runs.claim("session", "second", second)).not.toBeNull();
    }),
  );

  it.effect("a failing stream preserves its typed failure and frees the session", () =>
    Effect.gen(function* () {
      const { runs, first } = yield* fixture;
      const claim = yield* runs.claim("session", "first", first);
      const active = runs.get("session");
      expect(claim).not.toBeNull();
      expect(active).not.toBeNull();
      if (claim === null || active === null) return;
      const failure = RunFailed.make({ message: "stream failed" });
      expect(yield* Stream.runDrain(claim.track(Stream.fail(failure))).pipe(Effect.flip)).toBe(
        failure,
      );
      yield* active.ended;
      expect(runs.get("session")).toBeNull();
    }),
  );
});
