import { NodeCrypto, NodeWorker } from "@effect/platform-node";
import { Worker } from "node:worker_threads";
import { requireRuntime, runtimeWorkerOptions } from "../../runtime/resources.ts";
import { ignoreLogged } from "../../runtime/logged-failures.ts";
import {
  Cause,
  Context,
  Crypto,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FiberMap,
  HashMap,
  Layer,
  Option,
  Predicate,
  Ref,
  Schema,
  Scope,
  Semaphore,
} from "effect";
import { RpcClient } from "effect/rpc";
import {
  NativeOwnerFailed,
  NativeOwnerRpcs,
  OwnerCommand,
  type OwnerReady,
  type OwnerReply,
  OwnerSetup,
} from "./worker-protocol.ts";
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
  /** `queued` until the job holds the owner's one slot; `active` until the worker answers. */
  readonly phase: "queued" | "active";
};
type State =
  | { readonly kind: "open"; readonly jobs: HashMap.HashMap<string, Job> }
  | { readonly kind: "failed"; readonly error: NativeOwnerFailed };

/** At most this many requests wait for or hold the owner. */
const capacity = 32;

/** How long the host waits for a reply before it gives up on a hung worker. */
const replyTimeout = Duration.seconds(2);

/**
 * A budgeted search answers `budget-exceeded` itself once its budget runs out, but an engine call
 * already admitted runs to its end. The host waits that long past the budget, so the typed native
 * outcome reaches the caller instead of a `request-timeout`.
 */
const replyDeadline = (command: OwnerCommand) => {
  switch (command.kind) {
    case "memory-search":
      return Duration.sum(Duration.millis(command.input.remainingMs), replyTimeout);
    case "vector-search-controlled":
      return Duration.sum(Duration.millis(command.budgetMs), replyTimeout);
    case "add":
    case "remove":
    case "reset":
    case "save":
    case "validate":
    case "vector-search":
      return replyTimeout;
  }
};

/** A started native owner worker, as the host drives it. Tests wrap it to gate transport. */
export interface OwnerTransport {
  readonly ready: OwnerReady;
  readonly send: (command: OwnerCommand) => Effect.Effect<OwnerReply, NativeOwnerFailed>;
  /** Completes once the worker has exited. */
  readonly exited: Effect.Effect<void>;
  /** Ends the worker now, without waiting for its current native call. */
  readonly terminate: Effect.Effect<void>;
}

export type OwnerWorker = { readonly setup: OwnerSetup; readonly workerFile: string | URL };
export type OwnerConnect = (
  worker: OwnerWorker,
) => Effect.Effect<OwnerTransport, NativeOwnerFailed, Scope.Scope>;

/** The worker behind an owner, over Effect RPC. Its Scope stops the worker and awaits exit. */
export const rpcTransport: OwnerConnect = Effect.fn("NativeOwner.rpcTransport")(
  function* ({ setup, workerFile }: OwnerWorker) {
    const spawned = yield* Deferred.make<Worker>();
    const exited = yield* Deferred.make<void>();
    const workers = NodeWorker.layer(() => {
      const worker = new Worker(workerFile, runtimeWorkerOptions(setup));
      worker.once("exit", () => Deferred.doneUnsafe(exited, Exit.void));
      Deferred.doneUnsafe(spawned, Exit.succeed(worker));
      return worker;
    });
    const protocol = yield* Layer.build(
      RpcClient.layerProtocolWorker({ size: 1, concurrency: 1 }).pipe(Layer.provide(workers)),
    );
    const client = yield* RpcClient.make(NativeOwnerRpcs).pipe(Effect.provide(protocol));
    /** A transport failure is the worker's: it exited, or its channel broke. */
    const lost = Effect.flatMap(Deferred.isDone(exited), (gone) =>
      Effect.fail(NativeOwnerFailed.make({ reason: gone ? "worker-exit" : "worker-error" })),
    );
    const ready = yield* client.Open().pipe(
      Effect.catchTag("RpcClientError", () => lost),
      Effect.timeoutOrElse({
        duration: "2 seconds",
        orElse: () => Effect.fail(NativeOwnerFailed.make({ reason: "startup-timeout" })),
      }),
    );
    const worker = yield* Deferred.await(spawned);
    return {
      ready,
      send: (command) =>
        client.Execute(command).pipe(Effect.catchTag("RpcClientError", () => lost)),
      exited: Deferred.await(exited),
      terminate: Effect.tryPromise(() => worker.terminate()).pipe(
        ignoreLogged("native_owner_terminate_failed"),
        Effect.andThen(Deferred.await(exited)),
      ),
    } satisfies OwnerTransport;
  },
  Effect.catchTag("WorkerError", () =>
    Effect.fail(NativeOwnerFailed.make({ reason: "worker-error" })),
  ),
);

/** A worker reporting these has a broken index or reader; nothing after it can be trusted. */
const fatal = (error: NativeOwnerFailed) => {
  switch (error.reason) {
    case "index-failed":
    case "read-failed":
    case "native-incompatible":
    case "worker-exit":
    case "worker-error":
      return true;
    default:
      return false;
  }
};

/**
 * Scoped native owner. Each request is a job fibre in a `FiberMap` keyed by request id: queued
 * jobs wait for the owner's one slot (`Semaphore`), and the `Ref` ledger records each job's
 * phase for capacity, duplicates, cancellation and inspection. A caller that leaves stops a
 * queued job before dispatch, but an active job keeps the slot until the worker answers: the
 * native call it started is not over because its caller left.
 */
export const makeNativeOwner = Effect.fn("NativeOwner.make")(function* (
  setup: OwnerSetup,
  workerFile: string | URL,
  connect: OwnerConnect = rpcTransport,
) {
  const validated = yield* Schema.decodeEffect(OwnerSetup)(setup).pipe(
    Effect.mapError(() => NativeOwnerFailed.make({ reason: "invalid-input" })),
  );
  const crypto = yield* Crypto.Crypto;
  const ownerKey = yield* crypto
    .randomUUIDv4()
    .pipe(Effect.mapError(() => NativeOwnerFailed.make({ reason: "worker-error" })));
  const transport = yield* connect({ setup: { ...validated, ownerKey }, workerFile });
  const state = yield* Ref.make<State>({ kind: "open", jobs: HashMap.empty() });
  const slot = yield* Semaphore.make(1);
  const jobs = yield* FiberMap.make<string>();
  // Sole reply-ingress writer, updated before releasing command waiters.
  const cachedSize = yield* Ref.make(transport.ready.size);

  const failAll = Effect.fnUntraced(function* (error: NativeOwnerFailed) {
    const previous = yield* Ref.getAndUpdate(state, (current): State =>
      current.kind === "failed" ? current : { kind: "failed", error },
    );
    switch (previous.kind) {
      case "failed":
        return;
      case "open":
        for (const job of HashMap.values(previous.jobs)) {
          yield* Effect.sync(() => {
            if (Option.isSome(job.control)) job.control.value.close();
          });
          yield* Deferred.fail(job.result, error);
        }
        yield* FiberMap.clear(jobs);
    }
  });
  yield* Effect.addFinalizer(() => failAll(NativeOwnerFailed.make({ reason: "closed" })));
  // Queued waiters must settle when the worker goes, not only the request it was running.
  yield* Effect.forkScoped(
    transport.exited.pipe(
      Effect.andThen(failAll(NativeOwnerFailed.make({ reason: "worker-exit" }))),
    ),
  );

  const setPhase = (requestId: string, phase: Job["phase"]) =>
    Ref.update(state, (current) =>
      current.kind === "open"
        ? {
            ...current,
            jobs: HashMap.modify(current.jobs, requestId, (job) => ({ ...job, phase })),
          }
        : current,
    );
  /** Removes exactly this job: a later job may reuse its request id. */
  const forget = (job: Job) =>
    Ref.update(state, (current) =>
      current.kind === "open" &&
      Option.exists(
        HashMap.get(current.jobs, job.command.requestId),
        (entry) => entry.result === job.result,
      )
        ? { ...current, jobs: HashMap.remove(current.jobs, job.command.requestId) }
        : current,
    );
  const phaseOf = (job: Job) =>
    Effect.map(Ref.get(state), (current) =>
      current.kind === "open"
        ? Option.map(HashMap.get(current.jobs, job.command.requestId), (entry) => entry.phase)
        : Option.none(),
    );
  const sizeOf = (reply: OwnerReply) => {
    switch (reply.kind) {
      case "ack":
      case "removed":
      case "vector-hits":
      case "controlled-result":
        return Option.some(reply.size);
      case "memory-result":
        return Option.none();
    }
  };

  /** Holds the slot from dispatch until the worker answers, then settles the caller's wait. */
  const run = (job: Job) =>
    slot
      .withPermits(1)(
        setPhase(job.command.requestId, "active").pipe(
          Effect.andThen(
            Effect.suspend(() => {
              const command = job.command;
              switch (command.kind) {
                case "vector-search-controlled":
                case "memory-search":
                  return Option.match(job.control, {
                    onNone: () => Effect.fail(NativeOwnerFailed.make({ reason: "invalid-input" })),
                    onSome: (control) =>
                      transport.send({ ...command, controlToken: control.token }),
                  });
                case "add":
                case "remove":
                case "reset":
                case "save":
                case "validate":
                case "vector-search":
                  return transport.send(command);
              }
            }),
          ),
          Effect.tap((reply) =>
            Option.match(sizeOf(reply), {
              onNone: () => Effect.void,
              onSome: (size) => Ref.set(cachedSize, size),
            }),
          ),
          Effect.exit,
          Effect.flatMap((exit) =>
            Deferred.done(job.result, exit).pipe(
              Effect.andThen(
                Exit.match(exit, {
                  onSuccess: () => Effect.void,
                  onFailure: (cause) =>
                    Effect.forEach(
                      cause.reasons.flatMap((reason) =>
                        Cause.isFailReason(reason) && fatal(reason.error) ? [reason.error] : [],
                      ),
                      failAll,
                      { discard: true },
                    ),
                }),
              ),
            ),
          ),
        ),
      )
      .pipe(Effect.ensuring(forget(job)));

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
    // Owned copies: the transport transfers their buffers to the worker.
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
          return { ...input };
      }
    })();
    const job: Job = { command: owned, result, control, phase: "queued" };
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
                  if (HashMap.has(current.jobs, input.requestId))
                    return [
                      Effect.fail(NativeOwnerFailed.make({ reason: "invalid-input" })),
                      current,
                    ];
                  if (HashMap.size(current.jobs) >= capacity)
                    return [Effect.fail(NativeOwnerFailed.make({ reason: "queue-full" })), current];
                  return [
                    Effect.void,
                    { ...current, jobs: HashMap.set(current.jobs, input.requestId, job) },
                  ];
              }
            },
          ).pipe(Effect.flatten);
          yield* FiberMap.run(jobs, input.requestId, run(job));
          if (admission !== undefined && Option.isSome(control)) {
            const observed = control.value;
            yield* Effect.forkScoped(
              restore(
                Effect.gen(function* () {
                  while (true) {
                    const terminal = yield* Deferred.poll(result);
                    if (Option.isSome(terminal)) {
                      const outcome = yield* Effect.exit(terminal.value);
                      yield* Exit.match(outcome, {
                        onSuccess: (reply) =>
                          Deferred.succeed(admission, { kind: "completed", reply }),
                        onFailure: (cause) => Deferred.failCause(admission, cause),
                      });
                      return;
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
                duration: replyDeadline(input),
                orElse: () => Effect.fail(NativeOwnerFailed.make({ reason: "request-timeout" })),
              }),
              // A queued job its caller left is never dispatched; an active one keeps its slot.
              Effect.ensuring(
                Effect.flatMap(phaseOf(job), (phase) =>
                  Option.contains(phase, "queued")
                    ? FiberMap.remove(jobs, input.requestId)
                    : Effect.void,
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
    const control = Option.flatMap(HashMap.get(current.jobs, requestId), (job) => job.control);
    if (Option.isNone(control)) return yield* NativeOwnerFailed.make({ reason: "invalid-input" });
    // Direct main-thread native atomic store, never a message to the blocked worker.
    yield* Effect.sync(() => control.value.cancel());
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
    threadId: transport.ready.threadId,
    initialSize: transport.ready.size,
    // Synchronous legacy API metadata bridge; never invokes native code or mutates state.
    size: () => Ref.getUnsafe(cachedSize),
    initialNeedsReset: transport.ready.needsReset,
    inspect: Ref.get(state).pipe(
      Effect.map((current) => {
        switch (current.kind) {
          case "open": {
            const phases = [...HashMap.values(current.jobs)].map((job) => job.phase);
            return {
              kind: "open" as const,
              queued: phases.filter((phase) => phase === "queued").length,
              active: phases.filter((phase) => phase === "active").length,
            };
          }
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
