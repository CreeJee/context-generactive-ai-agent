import {
  Clock,
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
  Result,
  Schema,
  Scope,
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
  StoredWorkflowResult,
} from "./owner-workflow-storage.ts";

/**
 * The engine's name for a workflow: the tag effect/workflow gives it, which the stored executions
 * and clocks record.
 */
export const workflowName = (workflow: Workflow.Any): string => workflow._tag;

export class OwnerWorkflowEngineError extends Schema.TaggedError<OwnerWorkflowEngineError>()(
  "OwnerWorkflowEngineError",
  {
    operation: Schema.String,
    reason: Schema.Literals(["not_registered", "codec", "execution_conflict"]),
    cause: Schema.Defect(),
  },
) {}

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

type LiveExecution = {
  readonly workflow: Workflow.Any;
  readonly payload: object;
  readonly parentExecutionId: string | undefined;
  scope: Scope.Closeable;
  instance: WorkflowEngine.WorkflowInstance["Service"];
  interrupted: boolean;
  fiber: Fiber.Fiber<Workflow.Result<unknown, unknown>> | undefined;
};

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

const encodeResult = (
  owner: ExitSchemaOwner,
  result: Workflow.Result<unknown, unknown>,
): StoredWorkflowResult =>
  Match.valueTags(result, {
    Suspended: (): StoredWorkflowResult => StoredWorkflowResult.cases.Suspended.make({}),
    Complete: ({ exit }): StoredWorkflowResult =>
      StoredWorkflowResult.cases.Complete.make({ exit: encodeExit(owner, exit) }),
  });

const decodeResult = (
  owner: ExitSchemaOwner,
  result: StoredWorkflowResult,
): Workflow.Result<unknown, unknown> =>
  Match.valueTags(result, {
    Suspended: () => Workflow.Suspended.make({}),
    Complete: ({ exit }) => new Workflow.Complete({ exit: decodeExit(owner, exit) }),
  });

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
  const executions = new Map<string, LiveExecution>();
  const runs = yield* FiberMap.make<string, Workflow.Result<unknown, unknown>>();
  const clocks = yield* FiberMap.make<string>();
  const deferredState = WorkflowEngine.makeDeferredState();

  let engine: WorkflowEngine.WorkflowEngine["Service"];

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

  const cancelClocks = Effect.fnUntraced(function* (executionId: string) {
    const cancelled = yield* defect("clock.cancel", () => storage.cancelClocks(executionId));
    yield* Effect.forEach(
      cancelled,
      (clockName) => FiberMap.remove(clocks, `${executionId}/${clockName}`),
      { discard: true },
    );
  });

  const liveExecution = Effect.fnUntraced(function* (
    workflow: Workflow.Any,
    executionId: string,
  ): Effect.fn.Return<LiveExecution> {
    const current = executions.get(executionId);
    if (current !== undefined) {
      if (!Predicate.isTagged(current.workflow, workflowName(workflow)))
        return yield* Effect.die(
          engineFailure("execution.lookup", "execution_conflict", executionId),
        );
      return current;
    }
    const stored = yield* defect("execution.read", () => storage.execution(executionId));
    if (Option.isNone(stored) || stored.value.workflowName !== workflowName(workflow))
      return yield* Effect.die(
        engineFailure("execution.lookup", "execution_conflict", executionId),
      );
    const scope = yield* Scope.fork(ownerScope);
    const instance = WorkflowEngine.WorkflowInstance.initial(workflow, executionId, scope);
    const state: LiveExecution = {
      workflow,
      payload: stored.value.payload,
      parentExecutionId: stored.value.parentExecutionId,
      scope,
      instance,
      interrupted: stored.value.status === "interrupted",
      fiber: undefined,
    };
    executions.set(executionId, state);
    return state;
  });

  const resumeExecution = Effect.fnUntraced(function* (
    workflow: Workflow.Any,
    executionId: string,
  ): Effect.fn.Return<void> {
    const stored = yield* defect("execution.read", () => storage.execution(executionId));
    if (Option.isNone(stored) || stored.value.status === "completed") return;
    const entry = yield* registered(workflowName(workflow));
    const state = yield* liveExecution(workflow, executionId);
    const running = state.fiber;
    const existing = running?.pollUnsafe();
    if (existing === undefined && running !== undefined) {
      // A deferred may complete while the first pass is still persisting Suspended. Wait for that
      // pass before installing the replay; otherwise the wake is lost and the execution strands.
      yield* Fiber.await(running);
      return yield* resumeExecution(workflow, executionId);
    }
    // A fiber still remembered here has already finished; drop it before the replay.
    yield* Effect.when(FiberMap.remove(runs, executionId), Effect.succeed(running !== undefined));

    const scope = yield* Scope.fork(ownerScope);
    const instance = WorkflowEngine.WorkflowInstance.initial(workflow, executionId, scope);
    instance.interrupted = state.interrupted;
    state.scope = scope;
    state.instance = instance;
    yield* defect("execution.running", () => storage.setRunning(executionId));

    const run = entry.execute(state.payload, executionId).pipe(
      Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
      (effect) => deferredState.trackRun(instance, effect),
      Effect.tap((result) =>
        Effect.andThen(
          defect("execution.result", () =>
            storage.setResult(executionId, encodeResult(workflow, result)),
          ),
          Effect.when(
            cancelClocks(executionId),
            Effect.succeed(Predicate.isTagged(result, "Complete")),
          ),
        ),
      ),
      Effect.tap((result) => {
        if (state.parentExecutionId === undefined || !Predicate.isTagged(result, "Complete"))
          return Effect.void;
        const parent = executions.get(state.parentExecutionId);
        return parent === undefined
          ? Effect.void
          : resumeExecution(parent.workflow, parent.instance.executionId).pipe(
              Effect.forkIn(ownerScope),
              Effect.asVoid,
            );
      }),
    );
    state.fiber = yield* FiberMap.run(runs, executionId, run, { onlyIfMissing: true });
  });

  const wakeExecution = Effect.fnUntraced(function* (
    workflowName: string,
    executionId: string,
    deferredName: string,
  ): Effect.fn.Return<void> {
    yield* deferredState.deferredDone(executionId, deferredName);
    const entry = HashMap.get(yield* Ref.get(workflows), workflowName);
    yield* Effect.transposeOption(
      Option.map(entry, (registered) => resumeExecution(registered.workflow, executionId)),
    );
  });

  const interruptExecution = Effect.fnUntraced(function* (operation: string, executionId: string) {
    const state = executions.get(executionId);
    if (state !== undefined) {
      state.interrupted = true;
      state.instance.interrupted = true;
    }
    yield* FiberMap.remove(runs, executionId);
    yield* defect(operation, () => storage.setInterrupted(executionId));
    yield* cancelClocks(executionId);
  });

  const armClock = (clock: {
    readonly workflowName: string;
    readonly executionId: string;
    readonly clockName: string;
    readonly deferredName: string;
    readonly dueAt: number;
  }) =>
    Effect.gen(function* () {
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
      Effect.asVoid,
    );

  engine = WorkflowEngine.makeUnsafe({
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
        if (Predicate.isTagged(admitted.result, "Complete")) {
          return options.discard ? undefined : decodeResult(workflow, admitted.result);
        }
        yield* resumeExecution(workflow, options.executionId);
        if (options.discard) return undefined;
        const state = yield* liveExecution(workflow, options.executionId);
        const fiber = state.fiber;
        if (fiber === undefined)
          return yield* Effect.die(
            engineFailure("execution.await", "execution_conflict", options.executionId),
          );
        return yield* Fiber.join(fiber);
      }).pipe(
        // SAFETY: every branch above answers undefined exactly when `discard` is true, as the
        // conditional result type states; TypeScript cannot narrow that type through the generic.
        Effect.map(
          (result) => result as Discard extends true ? void : Workflow.Result<unknown, unknown>,
        ),
      ),
    poll: (_workflow, executionId) =>
      defect("execution.poll", () =>
        Effect.map(storage.execution(executionId), (execution) =>
          Option.flatMap(execution, (value) =>
            value.result === undefined
              ? Option.none()
              : Option.some(decodeResult(_workflow, value.result)),
          ),
        ),
      ),
    interrupt: (_workflow, executionId) => interruptExecution("execution.interrupt", executionId),
    interruptUnsafe: (_workflow, executionId) =>
      interruptExecution("execution.interruptUnsafe", executionId),
    resume: (workflow, executionId) => resumeExecution(workflow, executionId),
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

      const activityScope = yield* Scope.fork(ownerScope);
      const activityInstance = WorkflowEngine.WorkflowInstance.initial(
        instance.workflow,
        instance.executionId,
        activityScope,
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
