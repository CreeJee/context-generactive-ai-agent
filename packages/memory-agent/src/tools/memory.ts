import { Array as EffectArray, Context, Effect, HashSet, Layer, Option, Ref, Schema } from "effect";
import { type RunHook, StepEnded } from "../loop/run.ts";
import { finishedRun } from "../loop/store.ts";
import { Graph } from "../memory/graph.ts";
import { readStructuredEvidence, traceStructuredEvidence } from "../memory/evidence.ts";
import { Interpretations } from "../memory/interpretations.ts";
import { KnowledgePromotions } from "../memory/knowledge.ts";
import { Nodes } from "../memory/nodes.ts";
import { type FindResult, MemorySearch } from "../memory/search.ts";
import { optionalProperty } from "../optional-property.ts";
import { runTool } from "./run-tool.ts";

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
/** A run's memory tools are bound to; AgentChat prepares them before a Goal run admits its turn. */
export interface MemoryToolRunBinding {
  readonly projectId: string;
  readonly sessionId: string;
  readonly runId: string;
  /** The user turn the run answers, read when a promotion needs it. */
  readonly userNodeId: Effect.Effect<string>;
}

/** Live owner services; their storage and search resources remain owned by their Layers. */
export interface MemoryToolEnvironment {
  readonly search: MemorySearch["Service"];
  readonly nodes: Nodes["Service"];
  readonly graph: Graph["Service"];
  readonly interpretations: Interpretations["Service"];
  readonly knowledge: KnowledgePromotions["Service"];
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
 * What the read-only memory tools do for one project. `found` hears each search's result.
 */
const memoryReads = <E>(
  projectId: string,
  scope: MemoryToolScope | undefined,
  found: (result: FindResult) => Effect.Effect<void, E, MemoryService>,
) => {
  // Without a scope the tools read every project cross recall allows.
  const crossProject = scope !== "project";
  return {
    findMemory: ({ query }: typeof findMemoryInput.Type) =>
      Effect.flatMap(MemorySearch, (search) =>
        search.find({ query, projectId, crossProject }),
      ).pipe(Effect.tap(found)),
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
  };
};

/**
 * What the memory tools do for one run. The calls share the run's retrieval and use state, so
 * `use_promoted_memory` only accepts what `find_memory` found.
 */
const memoryRunCalls = Effect.fnUntraced(function* (
  binding: MemoryToolRunBinding,
  scope?: MemoryToolScope,
) {
  const { projectId } = binding;
  const retrieved = yield* Ref.make(HashSet.empty<string>());
  const usedDraft = yield* Ref.make<ReadonlyArray<string>>([]);

  // A run remembers what it found, which is all `use_promoted_memory` accepts.
  const reads = memoryReads(projectId, scope, (result) =>
    Effect.flatMap(KnowledgePromotions, (knowledge) =>
      knowledge.recordRetrieval({
        projectId,
        sessionId: binding.sessionId,
        runId: binding.runId,
        memoryNodeIds: result.matches.map((match) => match.id),
      }),
    ).pipe(
      Effect.flatMap((ids) => Ref.update(retrieved, HashSet.union(HashSet.fromIterable(ids)))),
    ),
  );

  return {
    reads,
    readToolResult: ({ id, offset }: typeof readToolResultInput.Type) =>
      Effect.flatMap(Nodes, (nodes) =>
        nodes.readToolResultPage(id, projectId, binding.sessionId, offset),
      ).pipe(Effect.map((page) => page ?? notFound(id))),
    promote: (input: typeof PromoteMemoryCandidateInput.Type) =>
      Effect.gen(function* () {
        const knowledge = yield* KnowledgePromotions;
        return yield* knowledge.promote({
          ...input,
          projectId,
          sessionId: binding.sessionId,
          authorizedByUserNodeId: yield* binding.userNodeId,
        });
      }),
    useMemory: ({ memoryNodeIds: ids }: typeof UsePromotedMemoryInput.Type) =>
      Ref.get(retrieved).pipe(
        Effect.filterOrFail(
          (found) => ids.every((id) => HashSet.has(found, id)),
          () =>
            PromotedMemoryUseRejected.make({
              reason: NotRetrieved.make({}),
              message: "Only promoted memories retrieved in this run can be used",
            }),
        ),
        Effect.as(EffectArray.dedupe(ids)),
        Effect.tap((given) => Ref.set(usedDraft, given)),
        Effect.map((given) => ({ status: "recorded" as const, usedMemoryCount: given.length })),
      ),
    /** Records the memories the answer declared it used, under the answer's message. */
    recordUse: (parentMessageId: string) =>
      Effect.flatMap(Ref.get(usedDraft), (memoryNodeIds) =>
        Effect.flatMap(KnowledgePromotions, (knowledge) =>
          knowledge.recordUsed({
            projectId,
            sessionId: binding.sessionId,
            runId: binding.runId,
            parentMessageId,
            memoryNodeIds: [...memoryNodeIds],
          }),
        ).pipe(Effect.when(Effect.succeed(memoryNodeIds.length > 0))),
      ).pipe(Effect.asVoid),
  };
});

/** Runs a call of {@link memoryReads} or {@link memoryRunCalls} on these services, keeping the caller's fiber and span. */
const providedBy =
  (context: Context.Context<MemoryService>) =>
  <I, A, E>(call: (input: I) => Effect.Effect<A, E, MemoryService>) =>
  (input: I) =>
    Effect.provideContext(call(input), context);

const readRunTools = <E>(
  calls: ReturnType<typeof memoryReads<E>>,
  provided: ReturnType<typeof providedBy>,
) => [
  runTool({ ...findMemory, handler: provided(calls.findMemory) }),
  runTool({ ...readEvidence, handler: provided(calls.readEvidence) }),
  runTool({ ...traceEvidence, handler: provided(calls.traceEvidence) }),
];

/**
 * The read-only memory tools, with no run binding: nothing records a retrieval, a use or a
 * promotion. The calls run on the loop's fiber.
 */
export const memoryReadRunTools = ({
  env,
  projectId,
  scope,
}: {
  readonly env: MemoryToolEnvironment;
  readonly projectId: string;
  readonly scope?: MemoryToolScope;
}) =>
  readRunTools(
    memoryReads(projectId, scope, () => Effect.void),
    providedBy(memoryServices(env)),
  );

/**
 * Records the memories the answer declared it used under the last message the model wrote in this
 * run, once the run finished or waits for the user, as the middleware's finish did. One hook serves
 * one run.
 */
const recordUseHook = <E>(recordUse: (parentMessageId: string) => Effect.Effect<void, E>) =>
  Effect.map(Ref.make(Option.none<string>()), (written): RunHook => ({
    stepEnded: (_scope, step) =>
      StepEnded.$match(step, {
        Model: ({ message }) => Ref.set(written, Option.fromNullishOr(message.id)),
        Resume: () => Effect.void,
      }),
    ended: (_scope, end) =>
      Effect.flatMap(Ref.get(written), (id) =>
        Option.match(id, { onNone: () => Effect.void, onSome: recordUse }),
      ).pipe(Effect.when(Effect.succeed(finishedRun(end))), Effect.ignore({ log: "Warn" })),
  }));

/**
 * Memory tools plus durable retrieval/use attribution for one chat run. The calls run on the loop's
 * fiber, so their spans nest under the run; `hook` records the memories the answer used.
 */
export const memoryRunTools = Effect.fnUntraced(function* ({
  env,
  binding,
  scope,
}: {
  readonly env: MemoryToolEnvironment;
  readonly binding: MemoryToolRunBinding;
  readonly scope?: MemoryToolScope;
}) {
  const provided = providedBy(memoryServices(env));
  const bound = yield* memoryRunCalls(binding, scope);
  return {
    tools: [
      ...readRunTools(bound.reads, provided),
      runTool({ ...readToolResult, handler: provided(bound.readToolResult) }),
      runTool({ ...promoteMemoryCandidate, handler: provided(bound.promote) }),
      runTool({ ...usePromotedMemory, handler: bound.useMemory }),
    ],
    hook: recordUseHook(provided(bound.recordUse)),
  };
});

const make = Effect.gen(function* () {
  const env: MemoryToolEnvironment = {
    search: yield* MemorySearch,
    nodes: yield* Nodes,
    graph: yield* Graph,
    interpretations: yield* Interpretations,
    knowledge: yield* KnowledgePromotions,
  };
  return {
    /** {@link memoryRunTools} over the agent's own memory. */
    toolsFor: (binding: MemoryToolRunBinding, scope?: MemoryToolScope) =>
      memoryRunTools({ env, binding, ...optionalProperty("scope", scope) }),
  };
});

export class MemoryTools extends Context.Service<MemoryTools, Effect.Success<typeof make>>()(
  "memory-agent/tools/memory/MemoryTools",
) {
  static readonly layer = Layer.effect(MemoryTools, make);
}
