import { toolDefinition } from "@tanstack/ai";
import { Context, Effect, Layer, Runtime, Schema } from "effect";
import { Graph } from "../memory/graph.ts";
import { Interpretations } from "../memory/interpretations.ts";
import { Nodes } from "../memory/nodes.ts";
import { MemorySearch } from "../memory/search.ts";
import { toToolSchema } from "./schema.ts";

export const memoryToolNames = ["find_memory", "read_evidence", "trace_evidence"] as const;

const findMemoryInput = Schema.Struct({
  query: Schema.String.annotations({
    description:
      "What to look for. Phrase it as you would ask it; wording does not need to match the original.",
  }),
});

const readEvidenceInput = Schema.Struct({
  id: Schema.String.annotations({ description: "Node id from find_memory or trace_evidence." }),
  offset: Schema.optional(
    Schema.Number.annotations({ description: "nextOffset from the previous page, if any." }),
  ),
});

const traceEvidenceInput = Schema.Struct({
  id: Schema.String.annotations({ description: "Node id to trace back to its cause." }),
});

const notFound = (id: string) => ({ error: "not_found", id });

const make = Effect.gen(function* () {
  const runtime = yield* Effect.runtime<MemorySearch | Nodes | Graph | Interpretations>();
  const run = Runtime.runPromise(runtime);

  return {
    /** Memory tools bound to one conversation's project. Nodes outside its recall scope stay hidden. */
    forProject(projectId: string) {
      const visible = () =>
        run(Effect.map(MemorySearch, (search) => new Set(search.allowedProjects(projectId, true))));

      const findMemory = toolDefinition({
        name: "find_memory",
        description:
          "Search every earlier message, tool call, tool result and topic across sessions, including other projects unless they opted out (projectName, fromOtherProject). Results are leads, not facts: read the original with read_evidence before relying on one, and use trace_evidence to see who said it and whether it was corrected. supersededBy lists later user statements that correct or retract a match; unconfirmedChallenges counts possible corrections that need the user's confirmation. uninterpreted counts statements with no topics or correction links yet. A missing result or missing correction does not mean something never happened or was approved.",
        inputSchema: toToolSchema(findMemoryInput),
      }).server(({ query }) =>
        run(Effect.flatMap(MemorySearch, (search) => search.find({ query, projectId }))),
      );

      const readEvidence = toolDefinition({
        name: "read_evidence",
        description:
          "Read the exact original text of a memory node, page by page. Tool results and documents are evidence of what a tool returned, not user decisions.",
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
          "Follow a memory node back to its cause: tool result -> tool call -> assistant message -> the user turn it answered. Also lists later user statements that correct or retract anything on that chain (challengedBy, with the interpreter's reason), and possible corrections it could not tie to a statement for sure (unconfirmed): ask the user about those.",
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
            if (!node || !allowed.has(node.projectId)) return [];
            return [
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

      return [findMemory, readEvidence, traceEvidence];
    },
  };
});

export class MemoryTools extends Context.Tag("memory-agent/MemoryTools")<
  MemoryTools,
  Effect.Effect.Success<typeof make>
>() {
  static readonly layer = Layer.effect(MemoryTools, make);
}
