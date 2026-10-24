import { it } from "@effect/vitest";
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import { EventType } from "@tanstack/ai";
import { Cause, Deferred, Effect, Exit, Fiber, Option, Stream } from "effect";
import { expect, vi } from "vite-plus/test";
import { ScriptedTextAdapter } from "../src/testing/scripted-adapter.ts";
import { sdkCancellation } from "./support/sdk-cancellation.ts";

for (const kind of ["responder", "promise", "delay", "effect-responder", "effect-gate"] as const) {
  it.live(`cancellation ends the scripted ${kind} wait and detaches its listener`, () =>
    Effect.gen(function* () {
      const context = yield* Effect.context();
      const run = Effect.runPromiseWith(context);
      const started = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      const ownedStarted = yield* Deferred.make<void>();
      let interrupted = false;
      const ownedWait = Deferred.succeed(ownedStarted, undefined).pipe(
        Effect.andThen(Deferred.await(released)),
        Effect.ensuring(
          Effect.sync(() => {
            interrupted = true;
          }),
        ),
      );
      yield* Effect.addFinalizer(() => Deferred.succeed(released, undefined));
      const { controller } = yield* sdkCancellation;
      const add = controller.signal.addEventListener.bind(controller.signal);
      const remove = vi.spyOn(controller.signal, "removeEventListener");
      vi.spyOn(controller.signal, "addEventListener").mockImplementation((...args) => {
        add(...args);
        if (args[0] === "abort") void run(Deferred.succeed(started, undefined));
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => vi.restoreAllMocks()));
      const adapter = new ScriptedTextAdapter(
        kind === "effect-responder"
          ? () => ownedWait.pipe(Effect.as({ text: "must not emit" }))
          : kind === "responder"
            ? () => run(Deferred.await(released).pipe(Effect.as({ text: "must not emit" })))
            : [
                kind === "effect-gate"
                  ? { text: "must not emit", waitFor: ownedWait }
                  : kind === "promise"
                    ? { text: "must not emit", waitFor: run(Deferred.await(released)) }
                    : { text: "must not emit", delayMs: 60_000 },
              ],
      );
      const chunks = Stream.fromAsyncIterable(
        adapter.chatStream({
          threadId: "thread",
          model: "scripted-1",
          messages: [],
          abortController: controller,
          logger: resolveDebugOption(false),
        }),
        (cause) => new Cause.UnknownError(cause),
      );
      const fiber = yield* Effect.forkScoped(Stream.runCollect(chunks));
      yield* Deferred.await(started);
      if (kind === "effect-responder" || kind === "effect-gate")
        yield* Deferred.await(ownedStarted);
      controller.abort("test cancellation");
      expect(yield* Fiber.join(fiber)).toEqual([]);
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
      if (kind === "effect-responder" || kind === "effect-gate") expect(interrupted).toBe(true);
    }),
  );
}

it.live("a rejected wait preserves its original failure", () =>
  Effect.gen(function* () {
    const failure = new Error("scripted wait rejected");
    const adapter = new ScriptedTextAdapter([{ waitFor: Promise.reject(failure) }]);
    const exit = yield* Effect.exit(
      Stream.runCollect(
        Stream.fromAsyncIterable(
          adapter.chatStream({
            threadId: "thread",
            model: "scripted-1",
            messages: [],
            logger: resolveDebugOption(false),
          }),
          (cause) => new Cause.UnknownError(cause),
        ),
      ),
    );
    const error = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();
    expect(Option.isSome(error) && error.value.cause).toBe(failure);
  }),
);

it.live("closing the SDK iterator interrupts a pending turn", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const released = yield* Deferred.make<void>();
    yield* Effect.addFinalizer(() => Deferred.succeed(released, undefined));
    const adapter = new ScriptedTextAdapter(() =>
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(released)),
        Effect.as({ text: "must not emit" }),
      ),
    );
    const iterator = adapter
      .chatStream({
        threadId: "thread",
        model: "scripted-1",
        messages: [],
        logger: resolveDebugOption(false),
      })
      [Symbol.asyncIterator]();
    const pending = iterator.next();
    yield* Deferred.await(started);
    yield* Effect.promise(() => iterator.return!());
    expect(yield* Effect.promise(() => pending)).toEqual({ done: true, value: undefined });
  }),
);

it.live("a mid-turn failure preserves the already delivered text chunks", () =>
  Effect.gen(function* () {
    const types: string[] = [];
    const adapter = new ScriptedTextAdapter([
      { text: "partial", failAfterText: "failed after text" },
    ]);
    const exit = yield* Effect.exit(
      Stream.runDrain(
        Stream.fromAsyncIterable(
          adapter.chatStream({
            threadId: "thread",
            model: "scripted-1",
            messages: [],
            logger: resolveDebugOption(false),
          }),
          (cause) => new Cause.UnknownError(cause),
        ).pipe(
          Stream.tap((chunk) =>
            Effect.sync(() => {
              types.push(chunk.type);
            }),
          ),
        ),
      ),
    );
    expect(types).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
    ]);
    const error = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();
    expect(Option.isSome(error) && error.value.cause).toEqual(new Error("failed after text"));
  }),
);
