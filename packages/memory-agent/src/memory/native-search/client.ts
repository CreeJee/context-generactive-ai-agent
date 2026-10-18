import { NodeCrypto } from "@effect/platform-node";
import { Worker } from "node:worker_threads";
import { requireRuntime, runtimeWorkerOptions } from "../../runtime/resources.ts";
import {
  Cause,
  Context,
  Crypto,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Predicate,
  Queue,
  Ref,
  Schema,
} from "effect";
import { NativeOwnerFailed, OwnerCommand, OwnerReply, OwnerSetup } from "./worker-protocol.ts";
import { nativeReadInputLogicalBytes } from "./read-protocol.ts";

export type ReadAdmission =
  | { readonly kind: "pinned" }
  | { readonly kind: "completed"; readonly reply: OwnerReply };
type RequestControl = {
  readonly token: string;
  snapshotWasPinned(): boolean;
  cancel(): void;
  close(): void;
};
type Job = {
  readonly command: OwnerCommand;
  readonly control: Option.Option<RequestControl>;
  readonly result: Deferred.Deferred<OwnerReply, NativeOwnerFailed>;
};
type State =
  | { readonly kind: "open"; readonly queued: readonly Job[]; readonly active: Option.Option<Job> }
  | { readonly kind: "failed"; readonly error: NativeOwnerFailed };
type Event =
  | { readonly kind: "reply"; readonly reply: OwnerReply }
  | { readonly kind: "failed"; readonly error: NativeOwnerFailed };

/** Scoped native transport. Ref owns the removable pending list; the capacity-one Queue
 * only wakes the dispatcher. Cancelled queued jobs therefore free capacity immediately.
 * Deferred owns waits and Scope owns both fibers and the Worker, not Promise resolver maps.
 */
export const makeNativeOwner = Effect.fn("NativeOwner.make")(function* (
  setup: OwnerSetup,
  workerFile: string | URL,
) {
  const validated = yield* Schema.decodeEffect(OwnerSetup)(setup).pipe(
    Effect.mapError(() => NativeOwnerFailed.make({ reason: "invalid-input" })),
  );
  const crypto = yield* Crypto.Crypto;
  const ownerKey = yield* crypto
    .randomUUIDv4()
    .pipe(Effect.mapError(() => NativeOwnerFailed.make({ reason: "worker-error" })));
  const state = yield* Ref.make<State>({ kind: "open", queued: [], active: Option.none() });
  const wake = yield* Queue.make<void>({ capacity: 1, strategy: "dropping" });
  const events = yield* Queue.make<Event, NativeOwnerFailed>({ capacity: 64 });
  const ready = yield* Deferred.make<OwnerReply, NativeOwnerFailed>();
  // Sole reply-ingress writer, updated before releasing command waiters.
  const cachedSize = yield* Ref.make(0);
  const worker = yield* Effect.acquireRelease(
    Effect.try({
      try: () => new Worker(workerFile, runtimeWorkerOptions({ ...validated, ownerKey })),
      catch: () => NativeOwnerFailed.make({ reason: "worker-error" }),
    }),
    (handle) =>
      Effect.callback<void>((resume) => {
        // Final transport ingress: the dispatch fibers/listeners may already have stopped.
        // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Native IPC ingress is schema-decoded before inspection.
        const reply = (input: unknown) => {
          const decoded = Schema.decodeUnknownOption(OwnerReply)(input);
          if (
            Option.isSome(decoded) &&
            decoded.value.kind === "closed" &&
            decoded.value.epoch === validated.epoch
          )
            resume(Effect.void);
        };
        const exited = () => resume(Effect.void);
        handle.on("message", reply);
        handle.once("exit", exited);
        try {
          handle.postMessage({
            kind: "close",
            requestId: "owner-shutdown",
            epoch: validated.epoch,
          });
        } catch {
          resume(Effect.void);
        }
        return Effect.sync(() => {
          handle.off("message", reply);
          handle.off("exit", exited);
        });
      }).pipe(
        Effect.timeoutOption("2 seconds"),
        Effect.ensuring(
          Effect.tryPromise({
            try: () => handle.terminate(),
            catch: () => NativeOwnerFailed.make({ reason: "worker-error" }),
          }).pipe(Effect.asVoid, Effect.orDie),
        ),
      ),
  );

  const failAll = Effect.fnUntraced(function* (error: NativeOwnerFailed) {
    const previous = yield* Ref.modify(state, (current): readonly [State, State] => [
      current,
      current.kind === "failed" ? current : { kind: "failed", error },
    ]);
    yield* Deferred.fail(ready, error);
    switch (previous.kind) {
      case "failed":
        break;
      case "open":
        for (const job of [...previous.queued, ...Option.toArray(previous.active)]) {
          yield* Effect.sync(() => {
            if (Option.isSome(job.control)) job.control.value.close();
          });
          yield* Deferred.fail(job.result, error);
        }
        break;
    }
  });

  // Node event ingress is the sole unsafe synchronous bridge. It never runs domain effects.
  const emit = (event: Event) => {
    if (!Queue.offerUnsafe(events, event)) {
      Queue.failCauseUnsafe(events, Cause.fail(NativeOwnerFailed.make({ reason: "worker-error" })));
    }
  };
  const onMessage: Parameters<Worker["on"]>[1] = (input) => {
    const decoded = Schema.decodeUnknownResult(OwnerReply)(input);
    switch (decoded._tag) {
      case "Success":
        emit({ kind: "reply", reply: decoded.success });
        break;
      case "Failure":
        emit({ kind: "failed", error: NativeOwnerFailed.make({ reason: "invalid-input" }) });
        break;
    }
  };
  const onError = () =>
    emit({ kind: "failed", error: NativeOwnerFailed.make({ reason: "worker-error" }) });
  const onExit = () =>
    emit({ kind: "failed", error: NativeOwnerFailed.make({ reason: "worker-exit" }) });
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      worker.on("message", onMessage);
      worker.on("error", onError);
      worker.on("exit", onExit);
    }),
    () =>
      Effect.sync(() => {
        worker.off("message", onMessage);
        worker.off("error", onError);
        worker.off("exit", onExit);
      }),
  );
  yield* Effect.addFinalizer(() => failAll(NativeOwnerFailed.make({ reason: "closed" })));

  const receive = Effect.forever(
    Effect.gen(function* () {
      const event = yield* Queue.take(events);
      switch (event.kind) {
        case "failed":
          return yield* event.error;
        case "reply": {
          const reply = event.reply;
          if (reply.epoch !== validated.epoch) return;
          if (reply.kind === "ready") {
            yield* Ref.set(cachedSize, reply.size);
            yield* Deferred.succeed(ready, reply);
            return;
          }
          const current = yield* Ref.get(state);
          if (current.kind === "failed") return;
          if (Option.isNone(current.active)) {
            if (reply.kind === "failed")
              yield* failAll(NativeOwnerFailed.make({ reason: reply.code }));
            return;
          }
          const job = current.active.value;
          if (job.command.requestId !== reply.requestId) return;
          switch (reply.kind) {
            case "failed": {
              const error = NativeOwnerFailed.make({ reason: reply.code });
              yield* Deferred.fail(job.result, error);
              if (
                reply.code === "index-failed" ||
                reply.code === "read-failed" ||
                reply.code === "native-incompatible"
              )
                yield* failAll(error);
              break;
            }
            case "ack":
            case "removed":
            case "vector-hits":
            case "controlled-result":
              yield* Ref.set(cachedSize, reply.size);
              yield* Deferred.succeed(job.result, reply);
              break;
            case "memory-result":
              yield* Deferred.succeed(job.result, reply);
              break;
            case "closed":
              yield* Deferred.succeed(job.result, reply);
              yield* failAll(NativeOwnerFailed.make({ reason: "closed" }));
              break;
          }
          break;
        }
      }
    }),
  ).pipe(Effect.catch((error) => failAll(error)));
  yield* Effect.forkScoped(receive);

  const dispatch = Effect.forever(
    Effect.gen(function* () {
      yield* Queue.take(wake);
      while (true) {
        const job = yield* Ref.modify(state, (current): readonly [Option.Option<Job>, State] => {
          if (current.kind === "failed" || current.queued.length === 0)
            return [Option.none(), current];
          const next = current.queued[0]!;
          return [
            Option.some(next),
            { ...current, queued: current.queued.slice(1), active: Option.some(next) },
          ];
        });
        if (Option.isNone(job)) break;
        yield* Effect.try({
          try: () => {
            const command = job.value.command;
            switch (command.kind) {
              case "vector-search-controlled":
              case "memory-search":
                if (Option.isNone(job.value.control))
                  throw NativeOwnerFailed.make({ reason: "invalid-input" });
                worker.postMessage({ ...command, controlToken: job.value.control.value.token });
                break;
              case "add":
              case "remove":
              case "reset":
              case "save":
              case "validate":
              case "vector-search":
              case "close":
                worker.postMessage(command);
                break;
            }
          },
          catch: () => NativeOwnerFailed.make({ reason: "worker-error" }),
        });
        // Caller interruption does not release this active native resource slot.
        yield* Deferred.await(job.value.result).pipe(Effect.catch(() => Effect.void));
        yield* Ref.update(state, (current) =>
          current.kind === "open" ? { ...current, active: Option.none() } : current,
        );
      }
    }),
  ).pipe(Effect.catch((error) => failAll(error)));
  yield* Effect.forkScoped(dispatch);
  const bootstrap = yield* Deferred.await(ready).pipe(
    Effect.timeoutOrElse({
      duration: "2 seconds",
      orElse: () => Effect.fail(NativeOwnerFailed.make({ reason: "startup-timeout" })),
    }),
  );
  if (bootstrap.kind !== "ready") return yield* NativeOwnerFailed.make({ reason: "invalid-input" });

  const executeRegistered = Effect.fnUntraced(function* (
    command: OwnerCommand,
    control: Option.Option<RequestControl>,
    admission?: Deferred.Deferred<ReadAdmission, NativeOwnerFailed>,
  ) {
    // Typed caller preflight must precede Schema's array decoding and owned copies.
    if (
      command.kind === "memory-search" &&
      nativeReadInputLogicalBytes(command.input) > command.input.inputBudgetBytes
    )
      return yield* NativeOwnerFailed.make({ reason: "input-budget" });
    const input = yield* Schema.decodeEffect(OwnerCommand)(command).pipe(
      Effect.mapError(() => NativeOwnerFailed.make({ reason: "invalid-input" })),
    );
    if (input.epoch !== validated.epoch)
      return yield* NativeOwnerFailed.make({ reason: "epoch-mismatch" });
    if (
      input.kind === "memory-search" &&
      nativeReadInputLogicalBytes(input.input) > input.input.inputBudgetBytes
    )
      return yield* NativeOwnerFailed.make({ reason: "input-budget" });
    const result = yield* Deferred.make<OwnerReply, NativeOwnerFailed>();
    const owned: OwnerCommand = (() => {
      switch (input.kind) {
        case "add":
          return { ...input, vectors: new Float32Array(input.vectors), ids: [...input.ids] };
        case "vector-search-controlled":
          return {
            ...input,
            query: new Float32Array(input.query),
            allowedIds: [...input.allowedIds],
          };
        case "vector-search":
          return {
            ...input,
            query: new Float32Array(input.query),
            allowedIds: input.allowedIds === undefined ? undefined : [...input.allowedIds],
          };
        case "memory-search":
          return {
            ...input,
            input: {
              ...input.input,
              query:
                input.input.query === undefined ? undefined : new Float32Array(input.input.query),
              allowedProjects: [...input.input.allowedProjects],
              trigramTerms: [...input.input.trigramTerms],
              shortTerms: [...input.input.shortTerms],
              morphTerms: [...input.input.morphTerms],
            },
          };
        case "validate":
        case "remove":
          return { ...input, ids: [...input.ids] };
        case "reset":
        case "save":
        case "close":
          return { ...input };
      }
    })();
    const job: Job = { command: owned, result, control };
    return yield* Effect.scoped(
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          yield* Ref.modify(
            state,
            (current): readonly [Effect.Effect<void, NativeOwnerFailed>, State] => {
              switch (current.kind) {
                case "failed":
                  return [Effect.fail(current.error), current];
                case "open":
                  if (
                    current.queued.some(
                      (pending) => pending.command.requestId === input.requestId,
                    ) ||
                    (Option.isSome(current.active) &&
                      current.active.value.command.requestId === input.requestId)
                  )
                    return [
                      Effect.fail(NativeOwnerFailed.make({ reason: "invalid-input" })),
                      current,
                    ];
                  if (current.queued.length + (Option.isSome(current.active) ? 1 : 0) >= 32)
                    return [Effect.fail(NativeOwnerFailed.make({ reason: "queue-full" })), current];
                  return [Effect.void, { ...current, queued: [...current.queued, job] }];
              }
            },
          ).pipe(Effect.flatten);
          yield* Queue.offer(wake, undefined);
          if (admission !== undefined && Option.isSome(control)) {
            const observed = control.value;
            yield* Effect.forkScoped(
              restore(
                Effect.gen(function* () {
                  while (true) {
                    const terminal = yield* Deferred.poll(result);
                    if (Option.isSome(terminal)) {
                      const outcome = yield* Effect.exit(terminal.value);
                      switch (outcome._tag) {
                        case "Success":
                          yield* Deferred.succeed(admission, {
                            kind: "completed",
                            reply: outcome.value,
                          });
                          return;
                        case "Failure":
                          yield* Deferred.failCause(admission, outcome.cause);
                          return;
                      }
                    }
                    if (yield* Effect.sync(() => observed.snapshotWasPinned())) {
                      yield* Deferred.succeed(admission, { kind: "pinned" });
                      return;
                    }
                    // Bounded Effect sleep, not busy spin or same-worker callback.
                    yield* Effect.sleep("1 millis");
                  }
                }),
              ),
            );
          }
          return yield* restore(
            Deferred.await(result).pipe(
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  if (Option.isSome(control)) control.value.cancel();
                }),
              ),
              Effect.timeoutOrElse({
                duration: "2 seconds",
                orElse: () => Effect.fail(NativeOwnerFailed.make({ reason: "request-timeout" })),
              }),
              Effect.ensuring(
                Ref.update(state, (current) =>
                  current.kind === "open"
                    ? {
                        ...current,
                        // This finalizer owns this exact job, not a future reuse of its request ID.
                        queued: current.queued.filter((pending) => pending !== job),
                      }
                    : current,
                ),
              ),
            ),
          );
        }),
      ),
    );
  });
  const execute = Effect.fn("NativeOwner.execute")(function* (
    command: OwnerCommand,
    admission?: Deferred.Deferred<ReadAdmission, NativeOwnerFailed>,
  ) {
    const token = yield* crypto
      .randomUUIDv4()
      .pipe(Effect.mapError(() => NativeOwnerFailed.make({ reason: "worker-error" })));
    return yield* Effect.acquireUseRelease(
      Effect.try({
        try: (): Option.Option<RequestControl> => {
          switch (command.kind) {
            case "memory-search":
            case "vector-search-controlled": {
              const binding = requireRuntime("turbovec").loadTurbovec();
              if (!Predicate.isFunction(binding.SearchControl))
                throw NativeOwnerFailed.make({ reason: "native-incompatible" });
              // eslint-disable-next-line typescript/unbound-method -- ABI capability inspection only; the method is never invoked without its receiver.
              if (
                admission !== undefined &&
                // eslint-disable-next-line typescript/unbound-method -- Inspection only, not an unbound invocation.
                !Predicate.isFunction(binding.SearchControl.prototype.snapshotWasPinned)
              )
                throw NativeOwnerFailed.make({ reason: "native-incompatible" });
              const budget =
                command.kind === "memory-search" ? command.input.remainingMs : command.budgetMs;
              const control = new binding.SearchControl(
                token,
                ownerKey,
                validated.epoch,
                command.requestId,
                budget,
              );
              return Option.some({
                token: control.token(),
                snapshotWasPinned: () => control.snapshotWasPinned(),
                cancel: () => control.cancel(),
                close: () => control.close(),
              });
            }
            case "add":
            case "remove":
            case "reset":
            case "save":
            case "validate":
            case "vector-search":
            case "close":
              return Option.none();
          }
        },
        catch: (error) =>
          Schema.is(NativeOwnerFailed)(error)
            ? error
            : NativeOwnerFailed.make({ reason: "invalid-input" }),
      }),
      (control) => executeRegistered(command, control, admission),
      (control) =>
        Effect.sync(() => {
          if (Option.isSome(control)) control.value.close();
        }),
    );
  });
  const cancel = Effect.fn("NativeOwner.cancel")(function* (requestId: string) {
    const current = yield* Ref.get(state);
    if (current.kind === "failed") return yield* current.error;
    const job = [...current.queued, ...Option.toArray(current.active)].find(
      (pending) => pending.command.requestId === requestId,
    );
    if (job === undefined || Option.isNone(job.control))
      return yield* NativeOwnerFailed.make({ reason: "invalid-input" });
    // Direct main-thread native atomic store, never a message to the blocked worker.
    const control = job.control.value;
    yield* Effect.sync(() => control.cancel());
  });
  const startRead = Effect.fn("NativeOwner.startRead")(function* (
    command: Extract<OwnerCommand, { kind: "memory-search" }>,
  ) {
    const admission = yield* Deferred.make<ReadAdmission, NativeOwnerFailed>();
    const fiber = yield* Effect.forkScoped(
      execute(command, admission).pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit)
            ? Deferred.failCause(admission, exit.cause)
            : Deferred.succeed(admission, { kind: "completed", reply: exit.value }),
        ),
      ),
    );
    return {
      epoch: validated.epoch,
      admission: Deferred.await(admission),
      result: Fiber.join(fiber),
    };
  });
  return {
    execute,
    startRead,
    cancel,
    epoch: validated.epoch,
    threadId: bootstrap.threadId,
    initialSize: bootstrap.size,
    // Synchronous legacy API metadata bridge; never invokes native code or mutates state.
    size: () => Ref.getUnsafe(cachedSize),
    initialNeedsReset: bootstrap.needsReset ?? false,
    inspect: Ref.get(state).pipe(
      Effect.map((current) => {
        switch (current.kind) {
          case "open":
            return {
              kind: "open" as const,
              queued: current.queued.length,
              active: Option.isSome(current.active) ? 1 : 0,
            };
          case "failed":
            return { kind: "failed" as const, reason: current.error.reason };
        }
      }),
    ),
  };
});

/** Composition-root Layer; runtime consumers yield the scoped service. */
export class NativeOwner extends Context.Service<
  NativeOwner,
  Effect.Success<ReturnType<typeof makeNativeOwner>>
>()("memory-agent/memory/native-search/client/NativeOwner") {
  static layer(setup: OwnerSetup, workerFile: string | URL) {
    return Layer.effect(NativeOwner, makeNativeOwner(setup, workerFile)).pipe(
      Layer.provide(NodeCrypto.layer),
    );
  }
}
