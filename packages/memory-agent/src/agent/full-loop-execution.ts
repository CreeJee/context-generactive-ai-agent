import { NodeWorker } from "@effect/platform-node";
import { referenceIds } from "../runtime/reference-ids.ts";
import { nativePromise, runNativeEffect } from "../runtime/native-effect.ts";
import { runtimeWorkerOptions } from "../runtime/resources.ts";
import { nativeStream } from "../runtime/native-stream.ts";
import { Cause, Stream, Result, Function as EffectFunction } from "effect";
import { RpcClient, RpcServer } from "effect/rpc";
import { isTruthy } from "../truthy.ts";
import { Worker } from "node:worker_threads";
import { acquireFullLoopChannel, WorkerLifecycleError } from "./full-loop-resources.ts";
import { parallelReads, readOnlyToolNames } from "../tools/parallel-reads.ts";
// Run-local observation ledger, not an Effect contextual service constructor.
import * as OwnerToolGrants from "./owner-tool-grants.ts";
import {
  Equal,
  HashMap,
  HashSet,
  MutableHashMap,
  MutableHashSet,
  Option,
  Effect,
  Exit,
  Layer,
  Schema,
  Scope,
} from "effect";
// Pure owner domain constructor used behind the contextual RPC server Layer below.
// oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports
import { makeOwnerRpcEffect, type OwnerRpcPermits } from "./owner-rpc.ts";
import {
  FullLoopOwnerRpcGroup,
  FullLoopRpcError,
  FullLoopRpcGroup,
} from "./full-loop-effect-rpc.ts";
import { layerMessagePortRpcServer } from "./effect-rpc-message-port.ts";

import { randomUUID } from "../runtime/synchronous-crypto.ts";
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
import type { ExecutionAdmission } from "../runtime/execution-admission.ts";
import {
  pullModelChunk,
  type OwnerModelStream,
  type ProviderRetryOwner,
} from "./full-loop-provider-retry.ts";
import {
  assertFullLoopPortable,
  FullLoopAdmissionRejected,
  reject,
} from "./full-loop-admission-preflight.ts";

/**
 * The owner refused a worker request or stopped its own run: the capability was revoked, or the
 * worker named a stream, tool, hook or decision the owner never issued. The worker sees it as the
 * rejection of its owner call; nothing here carries model, tool or provider text.
 */
export class FullLoopOwnerRefused extends Schema.TaggedError<FullLoopOwnerRefused>()(
  "FullLoopOwnerRefused",
  {
    reason: Schema.Union([
      /** The owner capability was revoked or the run is finalizing. */
      Schema.TaggedStruct("Inactive", { stage: Schema.Literals(["run", "tool", "chunk"]) }),
      Schema.TaggedStruct("UnknownModelStream", {}),
      Schema.TaggedStruct("UnsupportedApprovalTool", {}),
      Schema.TaggedStruct("UnsupportedToolDecision", {}),
      Schema.TaggedStruct("UnknownTool", {}),
      Schema.TaggedStruct("InvalidRoutedPersistence", {}),
      Schema.TaggedStruct("UnknownMiddlewareHook", {}),
      Schema.TaggedStruct("UnobservedToolPhaseCall", {}),
      /** A middleware's setup did not provide a capability it declares. */
      Schema.TaggedStruct("SetupCapabilityMissing", {}),
      /** A middleware result tried to replace the owner's tools. */
      Schema.TaggedStruct("ToolReplacement", {}),
    ]),
  },
) {}
const refused = (reason: FullLoopOwnerRefused["reason"]) => FullLoopOwnerRefused.make({ reason });

// Descriptor inspection rejects accessors without invoking owner-supplied getters.
function ownerData<T extends object>(value: T): T {
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!isTruthy(descriptor) || descriptor.get !== undefined || descriptor.set !== undefined)
      throw FullLoopAdmissionRejected.make({
        member: "owner snapshot",
        reason: { _tag: "Accessor" },
      });
  }
  // All own string/symbol accessors were rejected above. Object.assign retains the
  // SDK-derived structural type; descriptor copying also retains non-enumerable data.
  const snapshot = Object.assign({}, value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!isTruthy(descriptor) || descriptor.get !== undefined || descriptor.set !== undefined)
      throw FullLoopAdmissionRejected.make({
        member: "owner snapshot",
        reason: { _tag: "Accessor" },
      });
    Object.defineProperty(snapshot, key, { ...descriptor, writable: true, configurable: true });
  }
  return snapshot;
}

// Plain configuration only: SDK schemas/capability handles stay owner services.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
function ownerConfigSnapshot(value: unknown): any {
  assertFullLoopPortable({ value, member: "owner configuration" });
  return decodeFullLoopValue(encodeFullLoopValue(value));
}

// Reflection boundary: SDK receivers may be class instances with inherited methods.
// This inspects data descriptors, not a domain/service object contract.
// oxlint-disable-next-line anti-slop/no-object-parameters
function ownerMember(receiver: object, key: string): any {
  for (let current = receiver; current; current = Object.getPrototypeOf(current)) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (!isTruthy(descriptor)) continue;
    if (descriptor.get !== undefined || descriptor.set !== undefined)
      throw FullLoopAdmissionRejected.make({ member: key, reason: { _tag: "Accessor" } });
    return descriptor.value;
  }
  throw FullLoopAdmissionRejected.make({ member: key, reason: { _tag: "MissingMember" } });
}

// Same descriptor-reflection boundary; bind the captured callable to its original
// SDK receiver without freezing or copying that receiver's mutable state.
// oxlint-disable-next-line anti-slop/no-object-parameters
function ownerMethod(receiver: object, key: string): any {
  const method = ownerMember(receiver, key);
  if (!(method instanceof Function))
    throw FullLoopAdmissionRejected.make({ member: key, reason: { _tag: "NotCallable" } });
  return method.bind(receiver);
}
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import type { OwnerRpcCapability, OwnerRpcJson, OwnerRpcLedger } from "./owner-rpc.ts";
import { encodeFullLoopValue, decodeFullLoopValue } from "./full-loop-codec.ts";
import {
  fullLoopHooks,
  preflightFullLoopExecution as basePreflight,
} from "./full-loop-preflight.ts";

export const preflightFullLoopExecution: {
  <TAdapter extends AnyTextAdapter>(
    capabilities: ChatExecutionCapabilities<TAdapter>,
  ): (
    turn: ChatExecutionTurn<TAdapter>,
  ) => ReturnType<typeof preflightFullLoopExecutionBody<TAdapter>>;
} & typeof preflightFullLoopExecutionBody = EffectFunction.dual(2, preflightFullLoopExecutionBody);
function preflightFullLoopExecutionBody<TAdapter extends AnyTextAdapter>(
  turn: ChatExecutionTurn<TAdapter>,
  capabilities: ChatExecutionCapabilities<TAdapter>,
): void {
  basePreflight(turn, capabilities);
  const names = MutableHashSet.empty<string>();
  for (const tool of capabilities.tools) {
    if (!isTruthy(tool.execute) || MutableHashSet.has(names, tool.name))
      throw FullLoopAdmissionRejected.make({
        member: tool.name,
        reason: { _tag: "UnsupportedTool" },
      });
    MutableHashSet.add(names, tool.name);
  }
}

/** Admission and high-water allocation belong to the central owner, never the worker. */
export interface FullLoopOwner {
  readonly admission: ExecutionAdmission["Service"];
  readonly capability: OwnerRpcCapability;
  readonly ledger: OwnerRpcLedger;
  readonly permits: OwnerRpcPermits;
  readonly permitsFinalization?: OwnerRpcPermits;
  /** Explicit owner-approved cleanup middleware names; never worker-selected grants. */
  readonly finalizationMiddleware?: readonly string[];
  readonly revoke?: () => void;
  readonly lastOperationId: number;
  readonly workerUrl: URL;
  readonly onWorker?: (worker: Worker) => void;
  /** Owner-only asset lease, taken right before the Worker is constructed. */
  readonly acquireWorkerLease?: Effect.Effect<void, Cause.YieldableError>;
  /** Releases the lease; runs only after the actual Worker terminates, or if none was built. */
  readonly onWorkerStopped?: () => void;
  /** Durable waits before resending a provider request that was never sent. */
  readonly providerRetry?: ProviderRetryOwner;
}

// SDK values cross a JSON capability boundary, not a database/object-identity boundary.
// Serialization is the boundary parser; domain SDK values vary by hook and adapter.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
const json = (value: unknown): OwnerRpcJson => encodeFullLoopValue(value);
const stringify = EffectFunction.flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)),
  Result.getOrThrow,
);
const parseToolJson = EffectFunction.flow(
  Schema.decodeResult(Schema.fromJsonString(Schema.Unknown)),
  Result.getOrThrow,
);

/** Complete SDK loop in worker_threads. No worker restart or operation replay is performed.
 * Unsupported object-identity SDK capabilities are rejected before worker admission.
 */
export function createFullLoopExecution<TAdapter extends AnyTextAdapter>(owner: FullLoopOwner) {
  return {
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    execute(
      turn: ChatExecutionTurn<TAdapter>,
      capabilities: ChatExecutionCapabilities<TAdapter>,
    ): AsyncGenerator<StreamChunk> {
      return nativeStream(
        Stream.fromPull(
          Effect.gen(function* () {
            const adapter = capabilities.model.adapter;
            const controller = capabilities.stream.abortController;
            const releaseWorkerAdmission = yield* owner.admission.acquire("worker");
            yield* Effect.addFinalizer(() => releaseWorkerAdmission);
            if (!(yield* owner.permits(owner.capability)))
              return yield* refused({ _tag: "Inactive", stage: "run" });
            if (controller.signal.aborted) return { pull: Cause.done() };
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
                    isTruthy(tool.inputSchema) && !isStandardSchema(tool.inputSchema)
                      ? ownerConfigSnapshot(tool.inputSchema)
                      : tool.inputSchema,
                  outputSchema:
                    isTruthy(tool.outputSchema) && !isStandardSchema(tool.outputSchema)
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
                  if (isTruthy(mw[key])) Reflect.set(mw, key, [...mw[key]!]);
                if (isTruthy(mw.routedSubagentPersistence)) {
                  const persistence = original.routedSubagentPersistence!;
                  const captured = ownerData(persistence);
                  for (const [key, method] of Object.entries(captured))
                    if (method instanceof Function)
                      Reflect.set(captured, key, method.bind(persistence));
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
              inputSchema: isTruthy(tool.inputSchema)
                ? convertSchemaToJsonSchema(tool.inputSchema)
                : undefined,
              outputSchema: isTruthy(tool.outputSchema)
                ? convertSchemaToJsonSchema(tool.outputSchema)
                : undefined,
              needsApproval: tool.needsApproval,
              server: !!isTruthy(tool.execute),
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
                if (!HashSet.has(supportedHooks, key) || !(value instanceof Function))
                  reject(key, "UnsupportedMiddlewareMember");
                hooks.push(key);
              }
              return {
                name: mw.name,
                hooks,
                routedPersistence: isTruthy(mw.routedSubagentPersistence)
                  ? Object.keys(mw.routedSubagentPersistence)
                  : [],
              };
            });
            // A stable owner context preserves SDK WeakMap-backed middleware state and
            // capability values. Only snapshots cross the port; live values never do.
            const capabilityId =
              referenceIds<
                NonNullable<(typeof capabilities.middleware)[number]["provides"]>[number]
              >();
            const provided = MutableHashSet.empty<number>();
            const declared = HashSet.fromIterable(
              capabilities.middleware.flatMap((mw) => [...(mw.provides ?? [])].map(capabilityId)),
            );
            for (const mw of capabilities.middleware)
              for (const required of mw.requires ?? []) {
                if (!HashSet.has(declared, capabilityId(required)))
                  reject(required.capabilityName, "UnprovidedCapability");
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
              resume: turn.resume,
              messageCount: turn.messages?.length ?? 0,
              hasTools: capabilities.tools.length > 0,
              iteration: 0,
              chunkIndex: 0,
              phase: "init",
              currentMessageId: null,
              accumulatedContent: "",
              capabilities: {
                markProvided: (handle: any) => {
                  MutableHashSet.add(provided, capabilityId(handle));
                },
                has: (handle: any) => MutableHashSet.has(provided, capabilityId(handle)),
                setOnDuplicate: () => {},
              },
            };
            ownerContext.get = (handle: any) => handle[0](ownerContext);
            ownerContext.getOptional = (handle: any) => handle[0](ownerContext, { optional: true });
            ownerContext.provide = (handle: any, value: any) => handle[1](ownerContext, value);
            // Owner persistence validates resumed responses with its original schemas.
            // The tagged codec preserves the resulting SDK Map/Set state in the worker.
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
            const workerScope = Scope.makeUnsafe();
            const models = MutableHashMap.empty<string, OwnerModelStream>();
            let closed = false;
            let terminalObserved = false;
            let runningWorker: Worker | undefined;
            yield* Effect.addFinalizer(() =>
              Effect.suspend(() => {
                closed = true;
                return Effect.sync(() => owner.revoke?.()).pipe(
                  Effect.ensuring(Effect.sync(() => controller.abort())),
                  // A stopped native SDK pull cannot acknowledge graceful worker shutdown.
                  // Revoke first, then await actual termination before releasing the Scope/lease.
                  Effect.ensuring(
                    Effect.suspend(() =>
                      !terminalObserved && runningWorker !== undefined
                        ? Effect.tryPromise({
                            try: () => runningWorker!.terminate(),
                            catch: (cause) =>
                              WorkerLifecycleError.make({ operation: "terminate", cause }),
                          }).pipe(
                            Effect.asVoid,
                            // Best effort: the Worker's own exit still releases the lease.
                            Effect.catch((error) =>
                              Effect.logWarning("Goal worker termination failed", {
                                error: error._tag,
                                operation: error.operation,
                              }),
                            ),
                          )
                        : Effect.void,
                    ),
                  ),
                  Effect.ensuring(Scope.close(workerScope, Exit.void)),
                  Effect.ensuring(
                    Effect.sync(() => {
                      // Native SDK next() may be uncancellable; awaiting return() can deadlock the worker lease.
                      for (const model of MutableHashMap.values(models))
                        void model.iterator.return?.().catch(() => {});
                    }),
                  ),
                );
              }),
            );
            const { port1, port2 } = yield* acquireFullLoopChannel().pipe(
              Effect.provideService(Scope.Scope, workerScope),
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
              resume: turn.resume,
              parentRunId: turn.parentRunId,
            };
            const decisions = MutableHashMap.empty<string, any>();
            const completedTools = MutableHashMap.empty<string, any>();
            const resumedApproval = (toolCallId: string) => {
              const approval = ownerConfig.resumeToolState?.approvals?.get(toolCallId);
              return approval === true || approval?.approved === true;
            };
            const phaseCall = (call: any) => {
              const observed = grants.toolCalls().find((entry) => Equal.equals(entry, call));
              if (isTruthy(observed)) return observed;
              if (!isTruthy(ownerConfig.resumeToolState?.cancelledToolCallIds?.has(call.id)))
                return undefined;
              return ownerContext.messages
                .flatMap((message: any) => message.toolCalls ?? [])
                .find((entry: any) => Equal.equals(entry, call));
            };
            const configuredMiddleware = MutableHashSet.empty<number>();
            const firstConfigMiddleware = middleware.findIndex((mw) =>
              mw.hooks.includes("onConfig"),
            );
            let modelIterations = 0;
            ownerContext.signal = controller.signal;
            ownerContext.abort = (reason = "owner middleware abort") => controller.abort(reason);
            ownerContext.emitCustomEvent = () => {};
            ownerContext.createId = (prefix: string) => `${prefix}-${randomUUID()}`;
            ownerContext.defer = (promise: Promise<unknown>) => deferred.push(promise);
            let finalizing = false;
            // Guard the actual owner implementation, not only worker RPC delivery.
            // Rebuild parallelReads around these guards: the incoming middleware closes
            // over its original unguarded tools and must never be invoked here.
            const boundaryTools = capabilities.tools.map((tool) => ({
              ...tool,
              __toolSide: "server" as const,
              // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
              execute: (args: any, context: any) =>
                runNativeEffect(
                  Effect.gen(function* () {
                    if (
                      closed ||
                      finalizing ||
                      controller.signal.aborted ||
                      !(yield* owner.permits(owner.capability))
                    )
                      return yield* refused({ _tag: "Inactive", stage: "tool" });
                    grants.start({ name: tool.name, toolCallId: context?.toolCallId, args });
                    return yield* owner.admission.run(
                      "tool",
                      nativePromise(() => Promise.resolve(tool.execute!(args, context))),
                    );
                  }),
                ),
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
                      if (isTruthy(tool.inputSchema))
                        prepared.inputSchema = convertSchemaToJsonSchema(tool.inputSchema);
                      return prepared;
                    }),
                    controller.signal,
                  );
            const ownerTools =
              guardedParallel !== undefined
                ? guardedParallel.tools.map((tool, index) => ({
                    ...boundaryTools[index]!,
                    execute: tool.execute!,
                  }))
                : boundaryTools;
            const ownerMiddleware = capabilities.middleware.map((mw, index) =>
              index === parallelIndex ? guardedParallel!.middleware : mw,
            );
            ownerConfig.tools = ownerTools;
            const cleanupHooks = HashSet.fromIterable(["onFinish", "onError", "onAbort"]);
            const finalizationInput = (wire: any) => {
              const input: any = decodeFullLoopValue(wire);
              return (
                finalizing &&
                !closed &&
                HashSet.has(cleanupHooks, input.hook) &&
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
                  if (
                    !isTruthy(tool?.execute) ||
                    (isTruthy(tool.needsApproval) && !resumedApproval(invocation.toolCallId))
                  )
                    return false;
                  if (isTruthy(tool.inputSchema) && isStandardSchema(tool.inputSchema))
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
                  const completed = Option.getOrUndefined(
                    MutableHashMap.get(completedTools, input.info?.toolCallId),
                  );
                  if (
                    !isTruthy(completed) ||
                    input.info.toolName !== completed.toolName ||
                    !Equal.equals(input.info.toolCall, completed.toolCall)
                  )
                    return false;
                }
                if (input.hook === "onToolPhaseComplete") {
                  if (
                    !Array.isArray(input.info?.toolCalls) ||
                    isTruthy(input.info.toolCalls.some((call: any) => !isTruthy(phaseCall(call))))
                  )
                    return false;
                }
                const snapshot = input.context;
                if (
                  !isTruthy(snapshot) ||
                  snapshot.runId !== ownerContext.runId ||
                  snapshot.threadId !== ownerContext.threadId ||
                  !Equal.equals(snapshot.context, turn.context ?? {}) ||
                  snapshot.provider !== adapterName ||
                  snapshot.model !== adapterModel ||
                  snapshot.source !== "server"
                )
                  return false;
              }
              return true;
            };
            const ownerEndpointOptions = {
              permits: (capability: OwnerRpcCapability) =>
                !closed && !finalizing ? owner.permits(capability) : Effect.succeed(false),
              permitsFinalization: (capability: OwnerRpcCapability) =>
                !closed && finalizing && owner.permitsFinalization !== undefined
                  ? owner.permitsFinalization(capability)
                  : Effect.succeed(false),
              ledger: owner.ledger,
              handlers: {
                modelOpen: {
                  sideEffect: false,
                  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
                  execute: (input: any) =>
                    runNativeEffect(
                      Effect.sync(() => {
                        input = decodeFullLoopValue(input);
                        const id = randomUUID();
                        ownerContext.iteration = modelIterations++;
                        ownerContext.accumulatedContent = "";
                        ownerContext.currentMessageId = null;
                        ownerContext.phase = "modelStream";
                        const request = {
                          ...input,
                          // Model configuration comes from the owner lifecycle, not
                          // a worker's claim about canonical messages or SDK services.
                          messages: structuredClone(
                            ownerConfig.providerMessages ?? ownerContext.messages,
                          ),
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
                        };
                        // A resent request carries exactly what the provider never received.
                        const open = () =>
                          chatStream({
                            ...request,
                            messages: structuredClone(request.messages),
                            systemPrompts: structuredClone(request.systemPrompts),
                            approvals: new Map(request.approvals),
                          })[Symbol.asyncIterator]();
                        MutableHashMap.set(models, id, {
                          iterator: open(),
                          open,
                          delivered: false,
                        });
                        return json({ id });
                      }),
                    ),
                },
                modelNext: {
                  sideEffect: false,
                  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
                  execute: (input: any) =>
                    runNativeEffect(
                      Effect.gen(function* () {
                        input = decodeFullLoopValue(input);
                        const model = Option.getOrUndefined(MutableHashMap.get(models, input.id));
                        if (!isTruthy(model)) return yield* refused({ _tag: "UnknownModelStream" });
                        const next = yield* pullModelChunk(
                          model,
                          owner.providerRetry,
                          controller.signal,
                          (pull) => owner.admission.run("model", pull),
                        );
                        if (isTruthy(next.done)) {
                          MutableHashMap.remove(models, input.id);
                          ownerContext.phase = "afterModel";
                        } else {
                          grants.observe(next.value);
                          if (next.value.type === "TOOL_CALL_END") {
                            const observed = grants.toolCalls();
                            const existing = HashSet.fromIterable(
                              ownerContext.messages.flatMap((message: any) =>
                                (message.toolCalls ?? []).map((call: any) => call.id),
                              ),
                            );
                            const fresh = observed.filter(
                              (call) => !HashSet.has(existing, call.id),
                            );
                            const last = ownerContext.messages.at(-1);
                            if (last?.role === "assistant" && isTruthy(last.toolCalls))
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
                            if (isTruthy(thinking)) thinking.content += next.value.delta;
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
                        return json({
                          done: !!isTruthy(next.done),
                          value: isTruthy(next.done) ? null : next.value,
                        });
                      }),
                    ),
                },
                toolAuthorize: {
                  sideEffect: true,
                  authorize: (wire: any) => authorizeRequest("toolAuthorize", wire),
                  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
                  execute: (wire: any) =>
                    runNativeEffect(
                      Effect.gen(function* () {
                        const invocation = grants.observed(decodeFullLoopValue(wire));
                        const tool = ownerTools.find((tool) => tool.name === invocation.name);
                        if (
                          !isTruthy(tool?.execute) ||
                          (isTruthy(tool.needsApproval) && !resumedApproval(invocation.toolCallId))
                        )
                          return yield* refused({ _tag: "UnsupportedApprovalTool" });
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
                          if (!HashSet.has(readOnlyToolNames, call.function.name)) break;
                          prefix.push(call);
                        }
                        const candidates =
                          isTruthy(parallel) &&
                          prefix.some((call) => call.id === invocation.toolCallId)
                            ? prefix
                            : observed.filter((call) => call.id === invocation.toolCallId);
                        // Evaluate every prefetched read's permission chain BEFORE parallelReads
                        // can start any implementation. A worker snapshot cannot inject peers.
                        for (const call of candidates) {
                          if (MutableHashMap.has(decisions, call.id)) continue;
                          const definition = ownerTools.find(
                            (tool) => tool.name === call.function.name,
                          );
                          if (
                            !isTruthy(definition?.execute) ||
                            (isTruthy(definition.needsApproval) && !resumedApproval(call.id))
                          )
                            return yield* refused({ _tag: "UnsupportedApprovalTool" });
                          const raw = parseToolJson(call.function.arguments);
                          let args = raw;
                          if (
                            isTruthy(definition.inputSchema) &&
                            isStandardSchema(definition.inputSchema)
                          )
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
                            decision = yield* nativePromise(() =>
                              Promise.resolve(mw.onBeforeToolCall?.(ownerContext, info)),
                            );
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
                              MutableHashMap.set(completedTools, call.id, {
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
                                  : stringify(decision.result),
                              });
                              break;
                            case "abort":
                              break;
                            default:
                              return yield* refused({ _tag: "UnsupportedToolDecision" });
                          }
                          MutableHashMap.set(decisions, call.id, decision);
                        }
                        const decision = Option.getOrUndefined(
                          MutableHashMap.get(decisions, invocation.toolCallId),
                        );
                        if (isTruthy(parallel) && decision?.type === "transformArgs") {
                          const approved = candidates
                            .filter(
                              (call) =>
                                Option.getOrUndefined(MutableHashMap.get(decisions, call.id))
                                  ?.type === "transformArgs",
                            )
                            .map((call) => ({
                              ...call,
                              function: {
                                ...call.function,
                                arguments: stringify(
                                  Option.getOrUndefined(MutableHashMap.get(decisions, call.id))
                                    .args,
                                ),
                              },
                            }));
                          const saved = ownerContext.messages;
                          ownerContext.messages = [
                            ...saved.filter(
                              (message: any) =>
                                message.role !== "assistant" || !isTruthy(message.toolCalls),
                            ),
                            { role: "assistant", content: "", toolCalls: approved },
                          ];
                          yield* nativePromise(() =>
                            Promise.resolve(
                              parallel.onBeforeToolCall?.(ownerContext, {
                                toolCall: observed.find(
                                  (call) => call.id === invocation.toolCallId,
                                )!,
                                tool,
                                args: decision.args,
                                toolName: invocation.name,
                                toolCallId: invocation.toolCallId,
                              }),
                            ),
                          ).pipe(
                            Effect.ensuring(
                              Effect.sync(() => {
                                ownerContext.messages = saved;
                              }),
                            ),
                          );
                        }
                        return json({ decision, events });
                      }),
                    ),
                },
                tool: {
                  sideEffect: true,
                  authorize: (wire: any) => authorizeRequest("tool", wire),
                  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
                  execute: (input: any) =>
                    runNativeEffect(
                      Effect.gen(function* () {
                        input = grants.consume(decodeFullLoopValue(input));
                        const tool = ownerTools.find((tool) => tool.name === input.name);
                        if (!isTruthy(tool?.execute))
                          return yield* refused({ _tag: "UnknownTool" });
                        const args = input.args;
                        const events: any[] = [];
                        const outcome = yield* nativePromise(() =>
                          Promise.resolve(
                            tool.execute(args, {
                              context: turn.context,
                              toolCallId: input.toolCallId ?? undefined,
                              abortSignal: controller.signal,
                              emitCustomEvent: (name: string, value: any, options: any) => {
                                events.push({ name, value, options });
                              },
                            }),
                          ),
                        ).pipe(
                          Effect.matchEffect({
                            onSuccess: (value) =>
                              Effect.succeed({ type: "succeeded" as const, value }),
                            onFailure: (error) =>
                              HashSet.has(readOnlyToolNames, input.name)
                                ? Effect.succeed({
                                    type: "failed" as const,
                                    message:
                                      error.cause instanceof Error
                                        ? error.cause.message
                                        : "Read tool failed",
                                  })
                                : Effect.fail(error),
                          }),
                        );
                        const value =
                          outcome.type === "succeeded" ? outcome.value : { error: outcome.message };
                        MutableHashMap.set(completedTools, input.toolCallId, {
                          toolCallId: input.toolCallId,
                          toolName: input.name,
                          toolCall: grants.toolCalls().find((call) => call.id === input.toolCallId),
                          tool,
                          ok: outcome.type === "succeeded",
                          error: outcome.type === "failed" ? outcome.message : undefined,
                          duration: 0,
                          result: value,
                        });
                        ownerContext.messages.push({
                          role: "tool",
                          toolCallId: input.toolCallId,
                          content: Schema.is(Schema.String)(value) ? value : stringify(value),
                        });
                        return json({ outcome, events });
                      }),
                    ),
                },
                routedPersistence: {
                  sideEffect: true,
                  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
                  execute: (input: any) =>
                    runNativeEffect(
                      Effect.gen(function* () {
                        input = decodeFullLoopValue(input);
                        const mw = ownerMiddleware[input.index];
                        if (
                          !isTruthy(mw?.routedSubagentPersistence) ||
                          !middleware[input.index]?.routedPersistence.includes(input.method)
                        )
                          return yield* refused({ _tag: "InvalidRoutedPersistence" });
                        const method = Object.entries(mw.routedSubagentPersistence).find(
                          ([key]) => key === input.method,
                        )?.[1];
                        if (!(method instanceof Function))
                          return yield* refused({ _tag: "InvalidRoutedPersistence" });
                        yield* nativePromise(() =>
                          Promise.resolve(method.call(mw.routedSubagentPersistence, input.value)),
                        );
                        return json(null);
                      }),
                    ),
                },
                strategy: {
                  sideEffect: false,
                  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
                  execute: (input: any) =>
                    runNativeEffect(
                      Effect.sync(() => {
                        input = decodeFullLoopValue(input);
                        return json(
                          isTruthy(capabilities.model.agentLoopStrategy)
                            ? capabilities.model.agentLoopStrategy(input)
                            : input.iterationCount < 5,
                        );
                      }),
                    ),
                },
                middleware: {
                  sideEffect: true,
                  authorize: (wire: any) => authorizeRequest("middleware", wire),
                  finalization: finalizationInput,
                  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
                  execute: (input: any) =>
                    runNativeEffect(
                      Effect.gen(function* () {
                        input = decodeFullLoopValue(input);
                        const mw = ownerMiddleware[input.index];
                        if (
                          (terminalObserved || controller.signal.aborted) &&
                          HashSet.has(cleanupHooks, input.hook) &&
                          isTruthy(owner.finalizationMiddleware?.includes(mw?.name ?? "")) &&
                          owner.permitsFinalization !== undefined &&
                          (yield* owner.permitsFinalization(owner.capability))
                        )
                          finalizing = true;
                        if (!isTruthy(mw) || !middleware[input.index]?.hooks.includes(input.hook))
                          return yield* refused({ _tag: "UnknownMiddlewareHook" });
                        const phases = HashMap.fromIterable<string, ChatMiddlewareContext["phase"]>(
                          Object.entries({
                            setup: "init",
                            onStart: "init",
                            onIteration: "beforeModel",
                            onBeforeToolCall: "beforeTools",
                            onAfterToolCall: "afterTools",
                            onConfig: MutableHashSet.has(configuredMiddleware, input.index)
                              ? "beforeModel"
                              : "init",
                          } satisfies Record<string, ChatMiddlewareContext["phase"]>),
                        );
                        ownerContext.phase =
                          Option.getOrUndefined(HashMap.get(phases, input.hook)) ??
                          ownerContext.phase;
                        if (input.hook === "onConfig") {
                          MutableHashSet.add(configuredMiddleware, input.index);
                          if (input.index === firstConfigMiddleware)
                            ownerConfig.providerMessages = ownerContext.messages;
                        }
                        if (input.hook === "onInterruptBoundary") {
                          const answered = HashSet.fromIterable(
                            ownerContext.messages
                              .filter((message: any) => message.role === "tool")
                              .map((message: any) => message.toolCallId),
                          );
                          ownerContext.phase = grants
                            .toolCalls()
                            .some((call) => !HashSet.has(answered, call.id))
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
                          info = Option.getOrUndefined(
                            MutableHashMap.get(completedTools, input.info.toolCallId),
                          );
                        if (input.hook === "onToolPhaseComplete") {
                          const toolCalls = input.info.toolCalls.map(phaseCall);
                          for (const call of toolCalls) {
                            if (!isTruthy(call))
                              return yield* refused({ _tag: "UnobservedToolPhaseCall" });
                            if (MutableHashMap.has(completedTools, call.id)) continue;
                            if (
                              !isTruthy(
                                ownerConfig.resumeToolState?.cancelledToolCallIds?.has(call.id),
                              )
                            )
                              continue;
                            const result = { error: "Tool execution cancelled" };
                            MutableHashMap.set(completedTools, call.id, {
                              toolCallId: call.id,
                              toolName: call.function.name,
                              toolCall: call,
                              result,
                              state: "output-error",
                            });
                            if (
                              !isTruthy(
                                ownerContext.messages.some(
                                  (message: any) =>
                                    message.role === "tool" && message.toolCallId === call.id,
                                ),
                              )
                            )
                              ownerContext.messages.push({
                                role: "tool",
                                toolCallId: call.id,
                                content: stringify(result),
                              });
                          }
                          info = {
                            toolCalls,
                            results: input.info.toolCalls.flatMap((call: any) =>
                              MutableHashMap.has(completedTools, call.id)
                                ? [
                                    Option.getOrUndefined(
                                      MutableHashMap.get(completedTools, call.id),
                                    ),
                                  ]
                                : [],
                            ),
                            needsApproval: [],
                            needsClientExecution: [],
                          };
                        }
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
                        if (!(hook instanceof Function))
                          return yield* refused({ _tag: "UnknownMiddlewareHook" });
                        const result = yield* nativePromise(() =>
                          Promise.resolve(hook.call(mw, ctx, info)),
                        );
                        if (input.hook === "setup")
                          for (const handle of mw.provides ?? []) {
                            if (!handle.has(ctx))
                              return yield* refused({ _tag: "SetupCapabilityMissing" });
                          }
                        if (isTruthy(result?.tools))
                          return yield* refused({ _tag: "ToolReplacement" });
                        if (input.hook === "onConfig" && isTruthy(result)) {
                          Object.assign(ownerConfig, result);
                          if (isTruthy(result.messages)) ownerContext.messages = result.messages;
                          if (isTruthy(result.resumeToolState)) {
                            const resumed = result.resumeToolState.approvals;
                            for (const call of ownerContext.messages.flatMap(
                              (message: any) => message.toolCalls ?? [],
                            )) {
                              if (resumed?.has(call.id) !== true) continue;
                              if (grants.toolCalls().some((observed) => observed.id === call.id))
                                continue;
                              grants.observe({
                                type: "TOOL_CALL_START",
                                toolCallId: call.id,
                                toolCallName: call.function.name,
                              });
                              grants.observe({
                                type: "TOOL_CALL_ARGS",
                                toolCallId: call.id,
                                delta: call.function.arguments,
                              });
                              grants.observe({ type: "TOOL_CALL_END", toolCallId: call.id });
                            }
                          }
                          if (isTruthy(result.systemPrompts))
                            ownerContext.systemPrompts = result.systemPrompts;
                        }
                        return json({
                          result: result ?? null,
                          void: result === undefined,
                          abort,
                          events,
                        });
                      }),
                    ),
                },
              },
            };
            // SAFETY: each operation keeps its input/output pairing while only the
            // Promise boundary is lifted into the native Effect runtime.
            const effectHandlers = Object.fromEntries(
              Object.entries(ownerEndpointOptions.handlers).map(([operation, handler]: any) => [
                operation,
                {
                  ...handler,
                  execute: (input: any, capability: OwnerRpcCapability) =>
                    nativePromise(() => handler.execute(input, capability)),
                },
              ]),
            ) as any;
            const executeOwnerRpc = makeOwnerRpcEffect({
              ...ownerEndpointOptions,
              handlers: effectHandlers,
            });
            const callbackHandlers = FullLoopOwnerRpcGroup.toLayer({
              OwnerCall: (request) =>
                executeOwnerRpc(request).pipe(
                  Effect.mapError(() => FullLoopRpcError.make({ reason: "owner_transport" })),
                ),
            });
            const callbackServer = RpcServer.layer(FullLoopOwnerRpcGroup, {
              concurrency: 1,
              disableFatalDefects: true,
            }).pipe(
              Layer.provide(callbackHandlers),
              Layer.provide(layerMessagePortRpcServer(port1)),
            );
            yield* Effect.forkIn(Layer.launch(callbackServer), workerScope);

            let workerStopped = false;
            let orphanTermination: Promise<number> | undefined;
            const stopWorker = () => {
              if (workerStopped) return;
              workerStopped = true;
              owner.onWorkerStopped?.();
            };
            yield* owner.acquireWorkerLease ?? Effect.void;
            // Registered first so it runs last: releases a lease whose Worker was never built.
            yield* Scope.addFinalizer(
              workerScope,
              Effect.sync(() => {
                if (runningWorker === undefined) stopWorker();
              }),
            );
            yield* Scope.addFinalizer(
              workerScope,
              Effect.suspend(() => {
                const termination = orphanTermination;
                return termination === undefined
                  ? Effect.void
                  : nativePromise(() => termination).pipe(
                      Effect.catch((error) =>
                        Effect.logWarning("Orphaned Goal worker termination failed", {
                          error: error._tag,
                        }),
                      ),
                    );
              }),
            );
            const workerLayer = NodeWorker.layer(() => {
              let worker: Worker;
              try {
                worker = new Worker(
                  owner.workerUrl,
                  runtimeWorkerOptions({ capability: owner.capability }),
                );
              } catch (cause) {
                stopWorker();
                throw cause;
              }
              worker.once("exit", stopWorker);
              runningWorker = worker;
              try {
                owner.onWorker?.(worker);
              } catch (cause) {
                orphanTermination = worker.terminate();
                throw cause;
              }
              return worker;
            });
            const workerProtocol = RpcClient.layerProtocolWorker({ size: 1, concurrency: 1 }).pipe(
              Layer.provide(workerLayer),
            );
            const workerProtocolContext = yield* Layer.buildWithScope(workerProtocol, workerScope);
            const client = yield* RpcClient.make(FullLoopRpcGroup).pipe(
              Effect.provide(workerProtocolContext),
              Effect.provideService(Scope.Scope, workerScope),
            );
            const chunks = client
              .RunFullLoop(
                {
                  capability: owner.capability,
                  lastOperationId: owner.lastOperationId,
                  turn: wireTurn,
                  tools: toolDescriptions,
                  middleware,
                  adapter: { name: adapterName, model: adapterModel },
                  ownerPort: port2,
                },
                { streamBufferSize: 0 },
              )
              .pipe(
                Stream.mapEffect((value) =>
                  Effect.gen(function* () {
                    // SAFETY: RunFullLoop is the worker-side SDK iterator and its RPC
                    // envelope has already passed schema decoding.
                    const chunk = value as StreamChunk;
                    if (finalizing || !(yield* owner.permits(owner.capability)))
                      return yield* refused({ _tag: "Inactive", stage: "chunk" });
                    if (chunk.type === "RUN_FINISHED" || chunk.type === "RUN_ERROR")
                      terminalObserved = true;
                    return chunk;
                  }),
                ),
                Stream.mapError((error) => {
                  switch (error._tag) {
                    case "FullLoopRpcError":
                    case "FullLoopOwnerRefused":
                      return error;
                    default:
                      return FullLoopRpcError.make({ reason: "worker_failed" });
                  }
                }),
                Stream.ensuring(
                  Effect.forEach(deferred, (promise) => nativePromise(() => promise), {
                    concurrency: "unbounded",
                    discard: true,
                  }).pipe(Effect.orDie),
                ),
              );
            const pull = yield* Stream.toPull(chunks);
            const cancelled = Effect.callback<never, WorkerLifecycleError>((resume) => {
              let settled = false;
              const cancel = () => {
                if (settled) return;
                settled = true;
                resume(
                  Effect.fail(
                    WorkerLifecycleError.make({
                      operation: "cancel",
                      cause: controller.signal.reason,
                    }),
                  ),
                );
              };
              controller.signal.addEventListener("abort", cancel, { once: true });
              if (controller.signal.aborted) cancel();
              return Effect.sync(() => controller.signal.removeEventListener("abort", cancel));
            });
            return { pull: Effect.raceFirst(pull, cancelled) };
          }).pipe(Effect.map(({ pull }) => pull)),
        ).pipe(
          Stream.scoped,
          // The SDK generator contract gives a failing finalizer precedence over
          // the operation it was closing, as a native finally block does.
          Stream.catchCause((cause) =>
            Stream.failCause(Cause.fromReasons(cause.reasons.slice(-1))),
          ),
        ),
      );
    },
  };
}
