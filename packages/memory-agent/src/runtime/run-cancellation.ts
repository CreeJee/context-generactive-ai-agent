import { Cause, Context, Effect, Exit, Fiber, Layer, Queue, Scope, Stream } from "effect";

interface ControllerLink {
  readonly controller: AbortController;
  readonly detach: () => void;
}

/** Live runs and the loop's cancel read a controller, while Effect owns the lifetime of its signal. */
function linkController(signal: AbortSignal, shutdownReason: string): ControllerLink {
  const controller = new AbortController();
  const abort = () => controller.abort(shutdownReason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  return { controller, detach: () => signal.removeEventListener("abort", abort) };
}

export interface RunCancellation {
  readonly controller: AbortController;
  readonly release: Effect.Effect<void>;
  readonly cancel: Effect.Effect<void>;
  /** Wait for execution cleanup while its output is still being drained and persisted. */
  readonly settled: Effect.Effect<void>;
  /** The run's events, read by a fiber the owning service keeps, so they outlive the request. */
  readonly publish: <A, E>(input: Stream.Stream<A, E>) => Effect.Effect<Stream.Stream<A, E>>;
}

/** A run outlives request handlers, but never its owning service. */
const allocate = Effect.fn("RunCancellations.allocate")(function* (options: {
  readonly owner: Scope.Scope;
  readonly shutdownReason: string;
}): Effect.fn.Return<RunCancellation> {
  const scope = yield* Scope.fork(options.owner);
  const links: ControllerLink[] = [];
  const detach = () => {
    for (const link of links) link.detach();
  };
  // Scope closes in reverse order: abort the Effect signal before removing SDK listeners.
  yield* Scope.addFinalizer(scope, Effect.sync(detach));
  const signal = yield* Effect.abortSignal.pipe(Effect.provideService(Scope.Scope, scope));
  const controller = linkController(signal, options.shutdownReason);
  links.push(controller);
  let interrupt: Effect.Effect<void> = Effect.void;
  let settled: Effect.Effect<void> = Effect.void;
  let released = false;
  const release = Effect.suspend(() => {
    released = true;
    return interrupt;
  }).pipe(
    Effect.ensuring(Effect.sync(detach)),
    Effect.ensuring(Scope.close(scope, Exit.void)),
    Effect.uninterruptible,
  );
  const fork = Effect.fnUntraced(function* <A, E>(work: Effect.Effect<A, E>) {
    const fiber = yield* Effect.forkIn(work, options.owner, { startImmediately: true });
    // Abort with the owner reason before Scope interrupts the producer Fiber.
    yield* Scope.addFinalizer(
      options.owner,
      Effect.sync(() => {
        if (!released) controller.controller.abort(options.shutdownReason);
      }),
    );
    interrupt = Fiber.interrupt(fiber);
    settled = Fiber.await(fiber).pipe(Effect.asVoid);
    return fiber;
  });
  return {
    controller: controller.controller,
    // A completed stream detaches before closing, preserving its committed finish.
    release,
    settled: Effect.suspend(() => settled),
    publish: Effect.fnUntraced(function* <A, E>(input: Stream.Stream<A, E>) {
      const queue = yield* Queue.bounded<A, E | Cause.Done>(1);
      yield* Scope.addFinalizer(scope, Queue.shutdown(queue));
      const producer = Stream.runForEach(input, (value) => Queue.offer(queue, value)).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit) ? Queue.end(queue) : Queue.failCause(queue, exit.cause),
        ),
      );
      yield* fork(producer);
      return Stream.fromQueue(queue).pipe(Stream.ensuring(release));
    }),
    cancel: Effect.sync(() => {
      for (const link of links) link.controller.abort();
    }).pipe(Effect.ensuring(release), Effect.uninterruptible),
  };
}, Effect.uninterruptible);

export class RunCancellations extends Context.Service<
  RunCancellations,
  {
    readonly allocate: (shutdownReason: string) => Effect.Effect<RunCancellation>;
  }
>()("memory-agent/runtime/run-cancellation/RunCancellations") {
  static readonly layer = Layer.effect(
    RunCancellations,
    Effect.gen(function* () {
      const owner = yield* Effect.scope;
      return { allocate: (shutdownReason) => allocate({ owner, shutdownReason }) };
    }),
  );
}
