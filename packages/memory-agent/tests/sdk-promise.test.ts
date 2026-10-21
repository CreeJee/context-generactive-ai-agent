import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { SdkRequestFailed, sdkPromise } from "../src/runtime/sdk-promise.ts";

it.effect("keeps SDK rejection and synchronous throws in the typed error channel", () =>
  Effect.gen(function* () {
    const cause = new Error("SDK failed");
    expect(yield* Effect.flip(sdkPromise(() => Promise.reject(cause)))).toEqual(
      SdkRequestFailed.make({ cause }),
    );
    expect(
      yield* Effect.flip(
        sdkPromise<never>(() => {
          throw cause;
        }),
      ),
    ).toEqual(SdkRequestFailed.make({ cause }));
    expect(yield* sdkPromise(() => Promise.resolve("answer"))).toBe("answer");
  }),
);

// Model the SDK's native Promise boundary; the test itself runs in Effect.
const pendingSdk =
  (started: Deferred.Deferred<AbortController>) =>
  (controller: AbortController): Promise<never> =>
    Effect.runPromise(Deferred.succeed(started, controller).pipe(Effect.andThen(Effect.never)), {
      signal: controller.signal,
    });

it.effect("interrupting a request aborts the SDK controller", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<AbortController>();
    const fiber = yield* started.pipe(pendingSdk, sdkPromise, Effect.forkChild);
    const controller = yield* Deferred.await(started);
    expect(controller.signal.aborted).toBe(false);
    yield* Fiber.interrupt(fiber);
    expect(controller.signal.aborted).toBe(true);
  }),
);

it.effect("virtual-clock timeout aborts the SDK before returning the fallback", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<AbortController>();
    const request = started.pipe(
      pendingSdk,
      sdkPromise,
      Effect.timeoutOrElse({ duration: "1 minute", orElse: () => Effect.succeed("ask") }),
    );
    const fiber = yield* Effect.forkChild(request);
    const controller = yield* Deferred.await(started);
    yield* TestClock.adjust("1 minute");
    expect(yield* Fiber.join(fiber)).toBe("ask");
    expect(controller.signal.aborted).toBe(true);
  }),
);
