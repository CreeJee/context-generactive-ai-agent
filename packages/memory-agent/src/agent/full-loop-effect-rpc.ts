import { Rpc, RpcGroup, RpcMiddleware } from "effect/rpc";
import { Schema } from "effect";
import * as Transferable from "effect/workers/Transferable";
import { MessagePort } from "node:worker_threads";

// Validate the Node port before adapting Effect's platform-neutral DOM transfer-list type.
const OwnerPort = Transferable.schema(
  Schema.instanceOf(MessagePort),
  (port) =>
    // SAFETY: NodeWorker transfers validated Node ports; Effect's DOM event types differ.
    [port] as Parameters<typeof Transferable.addAll>[0],
);

// Worker RPC uses structured clone; unlike Schema.Unknown's JSON codec this preserves
// cloneable SDK values and optional `undefined` fields while still validating envelopes.
const StructuredCloneValue = Transferable.schema(Schema.Any, () => []);

const positiveSafeInteger = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);

export const FullLoopCapability = Schema.Struct({
  sessionId: Schema.String,
  runId: Schema.String,
  goalInstanceId: Schema.String,
  goalVersion: positiveSafeInteger,
  planVersion: Schema.NullOr(positiveSafeInteger),
  workflowRevisionId: positiveSafeInteger,
  generation: Schema.String,
  token: Schema.String,
});

export const FullLoopOwnerRequest = Schema.Struct({
  type: Schema.Literal("owner-rpc-request"),
  capability: FullLoopCapability,
  operationId: positiveSafeInteger,
  operation: Schema.String,
  input: Schema.Json,
});

const OwnerRejection = Schema.Literals([
  "unauthorized",
  "invalid_operation",
  "operation_conflict",
  "non_monotonic",
  "uncertain_run",
]);

export const FullLoopOwnerReply = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("succeeded"),
    operationId: positiveSafeInteger,
    output: Schema.Json,
  }),
  Schema.Struct({ type: Schema.Literal("pending"), operationId: positiveSafeInteger }),
  Schema.Struct({ type: Schema.Literal("uncertain"), operationId: positiveSafeInteger }),
  Schema.Struct({
    type: Schema.Literal("rejected"),
    operationId: positiveSafeInteger,
    reason: OwnerRejection,
  }),
]).pipe(Schema.toTaggedUnion("type"));

export const FullLoopRunPayload = Schema.Struct({
  capability: FullLoopCapability,
  lastOperationId: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
  turn: StructuredCloneValue,
  tools: StructuredCloneValue,
  middleware: StructuredCloneValue,
  adapter: StructuredCloneValue,
  ownerPort: OwnerPort,
});

/** Why the owner did not answer a worker request with success, as the worker last saw it. */
export const OwnerRefusal = Schema.Union([
  OwnerRejection,
  Schema.Literals(["pending", "uncertain", "unknown_interrupt", "unknown_tool_outcome"]),
]);

export class FullLoopRpcError extends Schema.TaggedError<FullLoopRpcError>()("FullLoopRpcError", {
  reason: Schema.Literals([
    "unauthorized",
    "owner_rejected",
    "owner_transport",
    "worker_failed",
    "saturated",
  ]),
  refusal: Schema.optional(OwnerRefusal),
}) {
  override get message() {
    if (this.reason === "worker_failed")
      return "Goal worker failed; dispatched owner operations have no replay";
    return this.refusal === undefined
      ? `Goal worker RPC ${this.reason}`
      : `Goal worker RPC ${this.reason} (${this.refusal})`;
  }
}

export class FullLoopCapabilityMiddleware extends RpcMiddleware.Service<FullLoopCapabilityMiddleware>()(
  "memory-agent/agent/FullLoopCapabilityMiddleware",
  { error: FullLoopRpcError },
) {}

export const RunFullLoop = Rpc.make("RunFullLoop", {
  payload: FullLoopRunPayload,
  success: StructuredCloneValue,
  error: FullLoopRpcError,
  stream: true,
}).middleware(FullLoopCapabilityMiddleware);

export const FullLoopRpcGroup = RpcGroup.make(RunFullLoop);

export const OwnerCall = Rpc.make("OwnerCall", {
  payload: FullLoopOwnerRequest,
  success: FullLoopOwnerReply,
  error: FullLoopRpcError,
});

export const FullLoopOwnerRpcGroup = RpcGroup.make(OwnerCall);

export type FullLoopRunPayload = typeof FullLoopRunPayload.Type;
export type FullLoopOwnerRequest = typeof FullLoopOwnerRequest.Type;
export type FullLoopOwnerReply = typeof FullLoopOwnerReply.Type;
