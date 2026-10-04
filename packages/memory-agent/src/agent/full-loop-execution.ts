import type { Worker } from "node:worker_threads";
import {
  acquireFullLoopChannel,
  acquireFullLoopEndpoint,
  acquireFullLoopWorker,
  WorkerLifecycleError,
} from "./full-loop-resources.ts";
import { isDeepStrictEqual } from "node:util";
import { parallelReads, readOnlyToolNames } from "../tools/parallel-reads.ts";
// Run-local observation ledger, not an Effect contextual service constructor.
import * as OwnerToolGrants from "./owner-tool-grants.ts";
import { Effect, Exit, Queue, Schema, Scope } from "effect";
import { acquireFullLoopWorkerEvents } from "./full-loop-worker-events.ts";

import { randomUUID } from "node:crypto";
import {
  convertSchemaToJsonSchema,
  convertMessagesToModelMessages,
  isStandardSchema,
  parseWithStandardSchema,
  type ChatMiddlewareContext,
  type AnyTextAdapter,
  type StreamChunk,
} from "@tanstack/ai";
import type { ChatExecutionCapabilities, ChatExecutionTurn } from "./chat-execution.ts";
import { assertFullLoopPortable } from "./full-loop-admission-preflight.ts";

// Descriptor inspection rejects accessors without invoking owner-supplied getters.
function ownerData<T extends object>(value: T): T {
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set)
      throw new Error("Unsupported owner snapshot accessor");
  }
  // All own string/symbol accessors were rejected above. Object.assign retains the
  // SDK-derived structural type; descriptor copying also retains non-enumerable data.
  const snapshot = Object.assign({}, value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set)
      throw new Error("Unsupported owner snapshot accessor");
    Object.defineProperty(snapshot, key, { ...descriptor, writable: true, configurable: true });
  }
  return snapshot;
}

// Plain configuration only: SDK schemas/capability handles stay owner services.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
function ownerConfigSnapshot(value: unknown): any {
  assertFullLoopPortable(value, "owner configuration");
  return decodeFullLoopValue(encodeFullLoopValue(value));
}

// Reflection boundary: SDK receivers may be class instances with inherited methods.
// This inspects data descriptors, not a domain/service object contract.
// oxlint-disable-next-line anti-slop/no-object-parameters
function ownerMember(receiver: object, key: string): any {
  for (let current = receiver; current; current = Object.getPrototypeOf(current)) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (!descriptor) continue;
    if (descriptor.get || descriptor.set)
      throw new Error(`Unsupported owner snapshot accessor: ${key}`);
    return descriptor.value;
  }
  throw new Error(`Missing owner member: ${key}`);
}

// Same descriptor-reflection boundary; bind the captured callable to its original
// SDK receiver without freezing or copying that receiver's mutable state.
// oxlint-disable-next-line anti-slop/no-object-parameters
function ownerMethod(receiver: object, key: string): any {
  const method = ownerMember(receiver, key);
  if (!(method instanceof Function)) throw new Error(`Unsupported owner callable: ${key}`);
  return method.bind(receiver);
}
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import type { OwnerRpcCapability, OwnerRpcJson, OwnerRpcLedger } from "./owner-rpc.ts";
import { encodeFullLoopValue, decodeFullLoopValue } from "./full-loop-codec.ts";
import {
  fullLoopHooks,
  preflightFullLoopExecution as basePreflight,
} from "./full-loop-preflight.ts";

export function preflightFullLoopExecution<TAdapter extends AnyTextAdapter>(
  turn: ChatExecutionTurn<TAdapter>,
  capabilities: ChatExecutionCapabilities<TAdapter>,
): void {
  basePreflight(turn, capabilities);
  const names = new Set<string>();
  for (const tool of capabilities.tools) {
    if (!tool.execute || names.has(tool.name))
      throw new Error(`Unsupported owner tool grant capability: ${tool.name}`);
    names.add(tool.name);
  }
}

/** Admission and high-water allocation belong to the central owner, never the worker. */
export interface FullLoopOwner {
  readonly capability: OwnerRpcCapability;
  readonly ledger: OwnerRpcLedger;
  readonly permits: (capability: OwnerRpcCapability) => boolean;
  readonly permitsFinalization?: (capability: OwnerRpcCapability) => boolean;
  /** Explicit owner-approved cleanup middleware names; never worker-selected grants. */
  readonly finalizationMiddleware?: readonly string[];
  readonly revoke?: () => void;
  readonly lastOperationId: number;
  readonly workerUrl?: URL;
  readonly onWorker?: (worker: Worker) => void;
  /** Owner-only asset lease hooks; stop releases only after the actual Worker terminates. */
  readonly onWorkerStarting?: () => void;
  readonly onWorkerStopped?: () => void;
}

// SDK values cross a JSON capability boundary, not a database/object-identity boundary.
// Serialization is the boundary parser; domain SDK values vary by hook and adapter.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
const json = (value: unknown): OwnerRpcJson => encodeFullLoopValue(value);

/** Complete SDK loop in worker_threads. No worker restart or operation replay is performed.
 * Unsupported object-identity SDK capabilities are rejected before worker admission.
 */
export function createFullLoopExecution<TAdapter extends AnyTextAdapter>(owner: FullLoopOwner) {
  return {
    async *execute(
      turn: ChatExecutionTurn<TAdapter>,
      capabilities: ChatExecutionCapabilities<TAdapter>,
    ): AsyncGenerator<StreamChunk> {
      const adapter = capabilities.model.adapter;
      const controller = capabilities.stream.abortController;
      if (!owner.permits(owner.capability)) throw new Error("Inactive owner capability");
      if (controller.signal.aborted) return;
      // Pin callable references and inventory before the first await. Bind to the
      // original receivers (private fields/WeakMaps), never freeze shared owners.
      // This is RUN-local, not a snapshot of closure/prototype dependencies or Goal code.
      const chatStream = ownerMethod(adapter, "chatStream");
      const adapterName = ownerMember(adapter, "name");
      const adapterModel = ownerMember(adapter, "model");
      const model = ownerData(capabilities.model);
      capabilities = {
        ...capabilities,
        model: {
          ...model,
          agentLoopStrategy: model.agentLoopStrategy?.bind(capabilities.model),
        },
        tools: capabilities.tools.map((original) => {
          const tool = ownerData(original);
          return {
            ...tool,
            inputSchema:
              tool.inputSchema && !isStandardSchema(tool.inputSchema)
                ? ownerConfigSnapshot(tool.inputSchema)
                : tool.inputSchema,
            outputSchema:
              tool.outputSchema && !isStandardSchema(tool.outputSchema)
                ? ownerConfigSnapshot(tool.outputSchema)
                : tool.outputSchema,
            execute: tool.execute?.bind(original),
          };
        }),
        middleware: capabilities.middleware.map((original) => {
          const mw = ownerData(original);
          for (const hook of fullLoopHooks) {
            const descriptor = Object.getOwnPropertyDescriptor(mw, hook);
            if (descriptor?.value instanceof Function)
              Reflect.set(mw, hook, descriptor.value.bind(original));
          }
          for (const key of ["requires", "provides", "optionalRequires"] as const)
            if (mw[key]) Reflect.set(mw, key, [...mw[key]!]);
          if (mw.routedSubagentPersistence) {
            const persistence = original.routedSubagentPersistence!;
            const captured = ownerData(persistence);
            for (const [key, method] of Object.entries(captured))
              if (method instanceof Function) Reflect.set(captured, key, method.bind(persistence));
            mw.routedSubagentPersistence = captured;
          }
          return mw;
        }),
      };
      turn = {
        ...ownerData(turn),
        messages: ownerConfigSnapshot(turn.messages),
        context: ownerConfigSnapshot(turn.context),
        systemPrompts: ownerConfigSnapshot(turn.systemPrompts),
        modelOptions: ownerConfigSnapshot(turn.modelOptions),
      };
      preflightFullLoopExecution(turn, capabilities);
      const toolDescriptions = capabilities.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema ? convertSchemaToJsonSchema(tool.inputSchema) : undefined,
        outputSchema: tool.outputSchema ? convertSchemaToJsonSchema(tool.outputSchema) : undefined,
        needsApproval: tool.needsApproval,
        server: !!tool.execute,
      }));
      const supportedHooks = fullLoopHooks;
      const middleware = capabilities.middleware.map((mw) => {
        const hooks: string[] = [];
        for (const [key, value] of Object.entries(mw)) {
          if (
            [
              "name",
              "routedSubagentPersistence",
              "requires",
              "provides",
              "optionalRequires",
            ].includes(key)
          )
            continue;
          if (!supportedHooks.has(key) || !(value instanceof Function))
            throw new Error(`Unsupported worker middleware member: ${key}`);
          hooks.push(key);
        }
        return {
          name: mw.name,
          hooks,
          routedPersistence: mw.routedSubagentPersistence
            ? Object.keys(mw.routedSubagentPersistence)
            : [],
        };
      });
      // A stable owner context preserves SDK WeakMap-backed middleware state and
      // capability values. Only snapshots cross the port; live values never do.
      const provided = new Set<any>();
      const declared = new Set(capabilities.middleware.flatMap((mw) => [...(mw.provides ?? [])]));
      for (const mw of capabilities.middleware)
        for (const required of mw.requires ?? []) {
          if (!declared.has(required))
            throw new Error(`Unprovided owner middleware capability: ${required.capabilityName}`);
        }
      const grants = OwnerToolGrants.makeOwnerToolGrants();
      const ownerContext: any = {
        requestId: randomUUID(),
        streamId: randomUUID(),
        runId: owner.capability.runId,
        threadId: owner.capability.sessionId,
        conversationId: owner.capability.sessionId,
        activity: "chat",
        provider: adapterName,
        model: adapterModel,
        source: "server",
        streaming: true,
        context: turn.context ?? {},
        systemPrompts: turn.systemPrompts ?? [],
        toolNames: capabilities.tools.map((tool) => tool.name),
        messages: convertMessagesToModelMessages(structuredClone(turn.messages ?? [])),
        parentRunId: turn.parentRunId,
        modelOptions: turn.modelOptions,
        messageCount: turn.messages?.length ?? 0,
        hasTools: capabilities.tools.length > 0,
        iteration: 0,
        chunkIndex: 0,
        phase: "init",
        currentMessageId: null,
        accumulatedContent: "",
        capabilities: {
          markProvided: (handle: any) => {
            provided.add(handle);
          },
          has: (handle: any) => provided.has(handle),
          setOnDuplicate: () => {},
        },
      };
      ownerContext.get = (handle: any) => handle[0](ownerContext);
      ownerContext.getOptional = (handle: any) => handle[0](ownerContext, { optional: true });
      ownerContext.provide = (handle: any, value: any) => handle[1](ownerContext, value);
      // Generic continuation requires preserving schema validation and Map-backed
      // resume state; do not downgrade it to JSON validation or silently replay.
      if (turn.resume?.length)
        throw new Error("Worker interrupt continuation is not yet supported");
      const definitions = (turn.interrupts ?? []).map((definition) => ({
        id: definition.id,
        payloadSchema: definition.payloadSchema?.["~standard"].jsonSchema.input({
          target: "draft-07",
        }),
        responseSchema: definition.responseSchema?.["~standard"].jsonSchema.input({
          target: "draft-07",
        }),
      }));
      // Definitions are reconstructed with the SDK in the worker. New interrupt
      // payloads have already passed the original owner's definition factory.
      const wireTurn = structuredClone({ ...turn, interrupts: definitions });
      // The SDK iterator owns this Scope across yields, including setup failures.
      const workerScope = Effect.runSync(Scope.make());
      const models = new Map<string, AsyncIterator<any>>();
      let closed = false;
      try {
        const { port1, port2 } = await Effect.runPromise(
          acquireFullLoopChannel().pipe(Effect.provideService(Scope.Scope, workerScope)),
        );
        // The worker strips non-serializable SDK services. Recreate them at the
        // owner instead of invoking native adapters with an absent logger/context.
        const ownerLogger = resolveDebugOption(false);
        const deferred: Promise<unknown>[] = [];
        const ownerConfig: any = {
          messages: ownerContext.messages,
          systemPrompts: ownerContext.systemPrompts,
          tools: capabilities.tools,
          modelOptions: turn.modelOptions,
        };
        const decisions = new Map<string, any>();
        const completedTools = new Map<string, any>();
        let modelIterations = 0;
        ownerContext.signal = controller.signal;
        ownerContext.abort = (reason = "owner middleware abort") => controller.abort(reason);
        ownerContext.emitCustomEvent = () => {};
        ownerContext.createId = (prefix: string) => `${prefix}-${randomUUID()}`;
        ownerContext.defer = (promise: Promise<unknown>) => deferred.push(promise);
        let finalizing = false;
        let terminalObserved = false;
        // Guard the actual owner implementation, not only worker RPC delivery.
        // Rebuild parallelReads around these guards: the incoming middleware closes
        // over its original unguarded tools and must never be invoked here.
        const boundaryTools = capabilities.tools.map((tool) => ({
          ...tool,
          __toolSide: "server" as const,
          execute: async (args: any, context: any) => {
            if (
              closed ||
              finalizing ||
              controller.signal.aborted ||
              !owner.permits(owner.capability)
            )
              throw new Error("Inactive owner tool implementation capability");
            grants.start({ name: tool.name, toolCallId: context?.toolCallId, args });
            return tool.execute!(args, context);
          },
        }));
        const parallelIndex = capabilities.middleware.findIndex(
          (mw) => mw.name === "memory-agent/parallel-reads",
        );
        const guardedParallel =
          parallelIndex < 0
            ? undefined
            : parallelReads(
                boundaryTools.map((tool) => {
                  const prepared = { ...tool };
                  // Owner permission preparation already schema-validated these arguments.
                  // Do not run potentially non-idempotent Standard Schema transforms twice.
                  if (tool.inputSchema)
                    prepared.inputSchema = convertSchemaToJsonSchema(tool.inputSchema);
                  return prepared;
                }),
                controller.signal,
              );
        const ownerTools = guardedParallel
          ? guardedParallel.tools.map((tool, index) => ({
              ...boundaryTools[index]!,
              execute: tool.execute!,
            }))
          : boundaryTools;
        const ownerMiddleware = capabilities.middleware.map((mw, index) =>
          index === parallelIndex ? guardedParallel!.middleware : mw,
        );
        ownerConfig.tools = ownerTools;
        const cleanupHooks = new Set(["onFinish", "onError", "onAbort"]);
        const finalizationInput = (wire: any) => {
          const input: any = decodeFullLoopValue(wire);
          return (
            finalizing &&
            !closed &&
            cleanupHooks.has(input.hook) &&
            owner.finalizationMiddleware?.includes(
              capabilities.middleware[input.index]?.name ?? "",
            ) === true &&
            middleware[input.index]?.hooks.includes(input.hook) === true
          );
        };
        const authorizeRequest = (operation: string, wire: OwnerRpcJson) => {
          const input: any = decodeFullLoopValue(wire);
          if (operation === "tool") return grants.validate(input);
          if (operation === "toolAuthorize") {
            try {
              const invocation = grants.observed(input);
              const tool = ownerTools.find((tool) => tool.name === invocation.name);
              // The inventory retains SDK needsApproval. Without owner-issued
              // approval continuation support, it cannot authorize execution.
              if (!tool?.execute || tool.needsApproval) return false;
              if (tool.inputSchema && isStandardSchema(tool.inputSchema))
                parseWithStandardSchema(tool.inputSchema, invocation.args);
              return true;
            } catch {
              return false;
            }
          }
          if (operation === "middleware") {
            if (
              !middleware[input.index]?.hooks.includes(input.hook) ||
              input.hook === "onBeforeToolCall"
            )
              return false;
            if (input.hook === "onAfterToolCall") {
              const completed = completedTools.get(input.info?.toolCallId);
              if (
                !completed ||
                input.info.toolName !== completed.toolName ||
                !isDeepStrictEqual(input.info.toolCall, completed.toolCall)
              )
                return false;
            }
            if (input.hook === "onToolPhaseComplete") {
              if (
                !Array.isArray(input.info?.toolCalls) ||
                input.info.toolCalls.some(
                  (call: any) =>
                    !grants.toolCalls().some((observed) => isDeepStrictEqual(observed, call)),
                )
              )
                return false;
            }
            const snapshot = input.context;
            if (
              !snapshot ||
              snapshot.runId !== ownerContext.runId ||
              snapshot.threadId !== ownerContext.threadId ||
              !isDeepStrictEqual(snapshot.context, turn.context ?? {}) ||
              snapshot.provider !== adapterName ||
              snapshot.model !== adapterModel ||
              snapshot.source !== "server"
            )
              return false;
          }
          return true;
        };
        await Effect.runPromise(
          acquireFullLoopEndpoint(port1, {
            permits: (capability) => !closed && !finalizing && owner.permits(capability),
            permitsFinalization: (capability) =>
              !closed && finalizing && owner.permitsFinalization?.(capability) === true,
            ledger: owner.ledger,
            handlers: {
              modelOpen: {
                sideEffect: false,
                execute: async (input: any) => {
                  input = decodeFullLoopValue(input);
                  const id = randomUUID();
                  ownerContext.iteration = modelIterations++;
                  ownerContext.accumulatedContent = "";
                  ownerContext.currentMessageId = null;
                  ownerContext.phase = "modelStream";
                  models.set(
                    id,
                    chatStream({
                      ...input,
                      // Model configuration comes from the owner lifecycle, not
                      // a worker's claim about canonical messages or SDK services.
                      messages: structuredClone(ownerContext.messages),
                      systemPrompts: structuredClone(ownerContext.systemPrompts),
                      modelOptions: ownerConfig.modelOptions,
                      logger: ownerLogger,
                      capabilities: ownerContext,
                      runId: owner.capability.runId,
                      threadId: owner.capability.sessionId,
                      parentRunId: turn.parentRunId,
                      approvals: new Map(input.approvals ?? []),
                      abortController: controller,
                      request: { signal: controller.signal },
                    })[Symbol.asyncIterator](),
                  );
                  return json({ id });
                },
              },
              modelNext: {
                sideEffect: false,
                execute: async (input: any) => {
                  input = decodeFullLoopValue(input);
                  const iterator = models.get(input.id);
                  if (!iterator) throw new Error("Unknown owner model stream");
                  const next = await iterator.next();
                  if (next.done) {
                    models.delete(input.id);
                    ownerContext.phase = "afterModel";
                  } else {
                    grants.observe(next.value);
                    if (next.value.type === "TOOL_CALL_END") {
                      const observed = grants.toolCalls();
                      const existing = new Set(
                        ownerContext.messages.flatMap((message: any) =>
                          (message.toolCalls ?? []).map((call: any) => call.id),
                        ),
                      );
                      const fresh = observed.filter((call) => !existing.has(call.id));
                      const last = ownerContext.messages.at(-1);
                      if (last?.role === "assistant" && last.toolCalls)
                        last.toolCalls.push(...fresh);
                      else
                        ownerContext.messages.push({
                          role: "assistant",
                          content: "",
                          toolCalls: fresh,
                        });
                    }
                    ownerContext.chunkIndex++;
                    if (next.value.type === "REASONING_MESSAGE_START") {
                      ownerContext.messages.push({
                        role: "assistant",
                        content: "",
                        thinking: [{ content: "" }],
                      });
                    }
                    if (next.value.type === "REASONING_MESSAGE_CONTENT") {
                      const thinking = ownerContext.messages.at(-1)?.thinking?.at(-1);
                      if (thinking) thinking.content += next.value.delta;
                    }
                    if (next.value.type === "TEXT_MESSAGE_START") {
                      ownerContext.currentMessageId = next.value.messageId;
                      ownerContext.messages.push({ role: "assistant", content: "" });
                    }
                    if (next.value.type === "TEXT_MESSAGE_CONTENT") {
                      ownerContext.accumulatedContent += next.value.delta;
                      const last = ownerContext.messages.at(-1);
                      if (last?.role === "assistant") last.content += next.value.delta;
                    }
                  }
                  return json({ done: !!next.done, value: next.done ? null : next.value });
                },
              },
              toolAuthorize: {
                sideEffect: true,
                authorize: (wire) => authorizeRequest("toolAuthorize", wire),
                execute: async (wire: any) => {
                  const invocation = grants.observed(decodeFullLoopValue(wire));
                  const tool = ownerTools.find((tool) => tool.name === invocation.name);
                  if (!tool?.execute || tool.needsApproval)
                    throw new Error("Unsupported owner approval tool");
                  const events: any[] = [];
                  ownerContext.emitCustomEvent = (name: string, value: any, options: any) =>
                    events.push({ name, value, options });
                  ownerContext.phase = "beforeTools";
                  const parallel = ownerMiddleware.find(
                    (mw) => mw.name === "memory-agent/parallel-reads",
                  );
                  const observed = grants.toolCalls();
                  const prefix = [];
                  for (const call of observed) {
                    if (!readOnlyToolNames.has(call.function.name)) break;
                    prefix.push(call);
                  }
                  const candidates =
                    parallel && prefix.some((call) => call.id === invocation.toolCallId)
                      ? prefix
                      : observed.filter((call) => call.id === invocation.toolCallId);
                  // Evaluate every prefetched read's permission chain BEFORE parallelReads
                  // can start any implementation. A worker snapshot cannot inject peers.
                  for (const call of candidates) {
                    if (decisions.has(call.id)) continue;
                    const definition = ownerTools.find((tool) => tool.name === call.function.name);
                    if (!definition?.execute || definition.needsApproval)
                      throw new Error("Unsupported owner approval tool");
                    const raw = JSON.parse(call.function.arguments);
                    let args = raw;
                    if (definition.inputSchema && isStandardSchema(definition.inputSchema))
                      args = parseWithStandardSchema(definition.inputSchema, args);
                    const info = {
                      toolCall: call,
                      tool: definition,
                      args,
                      toolName: call.function.name,
                      toolCallId: call.id,
                    };
                    let decision: any;
                    for (const mw of ownerMiddleware) {
                      if (mw === parallel) continue;
                      decision = await mw.onBeforeToolCall?.(ownerContext, info);
                      if (decision != null) break;
                    }
                    if (controller.signal.aborted) decision = { type: "abort" };
                    if (decision == null) decision = { type: "transformArgs", args };
                    switch (decision.type) {
                      case "transformArgs":
                        grants.approve(
                          { name: call.function.name, toolCallId: call.id, args: raw },
                          decision.args,
                        );
                        break;
                      case "skip":
                        completedTools.set(call.id, {
                          toolCallId: call.id,
                          toolName: call.function.name,
                          toolCall: call,
                          tool: definition,
                          ok: true,
                          duration: 0,
                          result: decision.result,
                        });
                        ownerContext.messages.push({
                          role: "tool",
                          toolCallId: call.id,
                          content: Schema.is(Schema.String)(decision.result)
                            ? decision.result
                            : JSON.stringify(decision.result),
                        });
                        break;
                      case "abort":
                        break;
                      default:
                        throw new Error("Unsupported owner tool decision");
                    }
                    decisions.set(call.id, decision);
                  }
                  const decision = decisions.get(invocation.toolCallId);
                  if (parallel && decision?.type === "transformArgs") {
                    const approved = candidates
                      .filter((call) => decisions.get(call.id)?.type === "transformArgs")
                      .map((call) => ({
                        ...call,
                        function: {
                          ...call.function,
                          arguments: JSON.stringify(decisions.get(call.id).args),
                        },
                      }));
                    const saved = ownerContext.messages;
                    ownerContext.messages = [
                      ...saved.filter(
                        (message: any) => message.role !== "assistant" || !message.toolCalls,
                      ),
                      { role: "assistant", content: "", toolCalls: approved },
                    ];
                    try {
                      await parallel.onBeforeToolCall?.(ownerContext, {
                        toolCall: observed.find((call) => call.id === invocation.toolCallId)!,
                        tool,
                        args: decision.args,
                        toolName: invocation.name,
                        toolCallId: invocation.toolCallId,
                      });
                    } finally {
                      ownerContext.messages = saved;
                    }
                  }
                  return json({ decision, events });
                },
              },
              tool: {
                sideEffect: true,
                authorize: (wire) => authorizeRequest("tool", wire),
                execute: async (input: any) => {
                  input = grants.consume(decodeFullLoopValue(input));
                  const tool = ownerTools.find((tool) => tool.name === input.name);
                  if (!tool?.execute) throw new Error("Unknown owner tool");
                  const args = input.args;
                  const events: any[] = [];
                  const value = await tool.execute(args, {
                    context: turn.context,
                    toolCallId: input.toolCallId ?? undefined,
                    abortSignal: controller.signal,
                    emitCustomEvent: (name: string, value: any, options: any) => {
                      events.push({ name, value, options });
                    },
                  });
                  completedTools.set(input.toolCallId, {
                    toolCallId: input.toolCallId,
                    toolName: input.name,
                    toolCall: grants.toolCalls().find((call) => call.id === input.toolCallId),
                    tool,
                    ok: true,
                    duration: 0,
                    result: value,
                  });
                  ownerContext.messages.push({
                    role: "tool",
                    toolCallId: input.toolCallId,
                    content: Schema.is(Schema.String)(value) ? value : JSON.stringify(value),
                  });
                  return json({ value, events });
                },
              },
              routedPersistence: {
                sideEffect: true,
                execute: async (input: any) => {
                  input = decodeFullLoopValue(input);
                  const mw = ownerMiddleware[input.index];
                  if (
                    !mw?.routedSubagentPersistence ||
                    !middleware[input.index]?.routedPersistence.includes(input.method)
                  )
                    throw new Error("Invalid routed persistence capability");
                  const method = Object.entries(mw.routedSubagentPersistence).find(
                    ([key]) => key === input.method,
                  )?.[1];
                  if (!(method instanceof Function))
                    throw new Error("Invalid routed persistence method");
                  await method.call(mw.routedSubagentPersistence, input.value);
                  return json(null);
                },
              },
              strategy: {
                sideEffect: false,
                execute: async (input: any) => {
                  input = decodeFullLoopValue(input);
                  return json(
                    capabilities.model.agentLoopStrategy
                      ? capabilities.model.agentLoopStrategy(input)
                      : input.iterationCount < 5,
                  );
                },
              },
              middleware: {
                sideEffect: true,
                authorize: (wire) => authorizeRequest("middleware", wire),
                finalization: finalizationInput,
                execute: async (input: any) => {
                  input = decodeFullLoopValue(input);
                  const mw = ownerMiddleware[input.index];
                  if (
                    (terminalObserved || controller.signal.aborted) &&
                    cleanupHooks.has(input.hook) &&
                    owner.finalizationMiddleware?.includes(mw?.name ?? "") &&
                    owner.permitsFinalization?.(owner.capability)
                  )
                    finalizing = true;
                  if (!mw || !middleware[input.index]?.hooks.includes(input.hook))
                    throw new Error("Unknown middleware hook");
                  const phases = new Map<string, ChatMiddlewareContext["phase"]>(
                    Object.entries({
                      setup: "init",
                      onStart: "init",
                      onIteration: "beforeModel",
                      onBeforeToolCall: "beforeTools",
                      onAfterToolCall: "afterTools",
                      onConfig: modelIterations === 0 ? "init" : "beforeModel",
                    } satisfies Record<string, ChatMiddlewareContext["phase"]>),
                  );
                  ownerContext.phase = phases.get(input.hook) ?? ownerContext.phase;
                  if (input.hook === "onInterruptBoundary") {
                    const answered = new Set(
                      ownerContext.messages
                        .filter((message: any) => message.role === "tool")
                        .map((message: any) => message.toolCallId),
                    );
                    ownerContext.phase = grants.toolCalls().some((call) => !answered.has(call.id))
                      ? "beforeTools"
                      : "beforeModel";
                  }
                  const events: any[] = [];
                  let abort: string | null = null;
                  const ctx = Object.assign(ownerContext, {
                    context: turn.context ?? {},
                    signal: controller.signal,
                    abort: (reason = "owner middleware abort") => {
                      abort = reason;
                      controller.abort(reason);
                    },
                    emitCustomEvent: (
                      name: string,
                      value: Parameters<ChatMiddlewareContext["emitCustomEvent"]>[1],
                      options?: Parameters<ChatMiddlewareContext["emitCustomEvent"]>[2],
                    ) => events.push({ name, value, options }),
                    createId: (prefix: string) => `${prefix}-${randomUUID()}`,
                    defer: (promise: Promise<unknown>) => {
                      deferred.push(promise);
                    },
                  });
                  let info = input.info;
                  if (input.hook === "onAfterToolCall")
                    info = completedTools.get(input.info.toolCallId);
                  if (input.hook === "onToolPhaseComplete")
                    info = {
                      toolCalls: input.info.toolCalls.map((call: any) =>
                        grants.toolCalls().find((observed) => observed.id === call.id),
                      ),
                      results: input.info.toolCalls.flatMap((call: any) =>
                        completedTools.has(call.id) ? [completedTools.get(call.id)] : [],
                      ),
                      needsApproval: [],
                      needsClientExecution: [],
                    };
                  if (input.hook === "onIteration")
                    info = {
                      iteration: ownerContext.iteration,
                      messageId: ownerContext.currentMessageId,
                    };
                  if (input.hook === "onConfig")
                    info = {
                      ...ownerConfig,
                      messages: ownerContext.messages,
                      systemPrompts: ownerContext.systemPrompts,
                      tools: ownerTools,
                    };
                  const hook = Object.entries(mw).find(([key]) => key === input.hook)?.[1];
                  if (!(hook instanceof Function)) throw new Error("Invalid owner middleware hook");
                  const result = await hook.call(mw, ctx, info);
                  if (input.hook === "setup")
                    for (const handle of mw.provides ?? []) {
                      if (!handle.has(ctx))
                        throw new Error(`Owner setup did not provide ${handle.capabilityName}`);
                    }
                  if (result?.tools)
                    throw new Error("Worker middleware cannot replace owner tool capabilities");
                  if (input.hook === "onConfig" && result) {
                    Object.assign(ownerConfig, result);
                    if (result.messages) ownerContext.messages = result.messages;
                    if (result.systemPrompts) ownerContext.systemPrompts = result.systemPrompts;
                  }
                  return json({
                    result: result ?? null,
                    void: result === undefined,
                    abort,
                    events,
                  });
                },
              },
            },
          }).pipe(Effect.provideService(Scope.Scope, workerScope)),
        );
        const worker = await Effect.runPromise(
          acquireFullLoopWorker(
            owner.workerUrl ?? new URL("./full-loop-worker.ts", import.meta.url),
            {
              workerData: {
                port: port2,
                capability: owner.capability,
                lastOperationId: owner.lastOperationId,
                turn: wireTurn,
                tools: toolDescriptions,
                middleware,
                adapter: { name: adapterName, model: adapterModel },
              },
              transferList: [port2],
            },
            owner,
          ).pipe(Effect.provideService(Scope.Scope, workerScope)),
        );
        owner.onWorker?.(worker);
        const queue = await Effect.runPromise(
          acquireFullLoopWorkerEvents(worker, controller.signal).pipe(
            Effect.provideService(Scope.Scope, workerScope),
          ),
        );
        while (true) {
          const frame = await Effect.runPromise(Queue.take(queue));
          switch (frame.type) {
            case "chunk": {
              // SAFETY: The decoded chunk envelope comes from the owner-selected SDK worker;
              // its SDK iterator owns the StreamChunk payload contract (not this transport schema).
              const chunk = frame.chunk as StreamChunk;
              if (finalizing || !owner.permits(owner.capability))
                throw new Error("Inactive owner chunk capability");
              if (chunk.type === "RUN_FINISHED" || chunk.type === "RUN_ERROR")
                terminalObserved = true;
              yield chunk;
              worker.postMessage({ type: "ack" });
              break;
            }
            case "aborted":
              // The owner ended the pull without SDK terminal acknowledgement.
              // Surface uncertainty so AgentChat records failure instead of leaving
              // a stopped run marked running or silently treating it as successful.
              throw new WorkerLifecycleError({
                operation: "cancel",
                cause: new Error("Worker cancellation outcome unacknowledged; no replay"),
              });
            case "done":
              await Promise.all(deferred);
              return;
            case "failed":
              throw new Error(
                "SDK loop worker failed; owner effects may be uncertain; no replay performed",
              );
          }
        }
      } finally {
        closed = true;
        await Effect.runPromise(
          Effect.sync(() => owner.revoke?.()).pipe(
            Effect.ensuring(Effect.sync(() => controller.abort())),
            Effect.ensuring(Scope.close(workerScope, Exit.void)),
            Effect.ensuring(
              Effect.sync(() => {
                // SDK iterators may have an outstanding non-interruptible next().
                // Do not await return() and deadlock worker lease release on that SDK boundary.
                for (const iterator of models.values()) void iterator.return?.().catch(() => {});
              }),
            ),
          ),
        );
      }
    },
  };
}
