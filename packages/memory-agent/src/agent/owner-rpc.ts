import { Cause, Effect, Predicate, Schema } from "effect";
import type { RunBinding } from "../workflow/run-bindings.ts";

/** Owner infrastructure failures are not protocol replies or proof of settlement. */
export class OwnerRpcFailure extends Schema.TaggedError<OwnerRpcFailure>()("OwnerRpcFailure", {
  phase: Schema.Literals(["authority", "reserve", "settle"]),
  cause: Schema.Defect(),
}) {}

/** Freeze a detached JSON tree; never freeze caller-owned values. */
function freezeJson<T>(value: T): T {
  if (Predicate.isObject(value)) {
    for (const entry of Object.values(value)) freezeJson(entry);
    Object.freeze(value);
  }
  return value;
}

/** Owner-issued secret; never send to the UI or persist in worker-owned storage. */
export type OwnerRpcCapability = RunBinding & {
  readonly generation: string;
  readonly token: string;
};
export type OwnerRpcJson =
  | null
  | boolean
  | number
  | string
  | readonly OwnerRpcJson[]
  | {
      readonly [key: string]: OwnerRpcJson;
    };
export type OwnerRpcOperations = Record<string, { input: OwnerRpcJson; output: OwnerRpcJson }>;
export type OwnerRpcRequest<M extends OwnerRpcOperations> = {
  [K in keyof M & string]: {
    readonly type: "owner-rpc-request";
    readonly capability: OwnerRpcCapability;
    readonly operationId: number;
    readonly operation: K;
    readonly input: M[K]["input"];
  };
}[keyof M & string];
export type OwnerRpcReply<T extends OwnerRpcJson = OwnerRpcJson> =
  | { readonly type: "succeeded"; readonly operationId: number; readonly output: T }
  | { readonly type: "pending"; readonly operationId: number }
  | { readonly type: "uncertain"; readonly operationId: number }
  | {
      readonly type: "rejected";
      readonly operationId: number;
      readonly reason:
        | "unauthorized"
        | "invalid_operation"
        | "operation_conflict"
        | "non_monotonic"
        | "uncertain_run";
    };
export type OwnerRpcRecord = {
  readonly fingerprint: string;
  readonly reply: OwnerRpcReply;
};
export type OwnerRpcAdmission =
  | { readonly type: "reserved" }
  | { readonly type: "existing"; readonly record: OwnerRpcRecord }
  | { readonly type: "rejected"; readonly reason: "non_monotonic" | "uncertain_run" };

/**
 * Central-owner ledger contract: reserve atomically records a pending operation BEFORE
 * dispatch, enforcing the run's high-water mark. Pending side effects fence further
 * side effects, including after owner restart. Settle must persist before replying.
 * Do not evict records while retries are possible. Production requires an owner-owned
 * durable implementation; the in-memory implementation below is for protocol tests.
 * No worker owns a DB, ledger, or authority decision.
 */
export interface OwnerRpcLedger {
  reserve(
    runKey: string,
    operationId: number,
    fingerprint: string,
    sideEffect: boolean,
  ): OwnerRpcAdmission;
  settle(runKey: string, operationId: number, reply: OwnerRpcReply): void;
}

/** Test/reference ledger only: NOT crash-safe and NOT a production integration. */
export function makeInMemoryOwnerRpcLedger(): OwnerRpcLedger {
  const runs = new Map<
    string,
    {
      highWater: number;
      records: Map<number, OwnerRpcRecord>;
      pendingEffects: Set<number>;
    }
  >();
  return {
    reserve(runKey, operationId, fingerprint, sideEffect) {
      let run = runs.get(runKey);
      if (!run) {
        run = { highWater: 0, records: new Map(), pendingEffects: new Set() };
        runs.set(runKey, run);
      }
      const existing = run.records.get(operationId);
      if (existing) return { type: "existing", record: existing };
      if (operationId <= run.highWater) return { type: "rejected", reason: "non_monotonic" };
      if (sideEffect && run.pendingEffects.size > 0)
        return { type: "rejected", reason: "uncertain_run" };
      run.highWater = operationId;
      run.records.set(operationId, {
        fingerprint,
        reply: { type: "pending", operationId },
      });
      if (sideEffect) run.pendingEffects.add(operationId);
      return { type: "reserved" };
    },
    settle(runKey, operationId, reply) {
      const run = runs.get(runKey);
      const record = run?.records.get(operationId);
      if (!run || !record) throw new Error("Unreserved owner RPC operation");
      switch (record.reply.type) {
        case "pending":
          break;
        default:
          throw new Error("Owner RPC operation already settled");
      }
      run.records.set(operationId, { fingerprint: record.fingerprint, reply });
      switch (reply.type) {
        case "succeeded":
          run.pendingEffects.delete(operationId);
          break;
        case "pending":
        case "uncertain":
        case "rejected":
          break;
      }
    },
  };
}

function canonical(value: OwnerRpcJson): string {
  if (value === null) return "null";
  // This is the JSON serialization boundary, not domain-value discrimination.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  switch (typeof value) {
    case "boolean":
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new Error("Non-finite RPC number");
      return JSON.stringify(value);
    case "object":
      if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
      return `{${Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
        .join(",")}}`;
    default:
      throw new Error("Non-JSON RPC value");
  }
}

export type OwnerRpcHandlers<M extends OwnerRpcOperations> = {
  readonly [K in keyof M]: {
    /** Trusted owner classification, never supplied by a worker. */
    readonly sideEffect: boolean;
    /** Owner classification only; terminal replay is never authorized by this grant. */
    readonly finalization?: (input: M[K]["input"]) => boolean;
    /** Pure, synchronous owner precondition AFTER binding authorization and BEFORE
     * ledger reservation (including replay). It grants no run/finalization authority.
     * False/throw is invalid_operation and must never create an uncertain fence. */
    readonly authorize?: (input: M[K]["input"], capability: OwnerRpcCapability) => boolean;
    readonly execute: (
      input: M[K]["input"],
      capability: OwnerRpcCapability,
    ) => Promise<M[K]["output"]>;
  };
};

/**
 * Transport-agnostic owner endpoint. permits must check the entire immutable binding,
 * token, current generation and active run on EVERY request, including replay. Revocation
 * fences late replies but cannot cancel an effect already dispatched. Uncertain effects
 * require explicit owner reconciliation; no automatic retry or generation reset exists.
 */
export type OwnerRpcEffectHandlers<M extends OwnerRpcOperations, E = never, R = never> = {
  readonly [K in keyof M]: Omit<OwnerRpcHandlers<M>[K], "execute"> & {
    readonly execute: (
      input: M[K]["input"],
      capability: OwnerRpcCapability,
    ) => Effect.Effect<M[K]["output"], E, R>;
  };
};

export type OwnerRpcEffectOptions<M extends OwnerRpcOperations, E = never, R = never> = {
  readonly permits: (capability: OwnerRpcCapability) => boolean;
  readonly permitsFinalization?: (capability: OwnerRpcCapability) => boolean;
  readonly ledger: OwnerRpcLedger;
  readonly handlers: OwnerRpcEffectHandlers<M, E, R>;
};

/**
 * Native, lazy, composable owner execution. Interruption after reservation deliberately
 * leaves the durable pending record: it cannot prove a side effect did not happen.
 * Handler failures (but never interruption) settle uncertain; ledger failures escape
 * through the typed channel. No retry, rollback or worker-side settlement is performed.
 */
export function makeOwnerRpcEffect<M extends OwnerRpcOperations, E = never, R = never>(
  options: OwnerRpcEffectOptions<M, E, R>,
) {
  return Effect.fn("OwnerRpc.execute")(function* (
    request: OwnerRpcRequest<M>,
  ): Effect.fn.Return<OwnerRpcReply, OwnerRpcFailure, R> {
    const { operationId, operation } = request;
    const capability = Object.freeze({ ...request.capability });
    const reject = (
      reason: Extract<OwnerRpcReply, { type: "rejected" }>["reason"],
    ): OwnerRpcReply => ({ type: "rejected", operationId, reason });
    const initiallyActive = yield* Effect.try({
      try: () => options.permits(capability),
      catch: (cause) => new OwnerRpcFailure({ phase: "authority", cause }),
    });
    if (
      request.type !== "owner-rpc-request" ||
      !Number.isSafeInteger(operationId) ||
      operationId < 1 ||
      !Object.hasOwn(options.handlers, operation)
    )
      return reject("invalid_operation");
    let fingerprint: string;
    let input: M[keyof M]["input"];
    try {
      fingerprint = canonical({ operation, input: request.input });
      input = freezeJson(JSON.parse(canonical(request.input)));
    } catch {
      return reject("invalid_operation");
    }
    // Deliberately excludes generation/token: rotating authority cannot reset a run's
    // operation IDs or bypass an uncertain side effect in that same run.
    const runKey = canonical({
      sessionId: capability.sessionId,
      runId: capability.runId,
      goalInstanceId: capability.goalInstanceId,
      goalVersion: capability.goalVersion,
      planVersion: capability.planVersion,
      workflowRevisionId: capability.workflowRevisionId,
    });
    const handler = options.handlers[operation];
    const finalization = Effect.try({
      try: () =>
        Boolean(handler.finalization?.(input) && options.permitsFinalization?.(capability)),
      catch: (cause) => new OwnerRpcFailure({ phase: "authority", cause }),
    });
    if (!initiallyActive && !(yield* finalization)) return reject("unauthorized");
    try {
      if (handler.authorize && handler.authorize(structuredClone(input), capability) !== true)
        return reject("invalid_operation");
    } catch {
      return reject("invalid_operation");
    }
    const admission = yield* Effect.try({
      try: () => options.ledger.reserve(runKey, operationId, fingerprint, handler.sideEffect),
      catch: (cause) => new OwnerRpcFailure({ phase: "reserve", cause }),
    });
    switch (admission.type) {
      case "rejected":
        return reject(admission.reason);
      case "existing":
        if (!initiallyActive) return reject("unauthorized");
        return admission.record.fingerprint === fingerprint
          ? structuredClone(admission.record.reply)
          : reject("operation_conflict");
      case "reserved":
        break;
    }
    const reply = yield* Effect.suspend(() => handler.execute(input, capability)).pipe(
      Effect.flatMap((output) =>
        Effect.try((): OwnerRpcReply => ({
          type: "succeeded",
          operationId,
          output: JSON.parse(canonical(output)),
        })),
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.interrupt
          : Effect.succeed<OwnerRpcReply>({ type: "uncertain", operationId }),
      ),
    );
    yield* Effect.try({
      try: () => options.ledger.settle(runKey, operationId, structuredClone(reply)),
      catch: (cause) => new OwnerRpcFailure({ phase: "settle", cause }),
    }).pipe(Effect.uninterruptible);
    const stillActive = yield* Effect.try({
      try: () => options.permits(capability),
      catch: (cause) => new OwnerRpcFailure({ phase: "authority", cause }),
    });
    if (!stillActive && !(yield* finalization)) return reject("unauthorized");
    return reply;
  });
}

/** Narrow legacy Promise handler/transport adapter; the execution core stays native. */
export function makeOwnerRpc<M extends OwnerRpcOperations>(options: {
  readonly permits: (capability: OwnerRpcCapability) => boolean;
  readonly permitsFinalization?: (capability: OwnerRpcCapability) => boolean;
  readonly ledger: OwnerRpcLedger;
  readonly handlers: OwnerRpcHandlers<M>;
}) {
  // SAFETY: each own operation key and its input/output pairing is preserved;
  // only execute's Promise return is converted to an Effect with the same result.
  const handlers = Object.fromEntries(
    Object.entries(options.handlers).map(([operation, handler]) => [
      operation,
      {
        ...handler,
        execute: (input: M[keyof M]["input"], capability: OwnerRpcCapability) =>
          Effect.tryPromise(() => handler.execute(input, capability)),
      },
    ]),
  ) as OwnerRpcEffectHandlers<M, unknown>;
  const execute = makeOwnerRpcEffect({ ...options, handlers });
  return (request: OwnerRpcRequest<M>): Promise<OwnerRpcReply> =>
    Effect.runPromise(
      execute(request).pipe(
        Effect.catchTag("OwnerRpcFailure", (error) => Effect.fail(error.cause)),
      ),
    );
}
