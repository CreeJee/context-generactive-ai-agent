import { HashSet, MutableHashSet } from "effect";
import { isTruthy } from "../truthy.ts";
import { MutableHashMap, Option, Context, Effect, Layer, Match, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { EdgeKind } from "./edges.ts";
import { hasStatementText } from "./quality.ts";
import { EdgeRow, edgeOfRow, NodeRow, nodeOfRow, type Node } from "./nodes.ts";

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
  /** Stop after this many nodes are expanded, including empty structural bridge nodes. */
  readonly budget: number;
  /** Do not expand nodes below this utility. */
  readonly minUtility: number;
  /** Only visit nodes owned by these projects. */
  readonly projectIds: readonly string[];
  /** Keep empty nodes as traversal bridges without returning them as search matches. */
  readonly includeEmpty?: boolean;
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

const Neighbor = Schema.Struct({
  nodeId: Schema.String,
  kind: EdgeKind,
  direction: Schema.Literals(["out", "in"]),
  weight: Schema.Finite,
});

/** The memory graph could not be read; the cause stays with the error. */
export class GraphReadFailed extends Schema.TaggedError<GraphReadFailed>()("GraphReadFailed", {
  cause: Schema.Defect(),
}) {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const selectNode = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: NodeRow,
    execute: (id) => sql`SELECT n.* FROM nodes n WHERE n.id = ${id}
      AND NOT EXISTS (SELECT 1 FROM memory_graph_suppressed_nodes s WHERE s.node_seq = n.seq)`,
  });
  // A read superseded by a later one leaves graph walks, but its own provenance still exists.
  const selectStart = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: NodeRow,
    execute: (id) => sql`SELECT * FROM nodes WHERE id = ${id}`,
  });
  const causeEdge = SqlSchema.findOneOption({
    Request: Schema.Struct({
      id: Schema.String,
      kind: EdgeKind,
      direction: Schema.Literals(["out", "in"]),
    }),
    Result: EdgeRow,
    execute: ({ id, kind, direction }) =>
      direction === "in"
        ? sql`SELECT * FROM edges WHERE to_id = ${id} AND kind = ${kind} LIMIT 1`
        : sql`SELECT * FROM edges WHERE from_id = ${id} AND kind = ${kind} LIMIT 1`,
  });
  const challenges = SqlSchema.findAll({
    Request: Schema.String,
    Result: EdgeRow,
    execute: (id) =>
      sql`SELECT * FROM edges WHERE to_id = ${id} AND kind IN ('corrects', 'retracts')`,
  });
  const adjacent = SqlSchema.findAll({
    Request: Schema.String,
    Result: Neighbor,
    execute: (id) => sql`
      SELECT to_id AS nodeId, kind, 'out' AS direction, weight FROM edges WHERE from_id = ${id}
      UNION ALL
      SELECT from_id AS nodeId, kind, 'in' AS direction, weight FROM edges WHERE to_id = ${id}`,
  });

  const nodeById = (id: string) =>
    Effect.map(selectNode(id), Option.match({ onNone: () => null, onSome: nodeOfRow }));

  const traverse = (seeds: Iterable<readonly [string, number]>, options: TraverseOptions) =>
    Effect.gen(function* () {
      const allowed = HashSet.fromIterable(options.projectIds);
      const best = MutableHashMap.empty<string, number>();
      const frontier: Candidate[] = [];
      for (const [nodeId, utility] of seeds) {
        if (utility <= (Option.getOrUndefined(MutableHashMap.get(best, nodeId)) ?? 0)) continue;
        MutableHashMap.set(best, nodeId, utility);
        frontier.push({ nodeId, utility, seedId: nodeId, path: [] });
      }

      const visits: Visit[] = [];
      const visited = MutableHashSet.empty<string>();
      while (frontier.length > 0) {
        // Frontiers stay small under the budget, so a linear scan keeps this obvious.
        let top = 0;
        for (let i = 1; i < frontier.length; i++)
          if (frontier[i]!.utility > frontier[top]!.utility) top = i;
        const candidate = frontier.splice(top, 1)[0]!;
        if (MutableHashSet.has(visited, candidate.nodeId) || candidate.utility < options.minUtility)
          continue;
        if (MutableHashSet.size(visited) >= options.budget)
          return { visits, complete: false } satisfies TraverseResult;

        const node = yield* nodeById(candidate.nodeId);
        if (!(node !== null) || !HashSet.has(allowed, node.projectId)) continue;
        MutableHashSet.add(visited, node.id);
        if (options.includeEmpty !== false || hasStatementText(node.text))
          visits.push({
            node,
            utility: candidate.utility,
            seedId: candidate.seedId,
            path: candidate.path,
          });

        for (const next of yield* adjacent(node.id)) {
          const utility = candidate.utility * next.weight;
          if (
            MutableHashSet.has(visited, next.nodeId) ||
            utility < options.minUtility ||
            utility <= (Option.getOrUndefined(MutableHashMap.get(best, next.nodeId)) ?? 0)
          )
            continue;
          MutableHashMap.set(best, next.nodeId, utility);
          frontier.push({
            nodeId: next.nodeId,
            utility,
            seedId: candidate.seedId,
            path: [
              ...candidate.path,
              { nodeId: next.nodeId, kind: next.kind, direction: next.direction },
            ],
          });
        }
      }
      return { visits, complete: true } satisfies TraverseResult;
    }).pipe(Effect.mapError((cause) => GraphReadFailed.make({ cause })));

  const trace = (id: string) =>
    Effect.gen(function* () {
      const startRow = yield* selectStart(id);
      if (Option.isNone(startRow)) return null;
      const start = nodeOfRow(startRow.value);
      const chain: Node[] = [start];
      let current = start;
      for (;;) {
        const rule = causeOf[current.kind];
        if (!isTruthy(rule)) break;
        const edge = yield* causeEdge({ id: current.id, ...rule });
        if (Option.isNone(edge)) break;
        const cause = yield* nodeById(
          rule.direction === "in" ? edge.value.from_id : edge.value.to_id,
        );
        if (!(cause !== null) || chain.some((node) => node.id === cause.id)) break;
        chain.push(cause);
        current = cause;
      }

      const challenged = yield* Effect.forEach(chain, (target) =>
        Effect.flatMap(challenges(target.id), (rows) =>
          Effect.forEach(rows, (row) => {
            const edge = edgeOfRow(row);
            return Match.value(edge.kind).pipe(
              Match.whenOr("corrects", "retracts", (kind) =>
                Effect.map(nodeById(edge.fromId), (node) =>
                  node === null ? [] : [{ node, kind, target: target.id }],
                ),
              ),
              Match.orElse(() => Effect.succeed([])),
            );
          }),
        ),
      );
      const challengedBy: Provenance["challengedBy"] = challenged.flat(2);

      return { chain, challengedBy } satisfies Provenance;
    }).pipe(Effect.mapError((cause) => GraphReadFailed.make({ cause })));

  return { traverse, trace };
});

/** Walks the memory graph: outward to explore around a match, backward to prove where it came from. */
export class Graph extends Context.Service<Graph, Effect.Success<typeof make>>()(
  "memory-agent/memory/graph",
) {
  static readonly layer = Layer.effect(Graph, make);
}
