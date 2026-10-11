import {
  Clock,
  Duration,
  Effect,
  Exit,
  Fiber,
  FiberMap,
  Layer,
  Option,
  Schema,
  Scope,
} from "effect";
/* Effect's low-level encoded workflow contract necessarily crosses object and unknown boundaries. */
/* oxlint-disable anti-slop/no-object-parameters, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/require-safety-comment-for-type-assertion */
import { Workflow } from "effect/workflow";
import type { Activity, DurableDeferred } from "effect/workflow";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import { Database } from "../db/database.ts";
import {
  OwnerWorkflowAdmission,
  OwnerWorkflowStorage,
  OwnerWorkflowStorageError,
  ownerWorkflowStorageLayer,
  type StoredWorkflowResult,
} from "./owner-workflow-storage.ts";

export class OwnerWorkflowEngineError extends Schema.TaggedError<OwnerWorkflowEngineError>()(
  "OwnerWorkflowEngineError",
  {
    operation: Schema.String,
    reason: Schema.Literals(["not_registered", "codec", "execution_conflict"]),
    cause: Schema.Defect(),
  },
) {}

type RegisteredWorkflow = {
  readonly workflow: Workflow.Any;
  readonly execute: (
    payload: object,
    executionId: string,
  ) => Effect.Effect<
    unknown,
    unknown,
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
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions
  Schema.toCodecJson(
    Schema.Exit(owner.successSchema, owner.errorSchema, Schema.Defect()),
  ) as unknown as Schema.Codec<Exit.Exit<unknown, unknown>, unknown>;

const engineFailure = (
  operation: string,
  reason: OwnerWorkflowEngineError["reason"],
  cause: unknown,
) => OwnerWorkflowEngineError.make({ operation, reason, cause });

const encodeExit = (owner: ExitSchemaOwner, exit: Exit.Exit<unknown, unknown>): unknown => {
  const result = Schema.encodeUnknownResult(jsonExit(owner))(exit);
  if (result._tag === "Failure") throw engineFailure("exit.encode", "codec", result.failure);
  return result.success;
};

const decodeExit = (owner: ExitSchemaOwner, encoded: unknown): Exit.Exit<unknown, unknown> => {
  const result = Schema.decodeUnknownResult(jsonExit(owner))(encoded);
  if (result._tag === "Failure") throw engineFailure("exit.decode", "codec", result.failure);
  return result.success as Exit.Exit<unknown, unknown>;
};

// `makeUnsafe` owns the typed deferred codecs. The low-level engine only reconstructs the Exit/Cause
// shape after JSON persistence and must leave success/error payloads encoded for that outer codec.
const encodedExit = Schema.toCodecJson(
  Schema.Exit(Schema.Unknown, Schema.Unknown, Schema.Defect()),
);
const encodeEncodedExit = (exit: Exit.Exit<unknown, unknown>): unknown => {
  const result = Schema.encodeUnknownResult(encodedExit)(exit);
  if (result._tag === "Failure")
    throw engineFailure("deferred.exit.encode", "codec", result.failure);
  return result.success;
};
const decodeEncodedExit = (encoded: unknown): Exit.Exit<unknown, unknown> => {
  const result = Schema.decodeUnknownResult(encodedExit)(encoded);
  if (result._tag === "Failure")
    throw engineFailure("deferred.exit.decode", "codec", result.failure);
  return result.success;
};

const encodeResult = (
  owner: ExitSchemaOwner,
  result: Workflow.Result<unknown, unknown>,
): StoredWorkflowResult => {
  switch (result._tag) {
    case "Suspended":
      return { _tag: "Suspended" };
    case "Complete":
      return { _tag: "Complete", exit: encodeExit(owner, result.exit) };
  }
};

const decodeResult = (
  owner: ExitSchemaOwner,
  result: StoredWorkflowResult,
): Workflow.Result<unknown, unknown> => {
  switch (result._tag) {
    case "Suspended":
      return Workflow.Suspended.make({});
    case "Complete":
      return new Workflow.Complete({ exit: decodeExit(owner, result.exit) });
  }
};

const defect = <A>(operation: string, evaluate: () => A): Effect.Effect<A> =>
  Effect.try({
    try: evaluate,
    catch: (cause) =>
      Schema.is(OwnerWorkflowStorageError)(cause) || Schema.is(OwnerWorkflowEngineError)(cause)
        ? cause
        : engineFailure(operation, "execution_conflict", cause),
  }).pipe(Effect.orDie);

const makeEngine = Effect.gen(function* () {
  const ownerScope = yield* Effect.scope;
  const storage = yield* OwnerWorkflowStorage;
  const workflows = new Map<string, RegisteredWorkflow>();
  const executions = new Map<string, LiveExecution>();
  const runs = yield* FiberMap.make<string, Workflow.Result<unknown, unknown>>();
  const clocks = yield* FiberMap.make<string>();
  const deferredState = WorkflowEngine.makeDeferredState();

  let engine: WorkflowEngine.WorkflowEngine["Service"];

  const registered = (workflowName: string): Effect.Effect<RegisteredWorkflow> =>
    Effect.suspend(() => {
      const entry = workflows.get(workflowName);
      return entry === undefined
        ? Effect.die(engineFailure("workflow.lookup", "not_registered", workflowName))
        : Effect.succeed(entry);
    });

  const liveExecution = Effect.fnUntraced(function* (
    workflow: Workflow.Any,
    executionId: string,
  ): Effect.fn.Return<LiveExecution> {
    const current = executions.get(executionId);
    if (current !== undefined) {
      if (current.workflow._tag !== workflow._tag)
        return yield* Effect.die(
          engineFailure("execution.lookup", "execution_conflict", executionId),
        );
      return current;
    }
    const stored = yield* defect("execution.read", () => storage.execution(executionId));
    if (Option.isNone(stored))
      return yield* Effect.die(
        engineFailure("execution.lookup", "execution_conflict", executionId),
      );
    if (stored.value.workflowName !== workflow._tag)
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
    const entry = yield* registered(workflow._tag);
    const state = yield* liveExecution(workflow, executionId);
    const running = state.fiber;
    const existing = running?.pollUnsafe();
    if (existing === undefined && running !== undefined) {
      // A deferred may complete while the first pass is still persisting Suspended. Wait for that
      // pass before installing the replay; otherwise the wake is lost and the execution strands.
      yield* Fiber.await(running);
      return yield* resumeExecution(workflow, executionId);
    }
    if (existing !== undefined && running !== undefined) yield* FiberMap.remove(runs, executionId);

    const scope = yield* Scope.fork(ownerScope);
    const instance = WorkflowEngine.WorkflowInstance.initial(workflow, executionId, scope);
    instance.interrupted = state.interrupted;
    state.scope = scope;
    state.instance = instance;
    yield* defect("execution.running", () => storage.setRunning(executionId));

    const run = Workflow.intoResult(entry.execute(state.payload, executionId)).pipe(
      Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
      (effect) => deferredState.trackRun(instance, effect),
      Effect.tap((result) =>
        Effect.gen(function* () {
          yield* defect("execution.result", () =>
            storage.setResult(executionId, encodeResult(workflow, result)),
          );
          if (result._tag !== "Complete") return;
          const cancelled = yield* defect("clock.cancel", () => storage.cancelClocks(executionId));
          yield* Effect.forEach(
            cancelled,
            (clockName) => FiberMap.remove(clocks, `${executionId}/${clockName}`),
            { discard: true },
          );
        }),
      ),
      Effect.tap((result) => {
        if (state.parentExecutionId === undefined || result._tag !== "Complete") return Effect.void;
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
    const entry = workflows.get(workflowName);
    if (entry !== undefined) yield* resumeExecution(entry.workflow, executionId);
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
      if (clock.dueAt > now) yield* Effect.sleep(Duration.millis(clock.dueAt - now));
      const fired = yield* defect("clock.fire", () =>
        storage.fireClock(clock.executionId, clock.clockName),
      );
      if (fired) yield* wakeExecution(clock.workflowName, clock.executionId, clock.deferredName);
    }).pipe(
      FiberMap.run(clocks, `${clock.executionId}/${clock.clockName}`, {
        onlyIfMissing: true,
      }),
      Effect.asVoid,
    );

  engine = WorkflowEngine.makeUnsafe({
    register: Effect.fnUntraced(function* (workflow, execute) {
      const scope = yield* Effect.scope;
      const entry: RegisteredWorkflow = { workflow, execute, scope };
      workflows.set(workflow._tag, entry);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (workflows.get(workflow._tag) === entry) workflows.delete(workflow._tag);
        }),
      );
      const pending = yield* defect("execution.pending", () =>
        storage.pendingExecutions(workflow._tag),
      );
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
            workflowName: workflow._tag,
            executionId: options.executionId,
            payload: options.payload,
            parentExecutionId: options.parent?.executionId,
          }),
        );
        if (admitted.result?._tag === "Complete") {
          return (
            options.discard ? undefined : decodeResult(workflow, admitted.result)
          ) as Discard extends true ? void : Workflow.Result<unknown, unknown>;
        }
        yield* resumeExecution(workflow, options.executionId);
        if (options.discard)
          return undefined as Discard extends true ? void : Workflow.Result<unknown, unknown>;
        const state = yield* liveExecution(workflow, options.executionId);
        const fiber = state.fiber;
        if (fiber === undefined)
          return yield* Effect.die(
            engineFailure("execution.await", "execution_conflict", options.executionId),
          );
        return (yield* Fiber.join(fiber)) as Discard extends true
          ? void
          : Workflow.Result<unknown, unknown>;
      }),
    poll: (_workflow, executionId) =>
      defect("execution.poll", () => {
        const execution = storage.execution(executionId);
        return Option.flatMap(execution, (value) =>
          value.result === undefined
            ? Option.none()
            : Option.some(decodeResult(_workflow, value.result)),
        );
      }),
    interrupt: Effect.fnUntraced(function* (_workflow, executionId) {
      const state = executions.get(executionId);
      if (state !== undefined) {
        state.interrupted = true;
        state.instance.interrupted = true;
      }
      yield* FiberMap.remove(runs, executionId);
      yield* defect("execution.interrupt", () => storage.setInterrupted(executionId));
      const cancelled = yield* defect("clock.cancel", () => storage.cancelClocks(executionId));
      yield* Effect.forEach(
        cancelled,
        (clockName) => FiberMap.remove(clocks, `${executionId}/${clockName}`),
        { discard: true },
      );
    }),
    interruptUnsafe: Effect.fnUntraced(function* (_workflow, executionId) {
      const state = executions.get(executionId);
      if (state !== undefined) {
        state.interrupted = true;
        state.instance.interrupted = true;
      }
      yield* FiberMap.remove(runs, executionId);
      yield* defect("execution.interruptUnsafe", () => storage.setInterrupted(executionId));
      const cancelled = yield* defect("clock.cancel", () => storage.cancelClocks(executionId));
      yield* Effect.forEach(
        cancelled,
        (clockName) => FiberMap.remove(clocks, `${executionId}/${clockName}`),
        { discard: true },
      );
    }),
    resume: (workflow, executionId) => resumeExecution(workflow, executionId),
    activityExecute: Effect.fnUntraced(function* (activity: Activity.Any, attempt) {
      const instance = yield* WorkflowEngine.WorkflowInstance;
      const previous = yield* defect("activity.read", () =>
        storage.activityResult(instance.executionId, activity.name, attempt),
      );
      if (Option.isSome(previous) && previous.value._tag === "Complete")
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
      if (result._tag === "Complete") {
        yield* defect("activity.result", () =>
          storage.setActivityResult(
            instance.executionId,
            activity.name,
            attempt,
            // executeEncoded already applies the Activity's concrete success/error codecs.
            // Persist its Exit shape; makeUnsafe performs the single typed decode on return/replay.
            { _tag: "Complete", exit: encodeEncodedExit(result.exit) },
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
        const inserted = yield* defect("deferred.complete", () =>
          storage.setDeferredResult(
            options.workflowName,
            options.executionId,
            options.deferredName,
            encodeEncodedExit(options.exit),
          ),
        );
        if (!inserted) return;
        const wake = wakeExecution(options.workflowName, options.executionId, options.deferredName);
        const current = yield* Effect.serviceOption(WorkflowEngine.WorkflowInstance);
        if (Option.isSome(current) && current.value.executionId === options.executionId) {
          yield* wake.pipe(Effect.forkIn(ownerScope));
        } else {
          yield* wake;
        }
      }),
    scheduleClock: (workflow, options) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const dueAt = yield* defect("clock.schedule", () =>
          storage.scheduleClock({
            workflowName: workflow._tag,
            executionId: options.executionId,
            clockName: options.clock.name,
            deferredName: options.clock.deferred.name,
            dueAt: now + Duration.toMillis(options.clock.duration),
          }),
        );
        yield* armClock({
          workflowName: workflow._tag,
          executionId: options.executionId,
          clockName: options.clock.name,
          deferredName: options.clock.deferred.name,
          dueAt,
        });
      }),
  });

  yield* Effect.forEach(yield* defect("clock.pending", () => storage.pendingClocks()), armClock, {
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
      admit: (request, bind) =>
        Effect.try({
          try: () => storage.admitWith(request, bind),
          catch: (cause) =>
            Schema.is(OwnerWorkflowStorageError)(cause)
              ? cause
              : OwnerWorkflowStorageError.make({
                  operation: "execution.admitWith",
                  reason: "database",
                  cause,
                }),
        }),
    });
  }),
);

/**
 * One scoped graph for the project-owned engine, owner admission and its shared storage adapter.
 * Database remains the only connection/writer owner and is supplied by the application root.
 */
export const ownerWorkflowEngineLayer = Layer.merge(engineLayer, admissionServiceLayer).pipe(
  Layer.provideMerge(ownerWorkflowStorageLayer),
);

/** Project-owned durable Effect WorkflowEngine backed by the shared Database connection. */
export const layer: Layer.Layer<WorkflowEngine.WorkflowEngine, never, Database> = engineLayer.pipe(
  Layer.provide(ownerWorkflowStorageLayer),
);

/** Atomic owner admission; bind and the first durable workflow request share Database.atomic. */
export const admissionLayer: Layer.Layer<OwnerWorkflowAdmission, never, Database> =
  admissionServiceLayer.pipe(Layer.provide(ownerWorkflowStorageLayer));
