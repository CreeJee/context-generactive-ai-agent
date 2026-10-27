import { NodeCrypto, NodeWorker } from "@effect/platform-node";
import { Worker } from "node:worker_threads";
import { requireRuntime, runtimeWorkerOptions } from "../../runtime/resources.ts";
import { ignoreLogged } from "../../runtime/logged-failures.ts";
import {
  Cause,
  Context,
  Crypto,
  Data,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FiberMap,
  HashMap,
  Layer,
  Match,
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
  OwnerReply,
  OwnerSetup,
} from "./worker-protocol.ts";
import { nativeReadInputLogicalBytes } from "./read-protocol.ts";

export type ReadAdmission = Data.TaggedEnum<{
  pinned: {};
  completed: { readonly reply: OwnerReply };
}>;
export const ReadAdmission = Data.taggedEnum<ReadAdmission>();
/** What `inspect` reports: the open owner's queued and active jobs, or why it failed. */
export type OwnerInspection = Data.TaggedEnum<{
  open: { readonly queued: number; readonly active: number };
  failed: { readonly reason: NativeOwnerFailed["reason"] };
}>;
export const OwnerInspection = Data.taggedEnum<OwnerInspection>();
type ControlledCommand = (typeof OwnerCommand.cases)[
  | "memory-search"
  | "vector-search-controlled"]["Type"];
type RequestControl = {
  readonly token: string;
  snapshotWasPinned(): boolean;
  cancel(): void;
  close(): void;
};
/** A native SearchControl whose prototype reports whether a read pinned its snapshot. */
const SnapshotPinningControl = Schema.Struct({
  snapshotWasPinned: Schema.declare(Predicate.isFunction),
});
type Job = {
  readonly command: OwnerCommand;
  readonly control: Option.Option<RequestControl>;
  readonly result: Deferred.Deferred<OwnerReply, NativeOwnerFailed>;
  /** `queued` until the job holds the owner's one slot; `active` until the worker answers. */
  readonly phase: "queued" | "active";
};
type State = Data.TaggedEnum<{
  open: { readonly jobs: HashMap.HashMap<string, Job> };
  failed: { readonly error: NativeOwnerFailed };
}>;
const State = Data.taggedEnum<State>();

/** At most this many requests wait for or hold the owner. */
const capacity = 32;

/** How long the host waits for a reply before it gives up on a hung worker. */
const replyTimeout = Duration.seconds(2);

/**
 * A budgeted search answers `budget-exceeded` itself once its budget runs out, but an engine call
 * already admitted runs to its end. The host waits that long past the budget, so the typed native
 * outcome reaches the caller instead of a `request-timeout`.
 */
const replyDeadline = OwnerCommand.match({
  "memory-search": (command) =>
    Duration.sum(Duration.millis(command.input.remainingMs), replyTimeout),
  "vector-search-controlled": (command) =>
    Duration.sum(Duration.millis(command.budgetMs), replyTimeout),
  add: () => replyTimeout,
  remove: () => replyTimeout,
  reset: () => replyTimeout,
  save: () => replyTimeout,
  validate: () => replyTimeout,
  "vector-search": () => replyTimeout,
});

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
    const options = yield* runtimeWorkerOptions(setup);
    const workers = NodeWorker.layer(() => {
      const worker = new Worker(workerFile, options);
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
const fatal = (error: NativeOwnerFailed) =>
  Match.value(error.reason).pipe(
    Match.whenOr(
      "index-failed",
      "read-failed",
      "native-incompatible",
      "worker-exit",
      "worker-error",
      () => true,
    ),
    Match.orElse(() => false),
  );

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
  const state = yield* Ref.make<State>(State.open({ jobs: HashMap.empty() }));
  const slot = yield* Semaphore.make(1);
  const jobs = yield* FiberMap.make<string>();
  // Sole reply-ingress writer, updated before releasing command waiters.
  const cachedSize = yield* Ref.make(transport.ready.size);

  const failAll = Effect.fnUntraced(function* (error: NativeOwnerFailed) {
    const previous = yield* Ref.getAndUpdate(state, (current): State =>
      State.$is("failed")(current) ? current : State.failed({ error }),
    );
    yield* State.$match(previous, {
      failed: () => Effect.void,
      open: (previous) =>
        Effect.andThen(
          Effect.forEach(
            HashMap.values(previous.jobs),
            (job) =>
              Effect.andThen(
                Effect.transposeOption(
                  Option.map(job.control, (control) => Effect.sync(() => control.close())),
                ),
                Deferred.fail(job.result, error),
              ),
            { discard: true },
          ),
          FiberMap.clear(jobs),
        ),
    });
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
      State.$is("open")(current)
        ? State.open({
            jobs: HashMap.modify(current.jobs, requestId, (job) => ({ ...job, phase })),
          })
        : current,
    );
  /** Removes exactly this job: a later job may reuse its request id. */
  const forget = (job: Job) =>
    Ref.update(state, (current) =>
      State.$is("open")(current) &&
      Option.exists(
        HashMap.get(current.jobs, job.command.requestId),
        (entry) => entry.result === job.result,
      )
        ? State.open({ jobs: HashMap.remove(current.jobs, job.command.requestId) })
        : current,
    );
  const phaseOf = (job: Job) =>
    Effect.map(Ref.get(state), (current) =>
      State.$is("open")(current)
        ? Option.map(HashMap.get(current.jobs, job.command.requestId), (entry) => entry.phase)
        : Option.none(),
    );
  const sizeOf = OwnerReply.match<Option.Option<number>>({
    ack: (reply) => Option.some(reply.size),
    removed: (reply) => Option.some(reply.size),
    "vector-hits": (reply) => Option.some(reply.size),
    "controlled-result": (reply) => Option.some(reply.size),
    "memory-result": () => Option.none(),
  });

  /** Holds the slot from dispatch until the worker answers, then settles the caller's wait. */
  const run = (job: Job) =>
    slot
      .withPermits(1)(
        setPhase(job.command.requestId, "active").pipe(
          Effect.andThen(
            Effect.suspend(() => {
              const controlled = (command: ControlledCommand) =>
                Option.match(job.control, {
                  onNone: () => Effect.fail(NativeOwnerFailed.make({ reason: "invalid-input" })),
                  onSome: (control) => transport.send({ ...command, controlToken: control.token }),
                });
              return OwnerCommand.match(job.command, {
                "vector-search-controlled": controlled,
                "memory-search": controlled,
                add: transport.send,
                remove: transport.send,
                reset: transport.send,
                save: transport.send,
                validate: transport.send,
                "vector-search": transport.send,
              });
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
      OwnerCommand.guards["memory-search"](command) &&
      nativeReadInputLogicalBytes(command.input) > command.input.inputBudgetBytes
    )
      return yield* NativeOwnerFailed.make({ reason: "input-budget" });
    const input = yield* Schema.decodeEffect(OwnerCommand)(command).pipe(
      Effect.mapError(() => NativeOwnerFailed.make({ reason: "invalid-input" })),
    );
    yield* Effect.when(
      Effect.fail(NativeOwnerFailed.make({ reason: "epoch-mismatch" })),
      Effect.succeed(input.epoch !== validated.epoch),
    );
    if (
      OwnerCommand.guards["memory-search"](input) &&
      nativeReadInputLogicalBytes(input.input) > input.input.inputBudgetBytes
    )
      return yield* NativeOwnerFailed.make({ reason: "input-budget" });
    const result = yield* Deferred.make<OwnerReply, NativeOwnerFailed>();
    // Owned copies: the transport transfers their buffers to the worker.
    const owned = OwnerCommand.match<OwnerCommand>(input, {
      add: (input) => ({
        ...input,
        vectors: new Float32Array(input.vectors),
        ids: [...input.ids],
      }),
      "vector-search-controlled": (input) => ({
        ...input,
        query: new Float32Array(input.query),
        allowedIds: [...input.allowedIds],
      }),
      "vector-search": (input) => ({
        ...input,
        query: new Float32Array(input.query),
        allowedIds: input.allowedIds === undefined ? undefined : [...input.allowedIds],
      }),
      "memory-search": (input) => ({
        ...input,
        input: {
          ...input.input,
          query: input.input.query === undefined ? undefined : new Float32Array(input.input.query),
          allowedProjects: [...input.input.allowedProjects],
          trigramTerms: [...input.input.trigramTerms],
          shortTerms: [...input.input.shortTerms],
          morphTerms: [...input.input.morphTerms],
        },
      }),
      validate: (input) => ({ ...input, ids: [...input.ids] }),
      remove: (input) => ({ ...input, ids: [...input.ids] }),
      reset: (input) => ({ ...input }),
      save: (input) => ({ ...input }),
    });
    const job: Job = { command: owned, result, control, phase: "queued" };
    return yield* Effect.scoped(
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          yield* Ref.modify(
            state,
            (current): readonly [Effect.Effect<void, NativeOwnerFailed>, State] =>
              State.$match(current, {
                failed: (current): readonly [Effect.Effect<void, NativeOwnerFailed>, State] => [
                  Effect.fail(current.error),
                  current,
                ],
                open: (current): readonly [Effect.Effect<void, NativeOwnerFailed>, State] => {
                  if (HashMap.has(current.jobs, input.requestId))
                    return [
                      Effect.fail(NativeOwnerFailed.make({ reason: "invalid-input" })),
                      current,
                    ];
                  if (HashMap.size(current.jobs) >= capacity)
                    return [Effect.fail(NativeOwnerFailed.make({ reason: "queue-full" })), current];
                  return [
                    Effect.void,
                    State.open({ jobs: HashMap.set(current.jobs, input.requestId, job) }),
                  ];
                },
              }),
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
                          Deferred.succeed(admission, ReadAdmission.completed({ reply })),
                        onFailure: (cause) => Deferred.failCause(admission, cause),
                      });
                      return;
                    }
                    if (yield* Effect.sync(() => observed.snapshotWasPinned())) {
                      yield* Deferred.succeed(admission, ReadAdmission.pinned());
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
                Effect.transposeOption(
                  Option.map(control, (requested) => Effect.sync(() => requested.cancel())),
                ),
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
    const controlled = (budget: number) =>
      requireRuntime("turbovec").pipe(
        Effect.mapError(() => NativeOwnerFailed.make({ reason: "invalid-input" })),
        Effect.flatMap((turbovec) =>
          Effect.try({
            try: () => {
              const binding = turbovec.loadTurbovec();
              if (!Predicate.isFunction(binding.SearchControl))
                throw NativeOwnerFailed.make({ reason: "native-incompatible" });
              // ABI capability inspection only; the method is never invoked without its receiver.
              if (
                admission !== undefined &&
                !Schema.is(SnapshotPinningControl)(binding.SearchControl.prototype)
              )
                throw NativeOwnerFailed.make({ reason: "native-incompatible" });
              const control = new binding.SearchControl(
                token,
                ownerKey,
                validated.epoch,
                command.requestId,
                budget,
              );
              return Option.some<RequestControl>({
                token: control.token(),
                snapshotWasPinned: () => control.snapshotWasPinned(),
                cancel: () => control.cancel(),
                close: () => control.close(),
              });
            },
            catch: (error) =>
              Schema.is(NativeOwnerFailed)(error)
                ? error
                : NativeOwnerFailed.make({ reason: "invalid-input" }),
          }),
        ),
      );
    return yield* Effect.acquireUseRelease(
      OwnerCommand.match<Effect.Effect<Option.Option<RequestControl>, NativeOwnerFailed>>(command, {
        "memory-search": (command) => controlled(command.input.remainingMs),
        "vector-search-controlled": (command) => controlled(command.budgetMs),
        add: () => Effect.succeedNone,
        remove: () => Effect.succeedNone,
        reset: () => Effect.succeedNone,
        save: () => Effect.succeedNone,
        validate: () => Effect.succeedNone,
        "vector-search": () => Effect.succeedNone,
      }),
      (control) => executeRegistered(command, control, admission),
      (control) =>
        Effect.transposeOption(Option.map(control, (opened) => Effect.sync(() => opened.close()))),
    );
  });
  const cancel = Effect.fn("NativeOwner.cancel")(function* (requestId: string) {
    const current = yield* Ref.get(state);
    if (State.$is("failed")(current)) return yield* current.error;
    const control = yield* Effect.fromOption(
      Option.flatMap(HashMap.get(current.jobs, requestId), (job) => job.control),
      () => NativeOwnerFailed.make({ reason: "invalid-input" }),
    );
    // Direct main-thread native atomic store, never a message to the blocked worker.
    yield* Effect.sync(() => control.cancel());
  });
  const startRead = Effect.fn("NativeOwner.startRead")(function* (
    command: (typeof OwnerCommand.cases)["memory-search"]["Type"],
  ) {
    const admission = yield* Deferred.make<ReadAdmission, NativeOwnerFailed>();
    const fiber = yield* Effect.forkScoped(
      execute(command, admission).pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit)
            ? Deferred.failCause(admission, exit.cause)
            : Deferred.succeed(admission, ReadAdmission.completed({ reply: exit.value })),
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
      Effect.map(
        State.$match({
          open: (current): OwnerInspection => {
            const phases = [...HashMap.values(current.jobs)].map((job) => job.phase);
            return OwnerInspection.open({
              queued: phases.filter((phase) => phase === "queued").length,
              active: phases.filter((phase) => phase === "active").length,
            });
          },
          failed: (current): OwnerInspection =>
            OwnerInspection.failed({ reason: current.error.reason }),
        }),
      ),
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
