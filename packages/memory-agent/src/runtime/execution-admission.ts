import {
  Config,
  Context,
  Data,
  Duration,
  Effect,
  Layer,
  Metric,
  Ref,
  Schedule,
  Schema,
  Semaphore,
} from "effect";

export const ExecutionAdmissionKind = Schema.Literals(["workflow", "model", "tool"]);
export type ExecutionAdmissionKind = typeof ExecutionAdmissionKind.Type;

const GateLimits = Schema.Struct({
  active: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_024 })),
  queued: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 16_384 })),
});
export type GateLimits = typeof GateLimits.Type;

export const ExecutionAdmissionLimits = Schema.Struct({
  workflow: GateLimits,
  model: GateLimits,
  tool: GateLimits,
});
export type ExecutionAdmissionLimits = typeof ExecutionAdmissionLimits.Type;

export const defaultExecutionAdmissionLimits: ExecutionAdmissionLimits = {
  workflow: { active: 32, queued: 64 },
  model: { active: 8, queued: 16 },
  tool: { active: 16, queued: 64 },
};

export class ExecutionSaturated extends Schema.TaggedError<ExecutionSaturated>()(
  "ExecutionSaturated",
  {
    kind: ExecutionAdmissionKind,
    active: Schema.Int,
    queued: Schema.Int,
    capacity: Schema.Int,
  },
) {}

export interface ExecutionAdmissionSnapshot {
  readonly active: number;
  readonly queued: number;
  readonly activeLimit: number;
  readonly queueCapacity: number;
}

interface Gate {
  readonly limits: GateLimits;
  readonly activePermits: Semaphore.Semaphore;
  readonly admittedPermits: Semaphore.Semaphore;
  readonly active: Ref.Ref<number>;
  readonly queued: Ref.Ref<number>;
}

const activeGauge = Metric.gauge("context_agent_execution_active", {
  description: "Current process-local execution operations holding an active permit",
});
const queuedGauge = Metric.gauge("context_agent_execution_queued", {
  description: "Current process-local execution operations waiting behind an active permit",
});
const saturatedCounter = Metric.counter("context_agent_execution_saturated_total", {
  description: "Execution operations rejected because both active and queued capacity were full",
  incremental: true,
});

/**
 * How a saturated caller tries again: soon at first, then every two seconds at most, jittered so
 * waiters do not retry in step.
 */
const saturatedRetry = Schedule.min([
  Schedule.exponential("50 millis"),
  Schedule.spaced("2 seconds"),
]).pipe(Schedule.jittered);

/**
 * A wait for capacity. Work already running waits as long as it lives (`forever`); a request
 * starting new work gives up after `upTo` so its caller hears it is busy.
 */
export type AdmissionWait = Data.TaggedEnum<{
  forever: {};
  upTo: { readonly duration: Duration.Input };
}>;
export const AdmissionWait = Data.taggedEnum<AdmissionWait>();

const tagged = <Input, State>(metric: Metric.Metric<Input, State>, kind: ExecutionAdmissionKind) =>
  Metric.withAttributes(metric, { kind });

const updateGauge = (
  metric: Metric.Metric<number, Metric.GaugeState<number>>,
  kind: ExecutionAdmissionKind,
  value: number,
) => Metric.update(tagged(metric, kind), value);

const configValue = (name: string, fallback: number, minimum: number) =>
  Config.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum: 16_384 })), name).pipe(
    Config.withDefault(fallback),
  );

const configuredLimits = Config.all({
  workflow: Config.all({
    active: configValue(
      "CONTEXT_AGENT_WORKFLOW_CONCURRENCY",
      defaultExecutionAdmissionLimits.workflow.active,
      1,
    ),
    queued: configValue(
      "CONTEXT_AGENT_WORKFLOW_QUEUE_CAPACITY",
      defaultExecutionAdmissionLimits.workflow.queued,
      0,
    ),
  }),
  model: Config.all({
    active: configValue(
      "CONTEXT_AGENT_MODEL_CONCURRENCY",
      defaultExecutionAdmissionLimits.model.active,
      1,
    ),
    queued: configValue(
      "CONTEXT_AGENT_MODEL_QUEUE_CAPACITY",
      defaultExecutionAdmissionLimits.model.queued,
      0,
    ),
  }),
  tool: Config.all({
    active: configValue(
      "CONTEXT_AGENT_TOOL_CONCURRENCY",
      defaultExecutionAdmissionLimits.tool.active,
      1,
    ),
    queued: configValue(
      "CONTEXT_AGENT_TOOL_QUEUE_CAPACITY",
      defaultExecutionAdmissionLimits.tool.queued,
      0,
    ),
  }),
});

const makeGate = Effect.fnUntraced(function* (limits: GateLimits) {
  return {
    limits,
    activePermits: yield* Semaphore.make(limits.active),
    admittedPermits: yield* Semaphore.make(limits.active + limits.queued),
    active: yield* Ref.make(0),
    queued: yield* Ref.make(0),
  } satisfies Gate;
});

const make = Effect.fnUntraced(function* (limits: ExecutionAdmissionLimits) {
  const gates = {
    workflow: yield* makeGate(limits.workflow),
    model: yield* makeGate(limits.model),
    tool: yield* makeGate(limits.tool),
  } satisfies Record<ExecutionAdmissionKind, Gate>;

  const snapshot = Effect.fnUntraced(function* (kind: ExecutionAdmissionKind) {
    const gate = gates[kind];
    return {
      active: yield* Ref.get(gate.active),
      queued: yield* Ref.get(gate.queued),
      activeLimit: gate.limits.active,
      queueCapacity: gate.limits.queued,
    } satisfies ExecutionAdmissionSnapshot;
  });

  const saturated = (kind: ExecutionAdmissionKind, state: ExecutionAdmissionSnapshot) =>
    ExecutionSaturated.make({
      kind,
      active: state.active,
      queued: state.queued,
      capacity: state.activeLimit + state.queueCapacity,
    });

  /** Counts and logs a caller's first refusal, not every retry of the same wait. */
  const reportOnce = (
    kind: ExecutionAdmissionKind,
    refused: Ref.Ref<boolean>,
    state: ExecutionAdmissionSnapshot,
  ) =>
    Effect.when(
      Metric.update(tagged(saturatedCounter, kind), 1).pipe(
        Effect.andThen(
          Effect.logWarning("execution admission saturated").pipe(
            Effect.annotateLogs({
              admission_kind: kind,
              active: state.active,
              queued: state.queued,
              capacity: state.activeLimit + state.queueCapacity,
              outcome: "saturated",
            }),
          ),
        ),
      ),
      Effect.map(Ref.getAndSet(refused, true), (seen) => !seen),
    );

  /** Fails with `ExecutionSaturated` when both the active and the queued capacity are taken. */
  const admit = (kind: ExecutionAdmissionKind, refused: Ref.Ref<boolean>) =>
    gates[kind].admittedPermits.takeIfAvailable(1).pipe(
      Effect.filterOrElse(
        (admitted) => admitted,
        () =>
          snapshot(kind).pipe(
            Effect.tap((state) => reportOnce(kind, refused, state)),
            Effect.flatMap((state) => Effect.fail(saturated(kind, state))),
          ),
      ),
    );

  /**
   * Takes a permit, waiting in the queue behind active work. When the queue is full too, the
   * caller tries again until `wait` runs out; saturation is not a failure of the work itself.
   */
  const acquire = (kind: ExecutionAdmissionKind, wait: AdmissionWait = AdmissionWait.forever()) => {
    const gate = gates[kind];
    const schedule = AdmissionWait.$match(wait, {
      forever: () => saturatedRetry,
      upTo: ({ duration }) => saturatedRetry.pipe(Schedule.upTo({ duration })),
    });
    return Effect.gen(function* () {
      yield* admit(kind, yield* Ref.make(false)).pipe(Effect.retry(schedule));

      const waitInQueue = Ref.updateAndGet(gate.queued, (value) => value + 1).pipe(
        Effect.flatMap((queued) => updateGauge(queuedGauge, kind, queued)),
        Effect.andThen(
          gate.activePermits.take(1).pipe(
            Effect.ensuring(
              Ref.updateAndGet(gate.queued, (value) => value - 1).pipe(
                Effect.flatMap((value) => updateGauge(queuedGauge, kind, value)),
              ),
            ),
            Effect.onInterrupt(() => gate.admittedPermits.release(1)),
          ),
        ),
      );
      yield* gate.activePermits.takeIfAvailable(1).pipe(
        Effect.filterOrElse(
          (activeImmediately) => activeImmediately,
          () => waitInQueue,
        ),
      );
      const active = yield* Ref.updateAndGet(gate.active, (value) => value + 1);
      yield* updateGauge(activeGauge, kind, active);
      const released = yield* Ref.make(false);
      return yield* Effect.succeed(
        Ref.getAndSet(released, true).pipe(
          Effect.flatMap((alreadyReleased) =>
            alreadyReleased
              ? Effect.void
              : Ref.updateAndGet(gate.active, (value) => value - 1).pipe(
                  Effect.flatMap((value) => updateGauge(activeGauge, kind, value)),
                  Effect.andThen(gate.activePermits.release(1)),
                  Effect.andThen(gate.admittedPermits.release(1)),
                  Effect.asVoid,
                ),
          ),
        ),
      );
    });
  };

  const run = <A, E, R>(
    kind: ExecutionAdmissionKind,
    effect: Effect.Effect<A, E, R>,
    wait?: AdmissionWait,
  ): Effect.Effect<A, E | ExecutionSaturated, R> =>
    Effect.acquireUseRelease(
      acquire(kind, wait),
      () => effect,
      (release) => release,
    ).pipe(
      Effect.withSpan("execution.admission", {
        attributes: {
          admission_kind: kind,
          active_limit: gates[kind].limits.active,
          queue_capacity: gates[kind].limits.queued,
        },
      }),
    );

  return { acquire, run, snapshot, limits } as const;
});

export class ExecutionAdmission extends Context.Service<
  ExecutionAdmission,
  Effect.Success<ReturnType<typeof make>>
>()("memory-agent/runtime/execution-admission/ExecutionAdmission") {
  static readonly layer = (limits?: ExecutionAdmissionLimits) =>
    Layer.effect(
      ExecutionAdmission,
      limits === undefined
        ? configuredLimits.pipe(Effect.flatMap(make))
        : Schema.decodeEffect(ExecutionAdmissionLimits)(limits).pipe(
            Effect.mapError((error) => new Config.ConfigError(error)),
            Effect.flatMap(make),
          ),
    );
}
