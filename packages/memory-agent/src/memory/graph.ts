import { Context, Effect, Layer } from "effect";
import { Database } from "../db/database.ts";
import type { EdgeKind } from "./edges.ts";
import { toEdge, toNode, type Node } from "./nodes.ts";

export interface Hop {
  readonly nodeId: string;
  readonly kind: EdgeKind;
  /** `out`: followed from→to. `in`: followed to→from. */
  readonly direction: "out" | "in";
}

export interface Visit {
  readonly node: Node;
  readonly utility: number;
  readonly seedId: string;
  /** Hops from the seed to this node; empty for the seed itself. */
  readonly path: readonly Hop[];
}

export interface TraverseOptions {
  /** Stop after this many nodes are visited. */
  readonly budget: number;
  /** Do not expand nodes below this utility. */
  readonly minUtility: number;
  /** Only visit nodes owned by these projects. */
  readonly projectIds: readonly string[];
}

export interface TraverseResult {
  readonly visits: readonly Visit[];
  /** False when the budget ran out while candidates above minUtility remained. */
  readonly complete: boolean;
}

export interface Provenance {
  /** From the node itself back to the user turn that caused it. */
  readonly chain: readonly Node[];
  /** Later statements that correct or retract any node in the chain. */
  readonly challengedBy: readonly {
    readonly node: Node;
    readonly kind: "corrects" | "retracts";
    readonly target: string;
  }[];
}

interface Candidate {
  readonly nodeId: string;
  readonly utility: number;
  readonly seedId: string;
  readonly path: readonly Hop[];
}

/** Which edge leads one step closer to the cause of a node, by node kind. */
const causeOf: Partial<Record<Node["kind"], { kind: EdgeKind; direction: Hop["direction"] }>> = {
  tool_result: { kind: "returns", direction: "in" },
  tool_call: { kind: "calls", direction: "in" },
  assistant: { kind: "reply", direction: "out" },
};

const make = Effect.gen(function* () {
  const { sqlite } = yield* Database;
  const selectNode = sqlite.prepare("SELECT * FROM nodes WHERE id = ?");
  const outgoing = sqlite.prepare("SELECT * FROM edges WHERE from_id = ?");
  const incoming = sqlite.prepare("SELECT * FROM edges WHERE to_id = ?");

  const nodeById = (id: string) => {
    const row = selectNode.get(id);
    return row ? toNode(row) : null;
  };

  function neighbors(id: string) {
    return [
      ...outgoing.all(id).map((row) => {
        const edge = toEdge(row);
        return {
          nodeId: edge.toId,
          hop: { nodeId: edge.toId, kind: edge.kind, direction: "out" as const },
          weight: edge.weight,
        };
      }),
      ...incoming.all(id).map((row) => {
        const edge = toEdge(row);
        return {
          nodeId: edge.fromId,
          hop: { nodeId: edge.fromId, kind: edge.kind, direction: "in" as const },
          weight: edge.weight,
        };
      }),
    ];
  }

  function traverse(seeds: ReadonlyMap<string, number>, options: TraverseOptions): TraverseResult {
    const allowed = new Set(options.projectIds);
    const best = new Map<string, number>();
    const frontier: Candidate[] = [];
    for (const [nodeId, utility] of seeds) {
      if (utility <= (best.get(nodeId) ?? 0)) continue;
      best.set(nodeId, utility);
      frontier.push({ nodeId, utility, seedId: nodeId, path: [] });
    }

    const visits: Visit[] = [];
    const visited = new Set<string>();
    while (frontier.length > 0) {
      // Frontiers stay small under the budget, so a linear scan keeps this obvious.
      let top = 0;
      for (let i = 1; i < frontier.length; i++)
        if (frontier[i]!.utility > frontier[top]!.utility) top = i;
      const candidate = frontier.splice(top, 1)[0]!;
      if (visited.has(candidate.nodeId) || candidate.utility < options.minUtility) continue;
      if (visits.length >= options.budget) return { visits, complete: false };

      const node = nodeById(candidate.nodeId);
      if (!node || !allowed.has(node.projectId)) continue;
      visited.add(node.id);
      visits.push({
        node,
        utility: candidate.utility,
        seedId: candidate.seedId,
        path: candidate.path,
      });

      for (const next of neighbors(node.id)) {
        const utility = candidate.utility * next.weight;
        if (
          visited.has(next.nodeId) ||
          utility < options.minUtility ||
          utility <= (best.get(next.nodeId) ?? 0)
        )
          continue;
        best.set(next.nodeId, utility);
        frontier.push({
          nodeId: next.nodeId,
          utility,
          seedId: candidate.seedId,
          path: [...candidate.path, next.hop],
        });
      }
    }
    return { visits, complete: true };
  }

  function trace(id: string): Provenance | null {
    const start = nodeById(id);
    if (!start) return null;
    const chain: Node[] = [start];
    let current = start;
    for (;;) {
      const rule = causeOf[current.kind];
      if (!rule) break;
      const rows = rule.direction === "in" ? incoming.all(current.id) : outgoing.all(current.id);
      const edge = rows.map(toEdge).find((candidate) => candidate.kind === rule.kind);
      if (!edge) break;
      const cause = nodeById(rule.direction === "in" ? edge.fromId : edge.toId);
      if (!cause || chain.some((node) => node.id === cause.id)) break;
      chain.push(cause);
      current = cause;
    }

    const challengedBy = chain.flatMap((target) =>
      incoming
        .all(target.id)
        .map(toEdge)
        .flatMap((edge) => {
          if (edge.kind !== "corrects" && edge.kind !== "retracts") return [];
          const node = nodeById(edge.fromId);
          return node ? [{ node, kind: edge.kind, target: target.id }] : [];
        }),
    );
    return { chain, challengedBy };
  }

  return { traverse, trace };
});

/** Walks the memory graph: outward to explore around a match, backward to prove where it came from. */
export class Graph extends Context.Service<Graph, Effect.Success<typeof make>>()(
  "memory-agent/Graph",
) {
  static readonly layer = Layer.effect(Graph, make);
}
