import { MutableHashSet } from "effect";
import { Result, Function as EffectFunction } from "effect";
import { isTruthy } from "../truthy.ts";
import { MutableHashMap, Exit, Option, Cause, Data, Effect, Predicate, Schema } from "effect";
import type { RunBinding } from "../workflow/run-bindings.ts";
import {
  ownerRpcCanonicalJson as canonical,
  ownerRpcFingerprint,
  ownerRpcFingerprintDigest,
} from "./owner-rpc-fingerprint.ts";

// Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
const parseJson = EffectFunction.flow(
  Schema.decodeResult(Schema.fromJsonString(Schema.Json)),
  Result.getOrThrow,
);

/** Owner infrastructure failures are not protocol replies or proof of settlement. */
export class OwnerRpcFailure extends Schema.TaggedError<OwnerRpcFailure>()("OwnerRpcFailure", {
  phase: Schema.Literals(["authority", "reserve", "settle"]),
  cause: Schema.Defect(),
}) {}

/** A ledger call the owner refuses, or ledger storage that could not be read or written. */
export class OwnerRpcLedgerError extends Schema.TaggedError<OwnerRpcLedgerError>()(
  "OwnerRpcLedgerError",
  {
    reason: Schema.Literals([
      "unbound_run",
      "invalid_operation_id",
      "reply_mismatch",
      "unreserved",
      "already_settled",
      "outer_transaction",
      "storage",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** The owner could not decide whether a capability is still active. */
export class OwnerAuthorityError extends Schema.TaggedError<OwnerAuthorityError>()(
  "OwnerAuthorityError",
  { cause: Schema.Defect() },
) {}

/** Whether the owner still honours a capability; read on every request, including replay. */
export type OwnerRpcPermits = (
  capability: OwnerRpcCapability,
) => Effect.Effect<boolean, OwnerAuthorityError>;

/** Freeze a detached JSON tree; never freeze caller-owned values. */
function freezeJson<T>(value: T): T {
  if (Predicate.isObject(value)) {
    Object.values(value).forEach(freezeJson);
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
export type OwnerRpcReply<T extends OwnerRpcJson = OwnerRpcJson> = Data.TaggedEnum<{
  succeeded: { readonly operationId: number; readonly output: T };
  pending: { readonly operationId: number };
  uncertain: { readonly operationId: number };
  rejected: {
    readonly operationId: number;
    readonly reason:
      | "unauthorized"
      | "invalid_operation"
      | "operation_conflict"
      | "non_monotonic"
      | "uncertain_run";
  };
}>;
interface OwnerRpcReplyDefinition extends Data.TaggedEnum.WithGenerics<1> {
  readonly taggedEnum: OwnerRpcReply<this["A"] & OwnerRpcJson>;
}
export const OwnerRpcReply = Data.taggedEnum<OwnerRpcReplyDefinition>();
export type OwnerRpcRecord = {
  readonly fingerprint: string;
  readonly reply: OwnerRpcReply;
};
export type OwnerRpcAdmission = Data.TaggedEnum<{
  reserved: {};
  existing: { readonly record: OwnerRpcRecord };
  rejected: { readonly reason: "non_monotonic" | "uncertain_run" };
}>;
export const OwnerRpcAdmission = Data.taggedEnum<OwnerRpcAdmission>();

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
  ): Effect.Effect<OwnerRpcAdmission, OwnerRpcLedgerError>;
  settle(
    runKey: string,
    operationId: number,
    reply: OwnerRpcReply,
  ): Effect.Effect<void, OwnerRpcLedgerError>;
}

/** Test/reference ledger only: NOT crash-safe and NOT a production integration. */
export function makeInMemoryOwnerRpcLedger(): OwnerRpcLedger {
  const runs = MutableHashMap.empty<
    string,
    {
      highWater: number;
      records: MutableHashMap.MutableHashMap<number, OwnerRpcRecord>;
      pendingEffects: MutableHashSet.MutableHashSet<number>;
    }
  >();
  return {
    reserve: (runKey, operationId, fingerprint, sideEffect) =>
      Effect.sync((): OwnerRpcAdmission => {
        let run = Option.getOrUndefined(MutableHashMap.get(runs, runKey));
        if (!isTruthy(run)) {
          run = {
            highWater: 0,
            records: MutableHashMap.empty(),
            pendingEffects: MutableHashSet.empty<number>(),
          };
          MutableHashMap.set(runs, runKey, run);
        }
        const existing = Option.getOrUndefined(MutableHashMap.get(run.records, operationId));
        if (isTruthy(existing)) return OwnerRpcAdmission.existing({ record: existing });
        if (operationId <= run.highWater)
          return OwnerRpcAdmission.rejected({ reason: "non_monotonic" });
        if (sideEffect && MutableHashSet.size(run.pendingEffects) > 0)
          return OwnerRpcAdmission.rejected({ reason: "uncertain_run" });
        run.highWater = operationId;
        MutableHashMap.set(run.records, operationId, {
          fingerprint,
          reply: OwnerRpcReply.pending({ operationId }),
        });
        if (sideEffect) MutableHashSet.add(run.pendingEffects, operationId);
        return OwnerRpcAdmission.reserved();
      }),
    settle: Effect.fnUntraced(function* (runKey, operationId, reply) {
      const run = Option.getOrUndefined(MutableHashMap.get(runs, runKey));
      const record = Option.getOrUndefined(
        Option.flatMap(Option.fromNullishOr(run?.records), (map) =>
          MutableHashMap.get(map, operationId),
        ),
      );
      if (!isTruthy(run) || !isTruthy(record))
        return yield* OwnerRpcLedgerError.make({ reason: "unreserved" });
      if (!OwnerRpcReply.$is("pending")(record.reply))
        return yield* OwnerRpcLedgerError.make({ reason: "already_settled" });
      MutableHashMap.set(run.records, operationId, { fingerprint: record.fingerprint, reply });
      if (OwnerRpcReply.$is("succeeded")(reply))
        MutableHashSet.remove(run.pendingEffects, operationId);
    }),
  };
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
  readonly permits: OwnerRpcPermits;
  readonly permitsFinalization?: OwnerRpcPermits;
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
    // The worker sees only the reason; the log also names the check that refused, never the input.
    const reject = (
      reason: Data.TaggedEnum.Value<OwnerRpcReply, "rejected">["reason"],
      check: string,
    ) =>
      Effect.as(
        Effect.logWarning("Owner RPC rejected", { operation, operationId, reason, check }),
        OwnerRpcReply.rejected({ operationId, reason }),
      );
    const permitted = (permits: OwnerRpcPermits) =>
      Effect.suspend(() => permits(capability)).pipe(
        Effect.mapError((cause) => OwnerRpcFailure.make({ phase: "authority", cause })),
      );
    const initiallyActive = yield* permitted(options.permits);
    if (
      request.type !== "owner-rpc-request" ||
      !Number.isSafeInteger(operationId) ||
      operationId < 1 ||
      !Object.hasOwn(options.handlers, operation)
    )
      return yield* reject("invalid_operation", "envelope");
    // Input without a canonical JSON form is the worker's invalid operation, not an owner failure.
    const prepared = yield* Effect.try(() => ({
      fingerprint: ownerRpcFingerprint(operation, request.input),
      input: freezeJson(parseJson(canonical(request.input))),
    })).pipe(
      Effect.asSome,
      Effect.catchTag("UnknownError", () => Effect.succeedNone),
    );
    if (Option.isNone(prepared)) return yield* reject("invalid_operation", "input_json");
    const { fingerprint, input } = prepared.value;
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
    const permitsFinalization = options.permitsFinalization;
    const finalization = Effect.try({
      try: () => handler.finalization?.(input) === true,
      catch: (cause) => OwnerRpcFailure.make({ phase: "authority", cause }),
    }).pipe(
      Effect.flatMap((requested) =>
        requested && permitsFinalization !== undefined
          ? permitted(permitsFinalization)
          : Effect.succeed(false),
      ),
    );
    if (!initiallyActive && !(yield* finalization))
      return yield* reject("unauthorized", "inactive");
    const authorized = yield* Effect.try(() =>
      isTruthy(handler.authorize)
        ? handler.authorize(structuredClone(input), capability) === true
        : true,
    ).pipe(Effect.catchTag("UnknownError", () => Effect.succeed(false)));
    if (!authorized) return yield* reject("invalid_operation", "authorize");
    const admission = yield* Effect.suspend(() =>
      options.ledger.reserve(runKey, operationId, fingerprint, handler.sideEffect),
    ).pipe(Effect.mapError((cause) => OwnerRpcFailure.make({ phase: "reserve", cause })));
    const dispatch = Effect.gen(function* () {
      const reply = yield* Effect.suspend(() => handler.execute(input, capability)).pipe(
        Effect.flatMap((output) =>
          Effect.try((): OwnerRpcReply =>
            OwnerRpcReply.succeeded({ operationId, output: parseJson(canonical(output)) }),
          ),
        ),
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.succeed<OwnerRpcReply>(OwnerRpcReply.uncertain({ operationId })),
        ),
      );
      yield* Effect.suspend(() =>
        options.ledger.settle(runKey, operationId, structuredClone(reply)),
      ).pipe(
        Effect.mapError((cause) => OwnerRpcFailure.make({ phase: "settle", cause })),
        Effect.uninterruptible,
      );
      const stillActive = yield* permitted(options.permits);
      if (!stillActive && !(yield* finalization))
        return yield* reject("unauthorized", "inactive_after");
      return reply;
    });
    return yield* OwnerRpcAdmission.$match(admission, {
      rejected: ({ reason }) => reject(reason, "ledger"),
      existing: ({ record }) =>
        !initiallyActive
          ? reject("unauthorized", "inactive_replay")
          : ownerRpcFingerprintDigest(record.fingerprint) === ownerRpcFingerprintDigest(fingerprint)
            ? Effect.succeed(structuredClone(record.reply))
            : reject("operation_conflict", "fingerprint"),
      reserved: () => dispatch,
    });
  });
}

/** Narrow legacy Promise handler/transport adapter; the execution core stays native. */
export function makeOwnerRpc<M extends OwnerRpcOperations>(options: {
  readonly permits: OwnerRpcPermits;
  readonly permitsFinalization?: OwnerRpcPermits;
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
    Effect.runPromiseExit(execute(request)).then((exit) =>
      Exit.match(exit, {
        onSuccess: (reply) => reply,
        onFailure: (cause) => {
          const error = Cause.squash(cause);
          throw Schema.is(OwnerRpcFailure)(error) ? error.cause : error;
        },
      }),
    );
}
