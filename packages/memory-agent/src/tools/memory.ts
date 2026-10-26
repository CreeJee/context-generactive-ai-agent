import { isTruthy } from "../truthy.ts";
import { toolDefinition, type ChatMiddleware } from "@tanstack/ai";
import {
  Array as EffectArray,
  MutableHashSet,
  Context,
  Effect,
  Function as EffectFunction,
  Layer,
  Schema,
} from "effect";
import { Graph } from "../memory/graph.ts";
import { readStructuredEvidence, traceStructuredEvidence } from "../memory/evidence.ts";
import { Interpretations } from "../memory/interpretations.ts";
import { KnowledgePromotions } from "../memory/knowledge.ts";
import { Nodes } from "../memory/nodes.ts";
import { MemorySearch } from "../memory/search.ts";
import { onRun, runTrace } from "../runtime/run-trace.ts";
import { runTool } from "./run-tool.ts";
import { definitionOf } from "./schema.ts";

export const memoryToolNames = [
  "find_memory",
  "read_evidence",
  "read_tool_result",
  "trace_evidence",
  "promote_memory_candidate",
  "use_promoted_memory",
] as const;

const findMemoryInput = Schema.Struct({
  query: Schema.String.annotate({
    description:
      "What to look for. Phrase it as you would ask it; wording does not need to match the original.",
  }),
});
const readEvidenceInput = Schema.Struct({
  id: Schema.String.annotate({ description: "Node id from find_memory or trace_evidence." }),
  offset: Schema.optionalKey(
    Schema.Finite.annotate({ description: "nextOffset from the previous page, if any." }),
  ),
});
const readToolResultInput = Schema.Struct({
  id: Schema.NonEmptyString.annotate({
    description: "Recorded tool-result node ID from a result summary in this session.",
  }),
  offset: Schema.Finite.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThanOrEqualTo(0)),
    Schema.withDecodingDefaultTypeKey(Effect.succeed(0)),
  ),
});
const traceEvidenceInput = Schema.Struct({
  id: Schema.String.annotate({ description: "Node id to trace back to its cause." }),
});
const PromoteMemoryCandidateInput = Schema.Struct({
  claimId: Schema.String.annotate({
    description: "Final-answer claim that adopted this source.",
  }),
  taskId: Schema.String,
  attemptId: Schema.String,
  proposedText: Schema.String.annotate({
    description: "The candidate wording presented to the user.",
  }),
  resolvedText: Schema.String.annotate({
    description: "The exact wording selected or edited by the user.",
  }),
  disposition: Schema.Literals(["save", "conversation_only", "reject"]),
});
const UsePromotedMemoryInput = Schema.Struct({
  memoryNodeIds: Schema.Array(Schema.String).annotate({
    description:
      "Promoted-memory node ids returned by find_memory and actually used in the upcoming answer.",
  }),
});

const findMemory = {
  name: "find_memory",
  description:
    "Search earlier conversations and promoted memory across allowed projects. supersededBy marks corrections/retractions; latest names where those chains end (read the head before relying on it; heads are interpretations, not user confirmation; branched is an anomaly: read every head and ask the user unless the originals show they cover different facts); ask about unconfirmedChallenges and unconfirmedAfter.",
  parameters: findMemoryInput,
} as const;

const readEvidence = {
  name: "read_evidence",
  description:
    "Read an exact original page with evidenceContext: source spans, provenance and recorded corrections/retractions. When find_memory returns matchedSpan, pass its start as offset to read the matching part of a long original. recorded_change flags this source; context_changed flags an ancestor. Check the change's scope before using affected evidence as current. A change source's own changes are not expanded here.",
  parameters: readEvidenceInput,
} as const;

const traceEvidence = {
  name: "trace_evidence",
  description:
    "Follow a memory node back to its cause: tool result -> tool call -> assistant message -> the user turn it answered. Promoted topic nodes include memoryCandidateId and authorizedByUserNodeId in detail; their Work Trace source remains in the candidate record. Also lists later user corrections/retractions and unconfirmed challenges.",
  parameters: traceEvidenceInput,
} as const;

const readToolResult = {
  name: "read_tool_result",
  description:
    "Read a bounded page of the saved, redacted original result behind a compact tool summary. Only tool results from this project and conversation are accessible; use nextOffset for later pages.",
  parameters: readToolResultInput,
} as const;

const promoteMemoryCandidate = {
  name: "promote_memory_candidate",
  description:
    "Apply the current user's explicit disposition to a candidate derived from a previously adopted final-answer claim: save it as project memory, keep it in this conversation only, or reject it. Never call merely because a fact seems useful. `resolvedText` must be the exact user-selected or user-edited wording.",
  parameters: PromoteMemoryCandidateInput,
} as const;

const usePromotedMemory = {
  name: "use_promoted_memory",
  description:
    "Declare which promoted project-memory nodes retrieved in this run are actually used in the upcoming answer. Call after reading them and before answering. Retrieval alone is not use.",
  parameters: UsePromotedMemoryInput,
} as const;

const NotRetrieved = Schema.TaggedStruct("NotRetrieved", {});

export class PromotedMemoryUseRejected extends Schema.TaggedError<PromotedMemoryUseRejected>()(
  "PromotedMemoryUseRejected",
  {
    reason: NotRetrieved,
    message: Schema.Literal("Only promoted memories retrieved in this run can be used"),
  },
) {}

const notFound = (id: string) => ({ error: "not_found", id });
interface RunBinding {
  readonly projectId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly userNodeId: string;
}

/** Live owner services; their storage and search resources remain owned by their Layers. */
export interface MemoryToolEnvironment {
  readonly search: MemorySearch["Service"];
  readonly nodes: Nodes["Service"];
  readonly graph: Graph["Service"];
  readonly interpretations: Interpretations["Service"];
  readonly knowledge: KnowledgePromotions["Service"];
  /**
   * Fiber context the tool effects run on, so their spans reach the app tracer and nest under the
   * caller's span. Callers without a fiber of their own (tests) leave it out.
   */
  readonly caller?: Context.Context<never>;
}

export interface MemoryToolRunBinding extends Omit<RunBinding, "userNodeId"> {
  readonly userNodeId: () => string;
}

/** Which projects' memory the tools read: those cross recall allows, or only the bound one. */
export type MemoryToolScope = "allowed-projects" | "project";

/** The memory services the tools' calls use. */
type MemoryService = MemorySearch | Nodes | Graph | Interpretations | KnowledgePromotions;
const memoryServices = (env: MemoryToolEnvironment): Context.Context<MemoryService> =>
  Context.make(MemorySearch, env.search).pipe(
    Context.add(Nodes, env.nodes),
    Context.add(Graph, env.graph),
    Context.add(Interpretations, env.interpretations),
    Context.add(KnowledgePromotions, env.knowledge),
  );

/**
 * What the memory tools do for one project, and for one run when bound to it. The calls share the
 * run's retrieval and use state, so `use_promoted_memory` only accepts what `find_memory` found.
 */
const memoryCalls = (projectId: string, scope?: MemoryToolScope) => {
  // Without a scope the tools read every project cross recall allows.
  const crossProject = scope !== "project";
  const retrieved = MutableHashSet.empty<string>();
  let usedDraft: string[] = [];

  const reads = (binding?: MemoryToolRunBinding) => ({
    findMemory: ({ query }: typeof findMemoryInput.Type) =>
      Effect.gen(function* () {
        const result = yield* Effect.flatMap(MemorySearch, (search) =>
          search.find({ query, projectId, crossProject }),
        );
        if (binding !== undefined) {
          const ids = yield* Effect.flatMap(KnowledgePromotions, (knowledge) =>
            knowledge.recordRetrieval({
              projectId,
              sessionId: binding.sessionId,
              runId: binding.runId,
              memoryNodeIds: result.matches.map((match) => match.id),
            }),
          );
          for (const id of ids) MutableHashSet.add(retrieved, id);
        }
        return result;
      }),
    readEvidence: ({ id, offset }: typeof readEvidenceInput.Type) =>
      Effect.map(
        readStructuredEvidence(id, offset ?? 0, projectId, crossProject),
        (evidence) => evidence ?? notFound(id),
      ),
    traceEvidence: ({ id }: typeof traceEvidenceInput.Type) =>
      Effect.map(
        traceStructuredEvidence(id, projectId, crossProject),
        (trace) => trace ?? notFound(id),
      ),
  });

  const runCalls = (binding: MemoryToolRunBinding) => ({
    readToolResult: ({ id, offset }: typeof readToolResultInput.Type) =>
      Effect.flatMap(Nodes, (nodes) =>
        nodes.readToolResultPage(id, projectId, binding.sessionId, offset),
      ).pipe(Effect.map((page) => page ?? notFound(id))),
    promote: (input: typeof PromoteMemoryCandidateInput.Type) =>
      Effect.flatMap(KnowledgePromotions, (knowledge) =>
        knowledge.promote({
          ...input,
          projectId,
          sessionId: binding.sessionId,
          authorizedByUserNodeId: binding.userNodeId(),
        }),
      ),
    useMemory: ({ memoryNodeIds: ids }: typeof UsePromotedMemoryInput.Type) =>
      Effect.gen(function* () {
        if (ids.some((id) => !MutableHashSet.has(retrieved, id)))
          return yield* PromotedMemoryUseRejected.make({
            reason: NotRetrieved.make({}),
            message: "Only promoted memories retrieved in this run can be used",
          });
        usedDraft = EffectArray.dedupe(ids);
        return { status: "recorded" as const, usedMemoryCount: usedDraft.length };
      }),
    /** Records the memories the answer declared it used, under the answer's message. */
    recordUse: (parentMessageId: string) =>
      Effect.flatMap(KnowledgePromotions, (knowledge) =>
        knowledge.recordUsed({
          projectId,
          sessionId: binding.sessionId,
          runId: binding.runId,
          parentMessageId,
          memoryNodeIds: [...usedDraft],
        }),
      ).pipe(Effect.when(Effect.sync(() => usedDraft.length > 0)), Effect.asVoid),
  });

  return { reads, runCalls };
};

/** The implementation is fixed here; only live services and fresh run state are supplied. */
export const createMemoryTools: {
  (
    projectId: string,
    binding?: MemoryToolRunBinding,
    scope?: MemoryToolScope,
  ): (env: MemoryToolEnvironment) => ReturnType<typeof createMemoryToolsBody>;
} & typeof createMemoryToolsBody = EffectFunction.dual(
  (args) => !Schema.is(Schema.String)(args[0]),
  createMemoryToolsBody,
);
function createMemoryToolsBody(
  env: MemoryToolEnvironment,
  projectId: string,
  binding?: MemoryToolRunBinding,
  scope?: MemoryToolScope,
) {
  const runtime = Context.merge(env.caller ?? Context.empty(), memoryServices(env));
  const run = Effect.runPromiseWith(runtime);
  const { reads, runCalls } = memoryCalls(projectId, scope);
  const calls = reads(binding);

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const base = [
    toolDefinition(definitionOf(findMemory)).server((input, context) =>
      run(calls.findMemory(input), { signal: context?.abortSignal }),
    ),
    toolDefinition(definitionOf(readEvidence)).server((input, context) =>
      run(calls.readEvidence(input), { signal: context?.abortSignal }),
    ),
    toolDefinition(definitionOf(traceEvidence)).server((input, context) =>
      run(calls.traceEvidence(input), { signal: context?.abortSignal }),
    ),
  ] as const;
  if (!(binding !== undefined)) return { tools: base, middleware: null };
  const bound = runCalls(binding);

  const middleware: ChatMiddleware = {
    name: "memory-agent/promoted-memory-use",
    onFinish(ctx) {
      if (!isTruthy(ctx.currentMessageId)) return;
      return run(bound.recordUse(ctx.currentMessageId));
    },
  };
  return {
    tools: [
      ...base,
      toolDefinition(definitionOf(readToolResult)).server(({ id, offset }, context) =>
        run(bound.readToolResult({ id, offset: offset ?? 0 }), { signal: context?.abortSignal }),
      ),
      toolDefinition(definitionOf(promoteMemoryCandidate)).server((input) =>
        run(bound.promote(input)),
      ),
      toolDefinition(definitionOf(usePromotedMemory)).server((input) =>
        Effect.runSync(bound.useMemory(input)),
      ),
    ] as const,
    middleware,
  };
}

const make = Effect.gen(function* () {
  const services: MemoryToolEnvironment = {
    search: yield* MemorySearch,
    nodes: yield* Nodes,
    graph: yield* Graph,
    interpretations: yield* Interpretations,
    knowledge: yield* KnowledgePromotions,
  };
  // Carries the app tracer for callers that have no fiber of their own.
  const layerContext = yield* Effect.context<never>();
  const runBinding = (binding: RunBinding): MemoryToolRunBinding => ({
    projectId: binding.projectId,
    sessionId: binding.sessionId,
    runId: binding.runId,
    // AgentChat prepares capabilities before admission; never spread its deferred getter.
    userNodeId: () => binding.userNodeId,
  });
  const toolsFor = (
    context: Context.Context<never>,
    projectId: string,
    binding?: RunBinding,
    scope?: MemoryToolScope,
  ) =>
    createMemoryTools(
      { ...services, caller: context },
      projectId,
      binding !== undefined ? runBinding(binding) : undefined,
      scope,
    );
  type ReadTools = Extract<ReturnType<typeof toolsFor>["tools"], { readonly length: 3 }>;
  return {
    /** Read-only compatibility binding used by tests and non-chat callers. */
    forProject(projectId: string): ReadTools {
      // SAFETY: an omitted run binding returns the three-element read-only branch above.
      return toolsFor(layerContext, projectId).tools as ReadTools;
    },
    /**
     * Memory tools plus durable retrieval/use attribution for one chat run. Tool calls run on the
     * run's context, so their spans nest under the run.
     */
    forRun: Effect.fnUntraced(function* (binding: RunBinding, scope?: MemoryToolScope) {
      const caller = yield* runTrace;
      return toolsFor(onRun(layerContext, caller), binding.projectId, binding, scope);
    }),

    /**
     * {@link forRun} for the Effect AI loop (docs/effect-ai-migration.md step 3). The calls run on
     * the loop's fiber, so their spans nest under the run; `recordUse` takes the place of the
     * middleware's finish.
     */
    runToolsFor: (binding: RunBinding, scope?: MemoryToolScope) => {
      const context = memoryServices(services);
      const provided =
        <I, A, E>(call: (input: I) => Effect.Effect<A, E, MemoryService>) =>
        (input: I) =>
          Effect.provideContext(call(input), context);
      const { reads, runCalls } = memoryCalls(binding.projectId, scope);
      const calls = reads(runBinding(binding));
      const bound = runCalls(runBinding(binding));
      return {
        tools: [
          runTool({ ...findMemory, handler: provided(calls.findMemory) }),
          runTool({ ...readEvidence, handler: provided(calls.readEvidence) }),
          runTool({ ...traceEvidence, handler: provided(calls.traceEvidence) }),
          runTool({ ...readToolResult, handler: provided(bound.readToolResult) }),
          runTool({ ...promoteMemoryCandidate, handler: provided(bound.promote) }),
          runTool({ ...usePromotedMemory, handler: bound.useMemory }),
        ],
        recordUse: provided(bound.recordUse),
      };
    },
  };
});

export class MemoryTools extends Context.Service<MemoryTools, Effect.Success<typeof make>>()(
  "memory-agent/tools/memory/MemoryTools",
) {
  static readonly layer = Layer.effect(MemoryTools, make);
}
