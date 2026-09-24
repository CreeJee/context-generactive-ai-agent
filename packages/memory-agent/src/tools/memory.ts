import { toolDefinition, type ChatMiddleware } from "@tanstack/ai";
import { Context, Effect, Layer, Schema } from "effect";
import { Graph } from "../memory/graph.ts";
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

const notFound = (id: string) => ({ error: "not_found", id });
interface RunBinding {
  readonly projectId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly userNodeId: string;
}

const make = Effect.gen(function* () {
  const runtime = yield* Effect.context<
    MemorySearch | Nodes | Graph | Interpretations | KnowledgePromotions
  >();
  const run = Effect.runPromiseWith(runtime);

  const toolsFor = (projectId: string, binding?: RunBinding) => {
    const retrieved = new Set<string>();
    let usedDraft = new Set<string>();
    const visible = () =>
      run(Effect.map(MemorySearch, (search) => new Set(search.allowedProjects(projectId, true))));

    const findMemory = toolDefinition({
      name: "find_memory",
      description:
        "Search earlier conversations and promoted memory across allowed projects. Matches are leads: read_evidence for original text and trace_evidence for provenance/corrections. supersededBy marks corrections/retractions; ask about unconfirmedChallenges; uninterpreted has no topics yet. Missing results never imply approval.",
      inputSchema: toToolSchema(findMemoryInput),
    }).server(async ({ query }) => {
      const result = await run(
        Effect.flatMap(MemorySearch, (search) => search.find({ query, projectId })),
      );
      if (binding) {
        const ids = await run(
          Effect.map(KnowledgePromotions, (knowledge) =>
            knowledge.recordRetrieval({
              projectId,
              sessionId: binding.sessionId,
              runId: binding.runId,
              memoryNodeIds: result.matches.map((match) => match.id),
            }),
          ),
        );
        for (const id of ids) retrieved.add(id);
      }
      return result;
    });

    const readEvidence = toolDefinition({
      name: "read_evidence",
      description:
        "Read the exact original text of a memory node, page by page. Promoted topic nodes are user-authorized project memory; tool results and documents are evidence of what a tool returned, not user decisions.",
      inputSchema: toToolSchema(readEvidenceInput),
    }).server(async ({ id, offset }) => {
      const [nodes, allowed] = await Promise.all([run(Nodes), visible()]);
      const node = nodes.get(id);
      if (!node || !allowed.has(node.projectId)) return notFound(id);
      return {
        ...nodes.read(id, offset ?? 0),
        projectId: node.projectId,
        sessionId: node.sessionId,
        createdAt: node.createdAt,
        detail: node.detail,
      };
    });

    const traceEvidence = toolDefinition({
      name: "trace_evidence",
      description:
        "Follow a memory node back to its cause: tool result -> tool call -> assistant message -> the user turn it answered. Promoted topic nodes include memoryCandidateId and authorizedByUserNodeId in detail; their Work Trace source remains in the candidate record. Also lists later user corrections/retractions and unconfirmed challenges.",
      inputSchema: toToolSchema(traceEvidenceInput),
    }).server(async ({ id }) => {
      const [graph, interpretations, nodes, allowed] = await Promise.all([
        run(Graph),
        run(Interpretations),
        run(Nodes),
        visible(),
      ]);
      const provenance = graph.trace(id);
      if (!provenance || !allowed.has(provenance.chain[0]!.projectId)) return notFound(id);
      const summary = (node: (typeof provenance.chain)[number]) => ({
        id: node.id,
        kind: node.kind,
        projectId: node.projectId,
        createdAt: node.createdAt,
        snippet: node.text.slice(0, 300),
        detail: node.detail,
      });
      const chainIds = provenance.chain.map((node) => node.id);
      const applied = interpretations.targeting(chainIds, "applied");
      const reasonFor = (from: string, target: string, kind: string) =>
        applied.find(
          (entry) => entry.nodeId === from && entry.targetId === target && entry.kind === kind,
        )?.reason ?? null;
      return {
        chain: provenance.chain.filter((node) => allowed.has(node.projectId)).map(summary),
        challengedBy: provenance.challengedBy
          .filter((entry) => allowed.has(entry.node.projectId))
          .map((entry) => ({
            ...summary(entry.node),
            relation: entry.kind,
            target: entry.target,
            reason: reasonFor(entry.node.id, entry.target, entry.kind),
          })),
        unconfirmed: interpretations.targeting(chainIds, "unconfirmed").flatMap((entry) => {
          const node = nodes.get(entry.nodeId);
          return !node || !allowed.has(node.projectId)
            ? []
            : [
                {
                  ...summary(node),
                  possibleRelation: entry.kind,
                  target: entry.targetId,
                  reason: entry.reason,
                },
              ];
        }),
      };
    });

    const base = [findMemory, readEvidence, traceEvidence] as const;
    if (!binding) return { tools: base, middleware: null };

    const readToolResult = toolDefinition({
      name: "read_tool_result",
      description:
        "Read a bounded page of the saved, redacted original result behind a compact tool summary. Only tool results from this project and conversation are accessible; use nextOffset for later pages.",
      inputSchema: toToolSchema(readToolResultInput),
    }).server(async ({ id, offset }) => {
      const nodes = await run(Nodes);
      const node = nodes.get(id);
      if (
        !node ||
        node.kind !== "tool_result" ||
        node.projectId !== projectId ||
        node.sessionId !== binding.sessionId
      )
        return notFound(id);
      return nodes.read(id, offset ?? 0);
    });

    const promote = toolDefinition({
      name: "promote_memory_candidate",
      description:
        "Apply the current user's explicit disposition to a candidate derived from a previously adopted final-answer claim: save it as project memory, keep it in this conversation only, or reject it. Never call merely because a fact seems useful. `resolvedText` must be the exact user-selected or user-edited wording; only verified evidence adopted by the claim may be listed.",
      inputSchema: toToolSchema(PromoteMemoryCandidateInput),
    }).server((input) =>
      run(
        Effect.flatMap(KnowledgePromotions, (knowledge) =>
          knowledge.promote({
            ...Schema.decodeSync(PromoteMemoryCandidateInput)(input),
            projectId,
            sessionId: binding.sessionId,
            authorizedByUserNodeId: binding.userNodeId,
          }),
        ),
      ),
    );

    const useMemory = toolDefinition({
      name: "use_promoted_memory",
      description:
        "Declare which promoted project-memory nodes retrieved in this run are actually used in the upcoming answer. Call after reading them and before answering. Retrieval alone is not use.",
      inputSchema: toToolSchema(UsePromotedMemoryInput),
    }).server((input) => {
      const ids = Schema.decodeSync(UsePromotedMemoryInput)(input).memoryNodeIds;
      if (ids.some((id) => !retrieved.has(id)))
        throw new Error("Only promoted memories retrieved in this run can be used");
      usedDraft = new Set(ids);
      return { status: "recorded" as const, usedMemoryCount: usedDraft.size };
    });

    const middleware: ChatMiddleware = {
      name: "memory-agent/promoted-memory-use",
      onFinish(ctx) {
        if (!ctx.currentMessageId || usedDraft.size === 0) return;
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
  };

  type ReadTools = Extract<ReturnType<typeof toolsFor>["tools"], { readonly length: 3 }>;
  return {
    /** Read-only compatibility binding used by tests and non-chat callers. */
    forProject(projectId: string): ReadTools {
      // SAFETY: an omitted run binding returns the three-element read-only branch above.
      return toolsFor(projectId).tools as ReadTools;
    },
    /** Memory tools plus durable retrieval/use attribution for one chat run. */
    forRun(binding: RunBinding) {
      return toolsFor(binding.projectId, binding);
    },
  };
});

export class MemoryTools extends Context.Service<MemoryTools, Effect.Success<typeof make>>()(
  "memory-agent/MemoryTools",
) {
  static readonly layer = Layer.effect(MemoryTools, make);
}
