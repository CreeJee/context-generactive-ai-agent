import * as NodeWorkerRunner from "@effect/platform-node/NodeWorkerRunner";
import { Cause, Effect, Function, Layer, Result, Schema, Scope, Stream } from "effect";
import { RpcClient, RpcServer } from "effect/rpc";
import { workerData } from "node:worker_threads";
import {
  chat,
  defineInterrupt,
  type AnyTextAdapter,
  type ChatMiddleware,
  type ChatMiddlewareContext,
} from "@tanstack/ai";
import { runNativeEffect } from "../runtime/native-effect.ts";
import { toolResultKey } from "../tools/failure.ts";
import { nativeStream } from "../runtime/native-stream.ts";
import { decodeFullLoopValue, encodeFullLoopValue } from "./full-loop-codec.ts";
import {
  FullLoopCapability,
  FullLoopCapabilityMiddleware,
  FullLoopOwnerReply,
  FullLoopOwnerRpcGroup,
  FullLoopRpcError,
  FullLoopRpcGroup,
  type FullLoopRunPayload,
  OwnerToolOutcome,
} from "./full-loop-effect-rpc.ts";
import { layerMessagePortRpcClient } from "./effect-rpc-message-port.ts";

// TanStack's native SDK requires an AbortController, not an AbortSignal.
const sdkAbortController = () => new AbortController();

/**
 * An owner read tool failed. The patched SDK hands the model the owner's `{ error, cause, detail }`
 * (see `ToolFailed`), so the owner's failure is carried here and nowhere else.
 */
class OwnerToolFailed extends Schema.TaggedError<OwnerToolFailed>()("OwnerToolFailed", {
  result: Schema.Struct({ error: Schema.String, cause: Schema.String, detail: Schema.String }),
}) {
  override get message() {
    return `${this.result.error}: ${this.result.detail}`;
  }

  get [toolResultKey]() {
    return this.result;
  }
}

function portableSchema(schema: any) {
  if (schema === undefined) return undefined;
  return {
    "~standard": {
      version: 1,
      vendor: "owner-portable",
      jsonSchema: { input: () => schema, output: () => schema },
    },
  };
}

// The owner fixes this run's capability at construction; every RunFullLoop must present it.
const WorkerSetup = Schema.Struct({ capability: FullLoopCapability });
const sameCapability = Schema.toEquivalence(FullLoopCapability);

function runFullLoop(
  payload: FullLoopRunPayload,
): Stream.Stream<unknown, FullLoopRpcError, Scope.Scope> {
  return Stream.unwrap(
    Effect.gen(function* () {
      // SAFETY: the RPC schema decoded the envelope; nested SDK values intentionally
      // remain opaque because their contracts are owned by TanStack AI.
      const {
        capability,
        turn,
        tools,
        middleware,
        adapter: identity,
        lastOperationId,
        ownerPort,
      } = payload as any;
      const definitions = (turn.interrupts ?? []).map((definition: any) => {
        const options: any = { id: definition.id };
        if (definition.payloadSchema !== undefined)
          options.payloadSchema = portableSchema(definition.payloadSchema);
        if (definition.responseSchema !== undefined)
          options.responseSchema = portableSchema(definition.responseSchema);
        return defineInterrupt(options);
      });
      function restoreInterruptRequests(value: any): any {
        if (value === null || value === undefined) return value;
        if (Array.isArray(value)) return value.map(restoreInterruptRequests);
        if (Object.getPrototypeOf(value) !== Object.prototype) return value;
        if ((value.definition?.id?.length ?? 0) > 0 && (value.key?.length ?? 0) > 0) {
          const definition = definitions.find(
            (entry: ReturnType<typeof defineInterrupt>) => entry.id === value.definition.id,
          );
          // The owner answered with an interrupt this worker never registered.
          if (definition === undefined)
            throw FullLoopRpcError.make({ reason: "owner_rejected", refusal: "unknown_interrupt" });
          const { definition: _definition, ...input } = value;
          return definition.interrupt(input);
        }
        return Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [key, restoreInterruptRequests(entry)]),
        );
      }

      const ownerProtocolContext = yield* Layer.build(layerMessagePortRpcClient(ownerPort)).pipe(
        Effect.mapError(() => FullLoopRpcError.make({ reason: "owner_transport" })),
      );
      const owner = yield* RpcClient.make(FullLoopOwnerRpcGroup).pipe(
        Effect.provide(ownerProtocolContext),
      );
      const controller = sdkAbortController();
      yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort("worker interrupted")));
      let operationId = lastOperationId;
      const rpcEffect = Effect.fn("FullLoopWorker.rpc")(function* (operation: string, input: any) {
        const reply = yield* owner.OwnerCall({
          type: "owner-rpc-request",
          capability,
          operationId: ++operationId,
          operation,
          input: encodeFullLoopValue(input),
        });
        const refused = (refusal: FullLoopRpcError["refusal"]) =>
          FullLoopRpcError.make({ reason: "owner_rejected", refusal });
        return yield* FullLoopOwnerReply.match<Effect.Effect<any, FullLoopRpcError>>(reply, {
          // SAFETY: operation-specific owner handlers validated the encoded SDK payload.
          succeeded: ({ output }) => Effect.succeed(decodeFullLoopValue(output) as any),
          pending: () => Effect.fail(refused("pending")),
          uncertain: () => Effect.fail(refused("uncertain")),
          rejected: ({ reason }) => Effect.fail(refused(reason)),
        });
      });
      const rpc = (operation: string, input: any): Promise<any> =>
        runNativeEffect(rpcEffect(operation, input));
      const parseArguments = Function.flow(
        Schema.decodeResult(Schema.fromJsonString(Schema.Unknown)),
        Result.getOrThrow,
      );
      function toolProxy(tool: any) {
        const proxy = { ...tool };
        if (tool.server === true)
          proxy.execute = (args: any, context: ChatMiddlewareContext & { toolCallId?: string }) =>
            runNativeEffect(
              Effect.gen(function* () {
                const result = yield* rpcEffect("tool", {
                  name: tool.name,
                  args: args ?? null,
                  toolCallId: context?.toolCallId ?? null,
                });
                for (const event of result.events)
                  context?.emitCustomEvent(event.name, event.value, event.options);
                return yield* OwnerToolOutcome.matchOrElse<
                  Effect.Effect<unknown, OwnerToolFailed | FullLoopRpcError>
                >(
                  result.outcome,
                  {
                    succeeded: ({ value }) => Effect.succeed(value),
                    failed: ({ failure }) => Effect.fail(OwnerToolFailed.make({ result: failure })),
                  },
                  () =>
                    Effect.fail(
                      FullLoopRpcError.make({
                        reason: "owner_rejected",
                        refusal: "unknown_tool_outcome",
                      }),
                    ),
                );
              }),
            );
        return proxy;
      }
      function contextSnapshot(ctx: ChatMiddlewareContext) {
        const {
          signal: _signal,
          abort: _abort,
          emitCustomEvent: _emitCustomEvent,
          defer: _defer,
          createId: _createId,
          capabilities: _capabilities,
          get: _get,
          getOptional: _getOptional,
          provide: _provide,
          ...snapshot
        } = ctx;
        return snapshot;
      }
      const hooks = middleware.map(
        (entry: { name: string; hooks: string[]; routedPersistence: string[] }, index: number) => {
          const proxy: any = { name: entry.name };
          if (entry.routedPersistence.length > 0)
            proxy.routedSubagentPersistence = Object.fromEntries(
              entry.routedPersistence.map((method) => [
                method,
                (value: any) => rpc("routedPersistence", { index, method, value }),
              ]),
            );
          for (const hook of entry.hooks) {
            if (hook === "onBeforeToolCall") continue;
            proxy[hook] = (ctx: ChatMiddlewareContext, info: any) =>
              runNativeEffect(
                Effect.gen(function* () {
                  let hookPayload = info ?? null;
                  if (hook === "onConfig") hookPayload = { ...info, tools };
                  const response = yield* rpcEffect("middleware", {
                    index,
                    hook,
                    context: contextSnapshot(ctx),
                    info: hookPayload,
                  });
                  for (const event of response.events)
                    ctx.emitCustomEvent(event.name, event.value, event.options);
                  if (response.abort !== null) ctx.abort(response.abort);
                  let result = restoreInterruptRequests(response.result);
                  if (hook === "onConfig" && result?.tools !== undefined)
                    result = { ...result, tools: result.tools.map(toolProxy) };
                  return result === null && response.void === true ? undefined : result;
                }),
              );
          }
          return proxy;
        },
      );
      const adapter: AnyTextAdapter = {
        ...identity,
        chatStream(options) {
          return nativeStream(
            Stream.fromPull(
              Effect.gen(function* () {
                const {
                  request: _request,
                  logger: _logger,
                  capabilities: _capabilities,
                  ...input
                } = options;
                const opened = yield* rpcEffect("modelOpen", {
                  ...input,
                  approvals: [...(input.approvals?.entries() ?? [])],
                });
                return {
                  pull: Effect.gen(function* () {
                    if (controller.signal.aborted) return yield* Cause.done();
                    const next = yield* rpcEffect("modelNext", { id: opened.id });
                    if (next.done === true) return yield* Cause.done();
                    return [next.value] as const;
                  }),
                };
              }).pipe(Effect.map(({ pull }) => pull)),
            ),
          );
        },
      };
      const strategy: ChatMiddleware = {
        name: "owner-strategy",
        onShouldContinue: (_ctx, state) => rpc("strategy", state),
      };
      const sdkStream = chat({
        ...turn,
        interrupts: definitions,
        context: turn.context ?? {},
        adapter,
        tools: tools.map(toolProxy),
        middleware: [
          ...hooks,
          {
            name: "owner-tool-grant",
            onBeforeToolCall: (ctx, info) =>
              runNativeEffect(
                Effect.gen(function* () {
                  const response = yield* rpcEffect("toolAuthorize", {
                    name: info.toolName,
                    toolCallId: info.toolCallId,
                    args: parseArguments(info.toolCall.function.arguments || "{}"),
                  });
                  for (const event of response.events ?? [])
                    ctx.emitCustomEvent(event.name, event.value, event.options);
                  return response.decision;
                }),
              ),
          },
          strategy,
        ],
        agentLoopStrategy: () => true,
        outputSchema: undefined,
        abortController: controller,
        stream: true,
      });
      return Stream.fromAsyncIterable(sdkStream, () =>
        FullLoopRpcError.make({ reason: "worker_failed" }),
      );
    }),
  );
}

const handlers = FullLoopRpcGroup.toLayer({ RunFullLoop: runFullLoop });
const authorization = Layer.effect(FullLoopCapabilityMiddleware)(
  Schema.decodeUnknownEffect(WorkerSetup)(workerData).pipe(
    Effect.map(
      ({ capability: trusted }) =>
        (effect, options) =>
          // SAFETY: middleware runs after the RunFullLoop payload schema decoder.
          sameCapability((options.payload as FullLoopRunPayload).capability, trusted)
            ? effect
            : Effect.fail(FullLoopRpcError.make({ reason: "unauthorized" })),
    ),
  ),
);
const protocol = RpcServer.layerProtocolWorkerRunner.pipe(Layer.provide(NodeWorkerRunner.layer));
const server = RpcServer.layer(FullLoopRpcGroup, {
  concurrency: 1,
  disableFatalDefects: true,
}).pipe(Layer.provide(handlers), Layer.provide(authorization), Layer.provide(protocol));

await runNativeEffect(Layer.launch(server));
