import {
  Clock,
  Deferred,
  Duration,
  Effect,
  Equal,
  Exit,
  Fiber,
  FiberMap,
  HashMap,
  Layer,
  Match,
  Option,
  Predicate,
  PubSub,
  Ref,
  Result,
  Schedule,
  Schema,
  Scope,
  SynchronizedRef,
} from "effect";
import { Workflow } from "effect/workflow";
import type { Activity, DurableDeferred } from "effect/workflow";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import type { SqlClient } from "effect/sql";
import {
  OwnerWorkflowAdmission,
  OwnerWorkflowStorage,
  OwnerWorkflowStorageError,
  ownerWorkflowStorageLayer,
  type StoredExecution,
  StoredWorkflowResult,
} from "./owner-workflow-storage.ts";

/**
 * The engine's name for a workflow: the tag effect/workflow gives it, which the stored executions
 * and clocks record.
 */
export const workflowName = (workflow: Workflow.Any): string => workflow._tag;

/**
 * How often a caller waiting on a suspended execution replays it when no completion reached it:
 * after 1s, doubling up to every 5 minutes. It never ends, since an ended schedule kills the caller.
 */
export const suspendedRetrySchedule = Schedule.min([
  Schedule.exponential("1 second", 2),
  Schedule.spaced("5 minutes"),
]);

export class OwnerWorkflowEngineError extends Schema.TaggedError<
  OwnerWorkflowEngineError,
  { readonly brand: unique symbol }
>()("OwnerWorkflowEngineError", {
  operation: Schema.String,
  reason: Schema.Literals(["not_registered", "codec", "execution_conflict", "result_unencodable"]),
  cause: Schema.Defect(),
}) {}

/** A workflow body as effect/workflow registers it with the low-level engine. */
type EncodedWorkflowBody = Parameters<WorkflowEngine.Encoded["register"]>[1];

type RegisteredWorkflow = {
  readonly workflow: Workflow.Any;
  readonly execute: (
    ...input: Parameters<EncodedWorkflowBody>
  ) => Effect.Effect<
    Workflow.Result<unknown, unknown>,
    never,
    WorkflowEngine.WorkflowInstance | WorkflowEngine.WorkflowEngine
  >;
  readonly scope: Scope.Scope;
};

type Pass = Fiber.Fiber<Workflow.Result<unknown, unknown>>;

/** An execution with a pass in memory, until it completes or is interrupted. */
type LiveExecution = {
  readonly workflow: Workflow.Any;
  readonly payload: object;
  readonly parentExecutionId: string | undefined;
  /** The latest pass's instance; the library reads its interrupt mark while the pass runs. */
  readonly instance: WorkflowEngine.WorkflowInstance["Service"];
  readonly fiber: Pass;
};

/** A pass to join, and whether this call started it. */
type PassStart = { readonly fiber: Pass; readonly started: boolean };

/**
 * Whether an execution has ended. An interrupted one never runs again: a replay would wait on what
 * the interrupt cancelled, and the stored status would say it waits again.
 */
const hasEnded = (status: StoredExecution["status"]) =>
  status === "completed" || status === "interrupted";

type ExitSchemaOwner = {
  readonly successSchema: Schema.Top;
  readonly errorSchema: Schema.Top;
};
const jsonExit = (owner: ExitSchemaOwner) =>
  // Effect's type-erased Workflow.Any exposes Top schemas although every registered workflow
  // carries a concrete service-free codec at runtime; keep that unavoidable cast in this adapter.
  // SAFETY: registered workflows declare success and error schemas without decoding or encoding
  // services, so the derived JSON codec needs none either.
  Schema.toCodecJson(
    Schema.Exit(
      owner.successSchema as Schema.Codec<unknown, unknown>,
      owner.errorSchema as Schema.Codec<unknown, unknown>,
      Schema.Defect(),
    ),
  );

const engineFailure = (
  operation: string,
  reason: OwnerWorkflowEngineError["reason"],
  cause: unknown,
) => OwnerWorkflowEngineError.make({ operation, reason, cause });

const encodeExit = (owner: ExitSchemaOwner, exit: Exit.Exit<unknown, unknown>): Schema.Json =>
  Result.getOrThrowWith(Schema.encodeResult(jsonExit(owner))(exit), (failure) =>
    engineFailure("exit.encode", "codec", failure),
  );

const decodeExit = (owner: ExitSchemaOwner, encoded: Schema.Json): Exit.Exit<unknown, unknown> =>
  Result.getOrThrowWith(Schema.decodeResult(jsonExit(owner))(encoded), (failure) =>
    engineFailure("exit.decode", "codec", failure),
  );

// `makeUnsafe` owns the typed deferred codecs. The low-level engine only reconstructs the Exit/Cause
// shape after JSON persistence and must leave success/error payloads encoded for that outer codec.
const encodedExit = Schema.toCodecJson(
  Schema.Exit(Schema.Unknown, Schema.Unknown, Schema.Defect()),
);
const encodeEncodedExit = (exit: Exit.Exit<unknown, unknown>): Schema.Json =>
  Result.getOrThrowWith(Schema.encodeResult(encodedExit)(exit), (failure) =>
    engineFailure("deferred.exit.encode", "codec", failure),
  );
const decodeEncodedExit = (encoded: Schema.Json): Exit.Exit<unknown, unknown> =>
  Result.getOrThrowWith(Schema.decodeResult(encodedExit)(encoded), (failure) =>
    engineFailure("deferred.exit.decode", "codec", failure),
  );

/**
 * What a pass ended with, and what to store for it. A result the workflow's codec cannot encode
 * would fail the same way on every replay, so it completes the execution as that defect instead.
 */
const settledResult = (
  owner: ExitSchemaOwner,
  result: Workflow.Result<unknown, unknown>,
): readonly [Workflow.Result<unknown, unknown>, StoredWorkflowResult] =>
  Match.valueTags(result, {
    Suspended: () => [result, StoredWorkflowResult.cases.Suspended.make({})] as const,
    Complete: ({ exit }) =>
      Result.match(Schema.encodeResult(jsonExit(owner))(exit), {
        onSuccess: (encoded) =>
          [result, StoredWorkflowResult.cases.Complete.make({ exit: encoded })] as const,
        onFailure: (cause) => {
          const unencodable = Exit.die(
            engineFailure("execution.result", "result_unencodable", cause),
          );
          return [
            new Workflow.Complete({ exit: unencodable }),
            StoredWorkflowResult.cases.Complete.make({ exit: encodeExit(owner, unencodable) }),
          ] as const;
        },
      }),
  });

const decodeResult = (
  owner: ExitSchemaOwner,
  result: StoredWorkflowResult,
): Workflow.Result<unknown, unknown> =>
  Match.valueTags(result, {
    Suspended: () => Workflow.Suspended.make({}),
    Complete: ({ exit }) => new Workflow.Complete({ exit: decodeExit(owner, exit) }),
  });

/** What a caller of an ended execution gets: its stored result, or else the interruption. */
const endedResult = (
  owner: ExitSchemaOwner,
  execution: StoredExecution,
): Workflow.Result<unknown, unknown> =>
  execution.result !== undefined && Predicate.isTagged(execution.result, "Complete")
    ? decodeResult(owner, execution.result)
    : new Workflow.Complete({ exit: Exit.interrupt() });

/** A storage step the engine cannot recover from; encoding throws stay with their operation. */
const defect = <A, E>(operation: string, evaluate: () => Effect.Effect<A, E>): Effect.Effect<A> =>
  Effect.try({
    try: evaluate,
    catch: (cause) =>
      Schema.is(OwnerWorkflowStorageError)(cause) || Schema.is(OwnerWorkflowEngineError)(cause)
        ? cause
        : engineFailure(operation, "execution_conflict", cause),
  }).pipe(Effect.flatten, Effect.orDie);

const makeEngine = Effect.gen(function* () {
  const ownerScope = yield* Effect.scope;
  const storage = yield* OwnerWorkflowStorage;
  const workflows = yield* Ref.make(HashMap.empty<string, RegisteredWorkflow>());
  // Starting a pass and moving the interrupt mark to its instance happen under one lock, so an
  // interrupt cannot fall between them.
  const executions = yield* SynchronizedRef.make(HashMap.empty<string, LiveExecution>());
  // Ids of executions that completed or were interrupted, for the callers waiting on them.
  const endedExecutions = yield* PubSub.unbounded<string>();
  const runs = yield* FiberMap.make<string, Workflow.Result<unknown, unknown>>();
  const clocks = yield* FiberMap.make<string>();
  const deferredState = WorkflowEngine.makeDeferredState();

  // A run is given the engine it is part of, which is made after the steps that start runs.
  const engineMade = yield* Deferred.make<WorkflowEngine.WorkflowEngine["Service"]>();

  const registered = (workflowName: string): Effect.Effect<RegisteredWorkflow> =>
    Effect.map(Ref.get(workflows), HashMap.get(workflowName)).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.die(engineFailure("workflow.lookup", "not_registered", workflowName)),
          onSome: Effect.succeed,
        }),
      ),
    );

  // Numeric so the local OTLP collector keeps it: whether finished executions leave memory.
  const annotateSizes = Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan({
      executions: HashMap.size(yield* SynchronizedRef.get(executions)),
      runs: yield* FiberMap.size(runs),
      clocks: yield* FiberMap.size(clocks),
    });
  });

  const cancelClocks = Effect.fnUntraced(function* (executionId: string) {
    const cancelled = yield* defect("clock.cancel", () => storage.cancelClocks(executionId));
    yield* Effect.forEach(
      cancelled,
      (clockName) => FiberMap.remove(clocks, `${executionId}/${clockName}`),
      { discard: true },
    );
  });

  /** The stored result of an execution, once it has one. */
  const storedResult = (workflow: Workflow.Any, executionId: string) =>
    defect("execution.poll", () =>
      Effect.map(storage.execution(executionId), (execution) =>
        Option.flatMap(execution, (value) =>
          value.result === undefined
            ? Option.none()
            : Option.some(decodeResult(workflow, value.result)),
        ),
      ),
    );

  /** A completed execution leaves memory and wakes its waiting callers and its parent. */
  const completed = Effect.fnUntraced(function* (
    executionId: string,
    instance: WorkflowEngine.WorkflowInstance["Service"],
    parentExecutionId: string | undefined,
  ) {
    yield* cancelClocks(executionId);
    yield* SynchronizedRef.update(executions, (current) =>
      Option.exists(HashMap.get(current, executionId), (live) => live.instance === instance)
        ? HashMap.remove(current, executionId)
        : current,
    );
    yield* PubSub.publish(endedExecutions, executionId);
    // A waiting parent of a registered workflow is in memory: registration resumes every pending
    // execution. One that is not waits for its registration, which reads this stored result.
    const current = yield* SynchronizedRef.get(executions);
    const parent = Option.flatMap(Option.fromUndefinedOr(parentExecutionId), (id) =>
      HashMap.get(current, id),
    );
    yield* Effect.transposeOption(
      Option.map(parent, (live) =>
        Effect.forkIn(resumeExecution(live.workflow, live.instance.executionId), ownerScope),
      ),
    );
  });

  /** One pass over the execution's body; what it ended with is stored before the pass returns it. */
  const runPass = (
    workflow: Workflow.Any,
    entry: RegisteredWorkflow,
    executionId: string,
    execution: Pick<LiveExecution, "payload" | "parentExecutionId">,
    instance: WorkflowEngine.WorkflowInstance["Service"],
  ) =>
    defect("execution.running", () => storage.setRunning(executionId)).pipe(
      Effect.andThen(
        entry
          .execute(execution.payload, executionId)
          .pipe(
            Effect.provideServiceEffect(WorkflowEngine.WorkflowEngine, Deferred.await(engineMade)),
            (effect) => deferredState.trackRun(instance, effect),
          ),
      ),
      Effect.flatMap((result) =>
        defect("execution.result", () => {
          const [settled, stored] = settledResult(workflow, result);
          return Effect.as(storage.setResult(executionId, stored), settled);
        }),
      ),
      Effect.tap((result) =>
        Effect.when(
          completed(executionId, instance, execution.parentExecutionId),
          Effect.succeed(Predicate.isTagged(result, "Complete")),
        ),
      ),
    );

  /**
   * Starts a pass over the execution unless one is running, and answers it; none once the execution
   * ended. A running pass is awaited first and then replayed: a deferred may complete while it
   * still persists Suspended, and that wake would be lost without the replay.
   */
  const resumeExecution = Effect.fn("OwnerWorkflowEngine.resumeExecution")(function* (
    workflow: Workflow.Any,
    executionId: string,
  ): Effect.fn.Return<Option.Option<Pass>> {
    yield* annotateSizes;
    const stored = yield* defect("execution.read", () => storage.execution(executionId));
    if (Option.isNone(stored) || hasEnded(stored.value.status)) return Option.none();
    if (stored.value.workflowName !== workflowName(workflow))
      return yield* Effect.die(
        engineFailure("execution.lookup", "execution_conflict", executionId),
      );
    const entry = yield* registered(workflowName(workflow));
    const { fiber, started } = yield* SynchronizedRef.modifyEffect(
      executions,
      (current): Effect.Effect<readonly [PassStart, HashMap.HashMap<string, LiveExecution>]> => {
        const live = HashMap.get(current, executionId);
        if (Option.isSome(live) && live.value.fiber.pollUnsafe() === undefined)
          return Effect.succeed([{ fiber: live.value.fiber, started: false }, current] as const);
        const execution = Option.getOrElse(live, () => ({
          workflow,
          payload: stored.value.payload,
          parentExecutionId: stored.value.parentExecutionId,
        }));
        // Like the library's engines, a pass's scope is its own: intoResult closes it when the
        // execution completes, and one a suspended pass leaves open goes with its instance.
        const instance = WorkflowEngine.WorkflowInstance.initial(workflow, executionId);
        return Effect.map(
          FiberMap.run(
            runs,
            executionId,
            runPass(workflow, entry, executionId, execution, instance),
          ),
          (fiber) =>
            [
              { fiber, started: true },
              // By reference: replacing a value compares it with the old one, and a structural
              // comparison would walk the library's scopes and latches.
              HashMap.set(
                current,
                executionId,
                Equal.byReferenceUnsafe({ ...execution, instance, fiber }),
              ),
            ] as const,
        );
      },
    );
    if (started) return Option.some(fiber);
    yield* Fiber.await(fiber);
    return yield* resumeExecution(workflow, executionId);
  });

  const wakeExecution = Effect.fn("OwnerWorkflowEngine.wakeExecution")(function* (
    workflowName: string,
    executionId: string,
    deferredName: string,
  ): Effect.fn.Return<void> {
    yield* annotateSizes;
    yield* deferredState.deferredDone(executionId, deferredName);
    const entry = HashMap.get(yield* Ref.get(workflows), workflowName);
    yield* Effect.transposeOption(
      Option.map(entry, (registered) => resumeExecution(registered.workflow, executionId)),
    );
  });

  const interruptExecution = Effect.fn("OwnerWorkflowEngine.interruptExecution")(function* (
    operation: string,
    executionId: string,
  ) {
    yield* annotateSizes;
    yield* SynchronizedRef.update(executions, (current) => {
      const live = HashMap.get(current, executionId);
      // The library reads the mark from the instance of the pass that is running.
      if (Option.isSome(live)) live.value.instance.interrupted = true;
      return HashMap.remove(current, executionId);
    });
    yield* FiberMap.remove(runs, executionId);
    yield* defect(operation, () => storage.setInterrupted(executionId));
    yield* cancelClocks(executionId);
    yield* PubSub.publish(endedExecutions, executionId);
  });

  const armClock = Effect.fn("OwnerWorkflowEngine.armClock")(function* (clock: {
    readonly workflowName: string;
    readonly executionId: string;
    readonly clockName: string;
    readonly deferredName: string;
    readonly dueAt: number;
  }) {
    yield* annotateSizes;
    yield* Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* Effect.when(
        Effect.sleep(Duration.millis(clock.dueAt - now)),
        Effect.succeed(clock.dueAt > now),
      );
      yield* Effect.when(
        wakeExecution(clock.workflowName, clock.executionId, clock.deferredName),
        defect("clock.fire", () => storage.fireClock(clock.executionId, clock.clockName)),
      );
    }).pipe(
      FiberMap.run(clocks, `${clock.executionId}/${clock.clockName}`, {
        onlyIfMissing: true,
      }),
    );
  });

  const engine = WorkflowEngine.makeUnsafe({
    register: Effect.fnUntraced(function* <A, E>(
      workflow: Workflow.Any,
      execute: (
        ...input: Parameters<EncodedWorkflowBody>
      ) => Effect.Effect<A, E, WorkflowEngine.WorkflowInstance | WorkflowEngine.WorkflowEngine>,
    ) {
      const scope = yield* Effect.scope;
      // Capture the typed failure as a workflow result before storing heterogeneous registrations.
      // intoResult still owns suspension, interruption and compensation semantics.
      const entry: RegisteredWorkflow = {
        workflow,
        execute: (payload, executionId) => Workflow.intoResult(execute(payload, executionId)),
        scope,
      };
      const name = workflowName(workflow);
      yield* Ref.update(workflows, HashMap.set(name, entry));
      // A later registration of the same name keeps its entry.
      yield* Effect.addFinalizer(() =>
        Ref.update(workflows, (current) =>
          Option.exists(HashMap.get(current, name), (registered) => registered === entry)
            ? HashMap.remove(current, name)
            : current,
        ),
      );
      const pending = yield* defect("execution.pending", () => storage.pendingExecutions(name));
      yield* Effect.forEach(
        pending,
        (execution) => resumeExecution(workflow, execution.executionId),
        { discard: true },
      );
    }),
    execute: <const Discard extends boolean>(
      workflow: Workflow.Any,
      options: {
        readonly executionId: string;
        readonly payload: object;
        readonly discard: Discard;
        readonly parent?: WorkflowEngine.WorkflowInstance["Service"] | undefined;
      },
    ): Effect.Effect<Discard extends true ? void : Workflow.Result<unknown, unknown>> =>
      Effect.gen(function* () {
        const admitted = yield* defect("execution.admit", () =>
          storage.admit({
            workflowName: workflowName(workflow),
            executionId: options.executionId,
            payload: options.payload,
            parentExecutionId: options.parent?.executionId,
          }),
        );
        if (hasEnded(admitted.status))
          return options.discard ? undefined : endedResult(workflow, admitted);
        const pass = yield* resumeExecution(workflow, options.executionId);
        if (options.discard) return undefined;
        if (Option.isSome(pass)) return yield* Fiber.join(pass.value);
        // It ended between admission and the pass.
        return yield* Effect.flatMap(
          defect("execution.read", () => storage.execution(options.executionId)),
          Option.match({
            onNone: () =>
              Effect.die(
                engineFailure("execution.await", "execution_conflict", options.executionId),
              ),
            onSome: (execution) => Effect.succeed(endedResult(workflow, execution)),
          }),
        );
      }).pipe(
        // SAFETY: every branch above answers undefined exactly when `discard` is true, as the
        // conditional result type states; TypeScript cannot narrow that type through the generic.
        Effect.map(
          (result) => result as Discard extends true ? void : Workflow.Result<unknown, unknown>,
        ),
      ),
    poll: storedResult,
    interrupt: (_workflow, executionId) => interruptExecution("execution.interrupt", executionId),
    interruptUnsafe: (_workflow, executionId) =>
      interruptExecution("execution.interruptUnsafe", executionId),
    resume: (workflow, executionId) => Effect.asVoid(resumeExecution(workflow, executionId)),
    // A caller waiting on a suspended execution returns once it completes or is interrupted; its
    // retry schedule stays the fallback. Subscribing before reading the status keeps an ending
    // that falls between the two, and waiting through every other status keeps the caller from
    // replaying without a pause.
    awaitComplete: (_workflow, executionId) =>
      Effect.scoped(
        Effect.gen(function* () {
          const endings = yield* PubSub.subscribe(endedExecutions);
          const stored = yield* storage.execution(executionId);
          if (Option.exists(stored, ({ status }) => hasEnded(status))) return;
          yield* PubSub.take(endings).pipe(Effect.repeat({ until: (id) => id === executionId }));
        }),
      ).pipe(Effect.catchCause(() => Effect.never)),
    activityExecute: Effect.fnUntraced(function* <A, E, R>(
      activity: Pick<Activity.Any, "name"> & { readonly executeEncoded: Effect.Effect<A, E, R> },
      attempt: number,
    ) {
      const instance = yield* WorkflowEngine.WorkflowInstance;
      const previous = yield* defect("activity.read", () =>
        storage.activityResult(instance.executionId, activity.name, attempt),
      );
      if (Option.isSome(previous) && Predicate.isTagged(previous.value, "Complete"))
        return new Workflow.Complete({ exit: decodeEncodedExit(previous.value.exit) });

      // As with a pass, intoResult closes the activity's own scope when the activity completes.
      const activityInstance = WorkflowEngine.WorkflowInstance.initial(
        instance.workflow,
        instance.executionId,
      );
      activityInstance.interrupted = instance.interrupted;
      const result = yield* Workflow.intoResult(activity.executeEncoded).pipe(
        Effect.provideService(WorkflowEngine.WorkflowInstance, activityInstance),
      );
      if (Predicate.isTagged(result, "Complete")) {
        yield* defect("activity.result", () =>
          storage.setActivityResult(
            instance.executionId,
            activity.name,
            attempt,
            // executeEncoded already applies the Activity's concrete success/error codecs.
            // Persist its Exit shape; makeUnsafe performs the single typed decode on return/replay.
            StoredWorkflowResult.cases.Complete.make({ exit: encodeEncodedExit(result.exit) }),
          ),
        );
      }
      return result;
    }),
    deferredResult: Effect.fnUntraced(function* (deferred: DurableDeferred.Any) {
      const instance = yield* WorkflowEngine.WorkflowInstance;
      const result = yield* defect("deferred.read", () =>
        storage.deferredResult(instance.executionId, deferred.name),
      );
      return Option.map(result, decodeEncodedExit);
    }),
    // `makeUnsafe` has already encoded the typed deferred payloads. Persist the surrounding
    // Exit/Cause through a generic JSON codec, then reconstruct that low-level shape on replay
    // before the public engine reapplies the deferred's typed schema.
    deferredDone: (options) =>
      Effect.gen(function* () {
        const wake = wakeExecution(options.workflowName, options.executionId, options.deferredName);
        const current = yield* Effect.serviceOption(WorkflowEngine.WorkflowInstance);
        // The execution completing its own deferred cannot wait for its own replay.
        const inside = Option.isSome(current) && current.value.executionId === options.executionId;
        yield* Effect.when(
          inside ? Effect.asVoid(Effect.forkIn(wake, ownerScope)) : wake,
          defect("deferred.complete", () =>
            storage.setDeferredResult(
              options.workflowName,
              options.executionId,
              options.deferredName,
              encodeEncodedExit(options.exit),
            ),
          ),
        );
      }),
    scheduleClock: (workflow, options) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const dueAt = yield* defect("clock.schedule", () =>
          storage.scheduleClock({
            workflowName: workflowName(workflow),
            executionId: options.executionId,
            clockName: options.clock.name,
            deferredName: options.clock.deferred.name,
            dueAt: now + Duration.toMillis(options.clock.duration),
          }),
        );
        yield* armClock({
          workflowName: workflowName(workflow),
          executionId: options.executionId,
          clockName: options.clock.name,
          deferredName: options.clock.deferred.name,
          dueAt,
        });
      }),
  });
  yield* Deferred.succeed(engineMade, engine);

  yield* Effect.forEach(yield* defect("clock.pending", () => storage.pendingClocks), armClock, {
    discard: true,
  });

  return engine;
});

const engineLayer = Layer.effect(WorkflowEngine.WorkflowEngine, makeEngine);

const admissionServiceLayer = Layer.effect(
  OwnerWorkflowAdmission,
  Effect.gen(function* () {
    const storage = yield* OwnerWorkflowStorage;
    return OwnerWorkflowAdmission.of({
      admit: (request, bind) => storage.admitWith(request, bind),
    });
  }),
);

/**
 * One scoped graph for the project-owned engine, owner admission and its shared storage adapter.
 * The app's SqlClient remains the only connection/writer owner and is supplied by the root.
 */
export const ownerWorkflowEngineLayer = Layer.merge(engineLayer, admissionServiceLayer).pipe(
  Layer.provideMerge(ownerWorkflowStorageLayer),
);

/** Project-owned durable Effect WorkflowEngine backed by the shared SqlClient connection. */
export const layer: Layer.Layer<WorkflowEngine.WorkflowEngine, never, SqlClient.SqlClient> =
  engineLayer.pipe(Layer.provide(ownerWorkflowStorageLayer));

/** Atomic owner admission; bind and the first durable workflow request share one transaction. */
export const admissionLayer: Layer.Layer<OwnerWorkflowAdmission, never, SqlClient.SqlClient> =
  admissionServiceLayer.pipe(Layer.provide(ownerWorkflowStorageLayer));
