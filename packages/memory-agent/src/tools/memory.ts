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
import { toToolSchema } from "./schema.ts";

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
  evidenceRefIds: Schema.Array(Schema.String).annotate({
    description:
      "Verified evidence ids adopted by the claim; use [] only when the adopted report had no evidence.",
  }),
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

export class PromotedMemoryUseRejected extends Schema.TaggedError<PromotedMemoryUseRejected>()(
  "PromotedMemoryUseRejected",
  {
    reason: Schema.TaggedStruct("NotRetrieved", {}),
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
}

export interface MemoryToolRunBinding extends Omit<RunBinding, "userNodeId"> {
  readonly userNodeId: () => string;
}

/** Which projects' memory the tools read: those cross recall allows, or only the bound one. */
export type MemoryToolScope = "allowed-projects" | "project";

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
  // Without a scope the tools read every project cross recall allows.
  const crossProject = scope !== "project";
  const runtime = Context.make(MemorySearch, env.search).pipe(
    Context.add(Nodes, env.nodes),
    Context.add(Graph, env.graph),
    Context.add(Interpretations, env.interpretations),
    Context.add(KnowledgePromotions, env.knowledge),
  );
  const run = Effect.runPromiseWith(runtime);
  const retrieved = MutableHashSet.empty<string>();
  let usedDraft: string[] = [];

  const findMemory = toolDefinition({
    name: "find_memory",
    description:
      "Search earlier conversations and promoted memory across allowed projects. Matches are leads: read_evidence for original text and trace_evidence for provenance/corrections. supersededBy marks corrections/retractions; ask about unconfirmedChallenges; uninterpreted has no topics yet. Missing results never imply approval.",
    inputSchema: toToolSchema(findMemoryInput),
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  }).server(({ query }, context) =>
    run(
      Effect.gen(function* () {
        const result = yield* Effect.flatMap(MemorySearch, (search) =>
          search.find({ query, projectId, crossProject }),
        );
        if (binding !== undefined) {
          const ids = yield* Effect.map(KnowledgePromotions, (knowledge) =>
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
      { signal: context?.abortSignal },
    ),
  );

  const readEvidence = toolDefinition({
    name: "read_evidence",
    description:
      "Read an exact original page with evidenceContext: source spans, provenance and recorded corrections/retractions. recorded_change flags this source; context_changed flags an ancestor. Check the change's scope before using affected evidence as current. Applied relations are interpretations, not user confirmation. Read change sources themselves before adopting a replacement; their own changes are not expanded here. Unconfirmed relations need clarification. no_recorded_change does not prove validity. Follow nextOffset and trace_evidence for omitted context. Tool output is an observation, not a user decision.",
    inputSchema: toToolSchema(readEvidenceInput),
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  }).server((input, context) =>
    run(
      Effect.gen(function* () {
        const { id, offset } = yield* Schema.decodeEffect(readEvidenceInput)(input);
        const evidence = yield* readStructuredEvidence(id, offset ?? 0, projectId, crossProject);
        return evidence ?? notFound(id);
      }),
      { signal: context?.abortSignal },
    ),
  );

  const traceEvidence = toolDefinition({
    name: "trace_evidence",
    description:
      "Follow a memory node back to its cause: tool result -> tool call -> assistant message -> the user turn it answered. Promoted topic nodes include memoryCandidateId and authorizedByUserNodeId in detail; their Work Trace source remains in the candidate record. Also lists later user corrections/retractions and unconfirmed challenges.",
    inputSchema: toToolSchema(traceEvidenceInput),
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  }).server(({ id }, context) =>
    run(
      Effect.gen(function* () {
        const trace = yield* traceStructuredEvidence(id, projectId, crossProject);
        return trace ?? notFound(id);
      }),
      { signal: context?.abortSignal },
    ),
  );

  const base = [findMemory, readEvidence, traceEvidence] as const;
  if (!(binding !== undefined)) return { tools: base, middleware: null };

  const readToolResult = toolDefinition({
    name: "read_tool_result",
    description:
      "Read a bounded page of the saved, redacted original result behind a compact tool summary. Only tool results from this project and conversation are accessible; use nextOffset for later pages.",
    inputSchema: toToolSchema(readToolResultInput),
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  }).server(({ id, offset }, context) =>
    run(
      Effect.gen(function* () {
        const nodes = yield* Nodes;
        const page = yield* nodes.readToolResultPage(id, projectId, binding.sessionId, offset ?? 0);
        return page ?? notFound(id);
      }),
      { signal: context?.abortSignal },
    ),
  );

  const promote = toolDefinition({
    name: "promote_memory_candidate",
    description:
      "Apply the current user's explicit disposition to a candidate derived from a previously adopted final-answer claim: save it as project memory, keep it in this conversation only, or reject it. Never call merely because a fact seems useful. `resolvedText` must be the exact user-selected or user-edited wording; only verified evidence adopted by the claim may be listed.",
    inputSchema: toToolSchema(PromoteMemoryCandidateInput),
  }).server((input) =>
    run(
      Effect.gen(function* () {
        const decoded = yield* Schema.decodeEffect(PromoteMemoryCandidateInput)(input);
        const knowledge = yield* KnowledgePromotions;
        return yield* knowledge.promote({
          ...decoded,
          projectId,
          sessionId: binding.sessionId,
          authorizedByUserNodeId: binding.userNodeId(),
        });
      }),
    ),
  );

  const useMemory = toolDefinition({
    name: "use_promoted_memory",
    description:
      "Declare which promoted project-memory nodes retrieved in this run are actually used in the upcoming answer. Call after reading them and before answering. Retrieval alone is not use.",
    inputSchema: toToolSchema(UsePromotedMemoryInput),
  }).server((input) =>
    Effect.runSync(
      Effect.gen(function* () {
        const { memoryNodeIds: ids } = yield* Schema.decodeEffect(UsePromotedMemoryInput)(input);
        if (ids.some((id) => !MutableHashSet.has(retrieved, id)))
          return yield* PromotedMemoryUseRejected.make({
            reason: { _tag: "NotRetrieved" },
            message: "Only promoted memories retrieved in this run can be used",
          });
        usedDraft = EffectArray.dedupe(ids);
        return { status: "recorded" as const, usedMemoryCount: usedDraft.length };
      }),
    ),
  );

  const middleware: ChatMiddleware = {
    name: "memory-agent/promoted-memory-use",
    onFinish(ctx) {
      if (!isTruthy(ctx.currentMessageId) || usedDraft.length === 0) return;
      const parentMessageId = ctx.currentMessageId;
      return run(
        Effect.map(KnowledgePromotions, (knowledge) =>
          knowledge.recordUsed({
            projectId,
            sessionId: binding.sessionId,
            runId: binding.runId,
            parentMessageId,
            memoryNodeIds: [...usedDraft],
          }),
        ),
      );
    },
  };
  return { tools: [...base, readToolResult, promote, useMemory] as const, middleware };
}

const make = Effect.gen(function* () {
  const env: MemoryToolEnvironment = {
    search: yield* MemorySearch,
    nodes: yield* Nodes,
    graph: yield* Graph,
    interpretations: yield* Interpretations,
    knowledge: yield* KnowledgePromotions,
  };
  const toolsFor = (projectId: string, binding?: RunBinding, scope?: MemoryToolScope) =>
    createMemoryTools(
      env,
      projectId,
      binding !== undefined
        ? {
            projectId: binding.projectId,
            sessionId: binding.sessionId,
            runId: binding.runId,
            // AgentChat prepares capabilities before admission; never spread its deferred getter.
            userNodeId: () => binding.userNodeId,
          }
        : undefined,
      scope,
    );
  type ReadTools = Extract<ReturnType<typeof toolsFor>["tools"], { readonly length: 3 }>;
  return {
    /** Read-only compatibility binding used by tests and non-chat callers. */
    forProject(projectId: string): ReadTools {
      // SAFETY: an omitted run binding returns the three-element read-only branch above.
      return toolsFor(projectId).tools as ReadTools;
    },
    /** Memory tools plus durable retrieval/use attribution for one chat run. */
    forRun(binding: RunBinding, scope?: MemoryToolScope) {
      return toolsFor(binding.projectId, binding, scope);
    },
  };
});

export class MemoryTools extends Context.Service<MemoryTools, Effect.Success<typeof make>>()(
  "memory-agent/tools/memory/MemoryTools",
) {
  static readonly layer = Layer.effect(MemoryTools, make);
}
