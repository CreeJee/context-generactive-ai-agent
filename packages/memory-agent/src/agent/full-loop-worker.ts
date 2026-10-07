import { Cause, Effect, Function, Result, Schema, Stream } from "effect";
import { nativePromise, runNativeEffect } from "../runtime/native-effect.ts";
import { nativeStream } from "../runtime/native-stream.ts";
import { parentPort, workerData } from "node:worker_threads";
import {
  chat,
  defineInterrupt,
  type AnyTextAdapter,
  type ChatMiddleware,
  type ChatMiddlewareContext,
} from "@tanstack/ai";
import { encodeFullLoopValue, decodeFullLoopValue } from "./full-loop-codec.ts";
// Pure MessagePort client, not an Effect service constructor.
// oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports
import { makeOwnerRpcPortClient } from "./full-loop-rpc-client.ts";

// This process owns only SDK transient state. Every external capability uses the
// owner endpoint and its durable admission ledger. There is no retry path.
const {
  port,
  capability,
  turn,
  tools,
  middleware,
  adapter: identity,
  lastOperationId,
} = workerData;
if (!(parentPort !== null)) throw new Error("Full-loop entry requires a worker parent port");
const parent = parentPort;
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
const definitions = (turn.interrupts ?? []).map((definition: any) => {
  // The SDK overloads differ for payload/response schemas; the owner supplied
  // the definition and its portable schema inventory before worker admission.
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
      (definition: ReturnType<typeof defineInterrupt>) => definition.id === value.definition.id,
    );
    if (definition === undefined) throw new Error("Unregistered owner interrupt definition");
    const { definition: _definition, ...input } = value;
    return definition.interrupt(input);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, restoreInterruptRequests(entry)]),
  );
}
const client = makeOwnerRpcPortClient(port);
const controller = new AbortController();
let operationId = lastOperationId;
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
const rpcEffect = Effect.fn("FullLoopWorker.rpc")(function* (operation: string, input: any) {
  const reply = yield* nativePromise(() =>
    client.request({
      type: "owner-rpc-request",
      capability,
      operationId: ++operationId,
      operation,
      input: encodeFullLoopValue(input),
    }),
  );
  if (reply.type !== "succeeded")
    return yield* new Cause.UnknownError(new Error(`Owner capability ${reply.type}`));
  // Operation-specific SDK payloads are validated by the owner before admission.
  const output: any = decodeFullLoopValue(reply.output);
  return output;
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
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
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
          return result.value;
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
  (
    {
      name,
      hooks,
      routedPersistence,
    }: { name: string; hooks: string[]; routedPersistence: string[] },
    index: number,
  ) => {
    // SDK hooks have heterogeneous signatures; only inventoried hooks are installed.
    const proxy: any = { name };
    if (routedPersistence.length > 0)
      proxy.routedSubagentPersistence = Object.fromEntries(
        routedPersistence.map((method) => [
          method,
          (value: any) => rpc("routedPersistence", { index, method, value }),
        ]),
      );
    for (const hook of hooks) {
      // Owner authorization runs the complete permission chain once, not worker-
      // selected individual hooks. Keep the middleware's other SDK hooks intact.
      if (hook === "onBeforeToolCall") continue;
      // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
      proxy[hook] = (ctx: ChatMiddlewareContext, info: any) =>
        runNativeEffect(
          Effect.gen(function* () {
            let payload = info ?? null;
            if (hook === "onConfig") payload = { ...info, tools: tools };
            const response = yield* rpcEffect("middleware", {
              index,
              hook,
              context: contextSnapshot(ctx),
              info: payload,
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
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
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
parentPort.on("message", (message) => {
  if (message.type === "abort") controller.abort();
});
await runNativeEffect(
  Effect.gen(function* () {
    // Strategy is synchronous in the SDK; continuation is mediated through its
    // asynchronous middleware hook so the owner's strategy stays owner-resident.
    const strategy: ChatMiddleware = {
      name: "owner-strategy",
      onShouldContinue: (_ctx, state) => rpc("strategy", state),
    };
    const stream = chat({
      ...turn,
      interrupts: definitions,
      context: turn.context ?? {},
      adapter,
      tools: tools.map(toolProxy),
      middleware: [
        ...hooks,
        {
          name: "owner-tool-grant",
          // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
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
    yield* Stream.fromAsyncIterable(stream, (cause) => new Cause.UnknownError(cause)).pipe(
      Stream.runForEach((chunk) =>
        Effect.gen(function* () {
          // The owner consumer must acknowledge each event before the next SDK pull.
          parent.postMessage({ type: "chunk", chunk });
          yield* nativePromise(() => new Promise((resolve) => parent.once("message", resolve)));
        }),
      ),
    );
    parent.postMessage({ type: "done" });
  }).pipe(
    Effect.catchCause(() => Effect.sync(() => parent.postMessage({ type: "failed" }))),
    Effect.ensuring(
      Effect.sync(() => {
        client.close();
        parent.close();
      }),
    ),
  ),
);
