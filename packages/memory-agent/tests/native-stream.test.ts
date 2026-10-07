import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Stream } from "effect";
import { nativePromise, runNativeEffect } from "../src/runtime/native-effect.ts";
import { nativeStream } from "../src/runtime/native-stream.ts";

it.live("return interrupts a pending pull and releases the stream before resolving", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const run = Effect.runPromiseWith(yield* Effect.context());
    let released = false;
    const stream = nativeStream(
      Stream.concat(
        Stream.make(1),
        Stream.fromEffect(Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))),
      ).pipe(
        Stream.ensuring(
          Effect.sync(() => {
            released = true;
          }),
        ),
      ),
    );
    expect(yield* nativePromise(() => stream.next())).toEqual({ done: false, value: 1 });
    const next = stream.next();
    yield* Effect.promise(() => run(Deferred.await(started)));
    expect(yield* nativePromise(() => stream.return())).toEqual({ done: true, value: undefined });
    expect(released).toBe(true);
    expect(yield* nativePromise(() => next)).toEqual({ done: true, value: undefined });
    expect(yield* nativePromise(() => stream.next())).toEqual({ done: true, value: undefined });
  }),
);

it.live("native Promise errors keep their identity through the Effect boundary", () =>
  Effect.gen(function* () {
    const error = new TypeError("native SDK failure");
    yield* Effect.promise(() =>
      expect(runNativeEffect(nativePromise(() => Promise.reject(error)))).rejects.toBe(error),
    );
    const stream = nativeStream(Stream.fromEffect(nativePromise(() => Promise.reject(error))));
    yield* Effect.promise(() => expect(stream.next()).rejects.toBe(error));
  }),
);
