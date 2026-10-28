import { HashMap, HashSet } from "effect";
import { Array as Arr, Option, Context, Effect, Layer, Match, Schema, Stream } from "effect";
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

/** A traversal so far. `complete` is set once it ends. */
interface Walk {
  readonly frontier: ReadonlyArray<Candidate>;
  /** The best utility queued for each node. */
  readonly best: HashMap.HashMap<string, number>;
  readonly visited: HashSet.HashSet<string>;
  readonly visits: ReadonlyArray<Visit>;
  readonly complete: Option.Option<boolean>;
}

/** Whether a candidate for `nodeId` at `utility` beats every one queued for it so far. */
const improves = (best: HashMap.HashMap<string, number>, nodeId: string, utility: number) =>
  utility > Option.getOrElse(HashMap.get(best, nodeId), () => 0);

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
export class GraphReadFailed extends Schema.TaggedError<
  GraphReadFailed,
  { readonly brand: unique symbol }
>()("GraphReadFailed", {
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
      const queued = Arr.reduce(
        Arr.fromIterable(seeds),
        { frontier: Arr.empty<Candidate>(), best: HashMap.empty<string, number>() },
        (queue, [nodeId, utility]) =>
          improves(queue.best, nodeId, utility)
            ? {
                frontier: Arr.append(queue.frontier, { nodeId, utility, seedId: nodeId, path: [] }),
                best: HashMap.set(queue.best, nodeId, utility),
              }
            : queue,
      );

      /** Takes the best candidate left: it is visited and expanded, or dropped. */
      const step = (walk: Walk) =>
        Effect.gen(function* () {
          // Frontiers stay small under the budget, so a linear scan keeps this obvious.
          const top = Arr.reduce(walk.frontier, 0, (top, candidate, index) =>
            candidate.utility > walk.frontier[top]!.utility ? index : top,
          );
          const candidate = walk.frontier[top];
          if (candidate === undefined) return { ...walk, complete: Option.some(true) };
          const rest = { ...walk, frontier: Arr.remove(walk.frontier, top) };
          if (HashSet.has(walk.visited, candidate.nodeId) || candidate.utility < options.minUtility)
            return rest;
          if (HashSet.size(walk.visited) >= options.budget)
            return { ...rest, complete: Option.some(false) };

          const node = yield* nodeById(candidate.nodeId);
          if (node === null || !HashSet.has(allowed, node.projectId)) return rest;
          const visited = HashSet.add(walk.visited, node.id);
          const expanded = Arr.reduce(
            yield* adjacent(node.id),
            { frontier: rest.frontier, best: rest.best },
            (queue, next) => {
              const utility = candidate.utility * next.weight;
              return !HashSet.has(visited, next.nodeId) &&
                utility >= options.minUtility &&
                improves(queue.best, next.nodeId, utility)
                ? {
                    frontier: Arr.append(queue.frontier, {
                      nodeId: next.nodeId,
                      utility,
                      seedId: candidate.seedId,
                      path: [
                        ...candidate.path,
                        { nodeId: next.nodeId, kind: next.kind, direction: next.direction },
                      ],
                    }),
                    best: HashMap.set(queue.best, next.nodeId, utility),
                  }
                : queue;
            },
          );
          return {
            ...expanded,
            visited,
            visits:
              options.includeEmpty !== false || hasStatementText(node.text)
                ? Arr.append(walk.visits, {
                    node,
                    utility: candidate.utility,
                    seedId: candidate.seedId,
                    path: candidate.path,
                  })
                : walk.visits,
            complete: Option.none<boolean>(),
          } satisfies Walk;
        });

      const initial: Walk = {
        ...queued,
        visited: HashSet.empty(),
        visits: [],
        complete: Option.none(),
      };
      const walked = yield* Stream.paginate(initial, (walk) =>
        Effect.map(
          step(walk),
          (next) =>
            [
              Arr.of(next),
              Option.isNone(next.complete) ? Option.some(next) : Option.none(),
            ] as const,
        ),
      ).pipe(Stream.runLast);
      return Option.match(walked, {
        onNone: () => ({ visits: [], complete: true }),
        onSome: ({ visits, complete }) => ({
          visits,
          complete: Option.getOrElse(complete, () => true),
        }),
      }) satisfies TraverseResult;
    }).pipe(Effect.mapError((cause) => GraphReadFailed.make({ cause })));

  /** The node one step closer to what caused this one, when there is one. */
  const causeOfNode = (node: Node) =>
    Option.match(Option.fromNullishOr(causeOf[node.kind]), {
      onNone: () => Effect.succeedNone,
      onSome: (rule) =>
        Effect.flatMap(
          causeEdge({ id: node.id, ...rule }),
          Option.match({
            onNone: () => Effect.succeedNone,
            onSome: (edge) =>
              Effect.map(
                nodeById(rule.direction === "in" ? edge.from_id : edge.to_id),
                Option.fromNullishOr,
              ),
          }),
        ),
    });

  const trace = (id: string) =>
    Effect.gen(function* () {
      const startRow = yield* selectStart(id);
      if (Option.isNone(startRow)) return null;
      const start = nodeOfRow(startRow.value);
      // The chain stops where a node has no cause, or where a cause is already in it.
      const chain = yield* Stream.paginate(Arr.of(start), (chain) =>
        Effect.map(causeOfNode(Arr.lastNonEmpty(chain)), (cause) =>
          Option.match(
            Option.filter(cause, (found) => !chain.some((node) => node.id === found.id)),
            {
              onNone: () => [Arr.empty<Node>(), Option.none<Arr.NonEmptyArray<Node>>()] as const,
              onSome: (found) => [Arr.of(found), Option.some(Arr.append(chain, found))] as const,
            },
          ),
        ),
      ).pipe(
        Stream.runCollect,
        Effect.map((causes) => Arr.prepend(causes, start)),
      );

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
