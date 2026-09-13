import { toolDefinition } from "@tanstack/ai";
import { Context, Effect, Layer, Runtime, Schema } from "effect";
import { Graph } from "../memory/graph.ts";
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
  const runtime = yield* Effect.runtime<MemorySearch | Nodes | Graph>();
  const run = Runtime.runPromise(runtime);

  return {
    /** Memory tools bound to one conversation's project. Nodes outside its recall scope stay hidden. */
    forProject(projectId: string) {
      const visible = () =>
        run(Effect.map(MemorySearch, (search) => new Set(search.allowedProjects(projectId, true))));

      const findMemory = toolDefinition({
        name: "find_memory",
        description:
          "Search every earlier message, tool call and tool result across sessions, including other projects unless they opted out. Results are leads, not facts: read the original with read_evidence before relying on one, and use trace_evidence to see who said it and whether it was corrected. A missing result does not mean something never happened or was approved.",
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
          "Follow a memory node back to its cause: tool result -> tool call -> assistant message -> the user turn it answered. Also lists later statements that correct or retract anything on that chain.",
        inputSchema: toToolSchema(traceEvidenceInput),
      }).server(async ({ id }) => {
        const [graph, allowed] = await Promise.all([run(Graph), visible()]);
        const provenance = graph.trace(id);
        if (!provenance || !allowed.has(provenance.chain[0]!.projectId)) return notFound(id);
        const summary = (node: (typeof provenance.chain)[number]) => ({
          id: node.id,
          kind: node.kind,
          projectId: node.projectId,
          createdAt: node.createdAt,
          snippet: node.text.slice(0, 300),
        });
        return {
          chain: provenance.chain.filter((node) => allowed.has(node.projectId)).map(summary),
          challengedBy: provenance.challengedBy
            .filter((entry) => allowed.has(entry.node.projectId))
            .map((entry) => ({
              ...summary(entry.node),
              relation: entry.kind,
              target: entry.target,
            })),
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
