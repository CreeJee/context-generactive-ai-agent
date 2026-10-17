import { Result, Function as EffectFunction } from "effect";
import { isTruthy } from "../truthy.ts";
import {
  MutableHashMap,
  HashSet,
  Array as EffectArray,
  Option,
  Context,
  Effect,
  Layer,
  Schema,
} from "effect";
import { Database } from "../db/database.ts";
import { Embedder } from "./embedding/embedder.ts";
import { VectorIndex } from "./embedding/vector-index.ts";
import { MorphAnalysisFailed, MorphAnalyzer } from "./morph/analyzer.ts";
import { changeAuthoritySql } from "./changes.ts";
import { Graph, type Hop } from "./graph.ts";
import type { NodeKind } from "./nodes.ts";

export interface FindInput {
  readonly query: string;
  /** The project the conversation belongs to. */
  readonly projectId: string;
  /** Also search projects that have not opted out of cross-project recall. Default true. */
  readonly crossProject?: boolean;
  readonly limit?: number;
}

export interface Match {
  readonly id: string;
  readonly kind: NodeKind;
  readonly projectId: string;
  readonly sessionId: string | null;
  readonly createdAt: string;
  /** Start of the original text. Call read_evidence for the full text before relying on it. */
  readonly snippet: string;
  readonly utility: number;
  /** vector/text: matched the query directly. graph: reached by following edges from a match. */
  readonly foundBy: "vector" | "text" | "graph";
  readonly path: readonly Hop[];
  readonly projectName: string;
  readonly fromOtherProject: boolean;
  /** Later user statements that clearly correct or retract this one; the newest is current. */
  readonly supersededBy: readonly {
    readonly id: string;
    readonly relation: "corrects" | "retracts";
  }[];
  /** Later statements that may correct or retract this one but could not be tied to it for sure. */
  readonly unconfirmedChallenges: number;
}

export interface FindResult {
  readonly matches: readonly Match[];
  /** False when more matches exist beyond `limit` or graph expansion stopped at its budget. */
  readonly complete: boolean;
  /** Search paths that failed and were skipped, e.g. vector search without the model. */
  readonly degraded: readonly ("vector" | "morph")[];
  /**
   * Statements not embedded yet; they are only reachable by text match or graph edges, as tool calls
   * and results always are.
   */
  readonly unindexed: number;
  /**
   * Statements not interpreted yet (or whose interpretation failed): they have no topics and no
   * correction links, so a missing correction there proves nothing.
   */
  readonly uninterpreted: number;
}

export class NativeMemorySearchFailed extends Schema.TaggedError<NativeMemorySearchFailed>()(
  "NativeMemorySearchFailed",
  {
    reason: Schema.Literals(["budget-exceeded", "invalid-input", "read-failed", "index-failed"]),
  },
) {}

const snippetLength = 300;
const defaultLimit = 12;
/** Standard Reciprocal Rank Fusion constant; damps the gap between neighbouring ranks. */
const fusionK = 60;

/**
 * Merges ranked id lists by Reciprocal Rank Fusion. Cosine and BM25 scores are not comparable,
 * so only ranks are used. A node first in every list gets 1; first in one of two equally weighted
 * lists gets 0.5. Equal scores keep the order of the lists: a node the first list holds comes out
 * ahead.
 */
export function fuseRanks(input: {
  readonly lists: readonly (readonly string[])[];
  readonly weights?: readonly number[];
}): MutableHashMap.MutableHashMap<string, number> {
  const { lists, weights = input.lists.map(() => 1) } = input;
  const scores = MutableHashMap.empty<string, number>();
  lists.forEach((list, index) => {
    const weight = weights[index] ?? 1;
    list.forEach((id, rank) =>
      MutableHashMap.set(
        scores,
        id,
        (Option.getOrUndefined(MutableHashMap.get(scores, id)) ?? 0) +
          weight / (fusionK + rank + 1),
      ),
    );
  });
  const best = weights.reduce((sum, weight) => sum + weight, 0) / (fusionK + 1);
  return MutableHashMap.fromIterable([...scores].map(([id, score]) => [id, score / best]));
}

/**
 * Whether a query names something exactly: an error code, a path or file name, an identifier, a
 * version, a hash, a port. Such a query is answered by the text match, not by meaning.
 */
export function namesSomethingExactly(query: string) {
  return query
    .split(/\s+/u)
    .some(
      (term) =>
        /[A-Za-z0-9][_\-./:@][A-Za-z0-9]/u.test(term) ||
        /[a-z][A-Z]/u.test(term) ||
        (/[A-Za-z]/u.test(term) && /\d/u.test(term)) ||
        /^[A-Z]{5,}$/u.test(term) ||
        /^\d{3,}$/u.test(term),
    );
}

const Id = Schema.Struct({ id: Schema.String });
// Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
const decodeId = EffectFunction.flow(Schema.decodeUnknownResult(Id), Result.getOrThrow);
const Count = Schema.Struct({ count: Schema.Finite });
// Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
const decodeCount = EffectFunction.flow(Schema.decodeUnknownResult(Count), Result.getOrThrow);
// Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
const decodeName = EffectFunction.flow(
  Schema.decodeUnknownResult(Schema.Struct({ name: Schema.String })),
  Result.getOrThrow,
);
// Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
const decodeChallenge = EffectFunction.flow(
  Schema.decodeUnknownResult(
    Schema.Struct({ from_id: Schema.String, kind: Schema.Literals(["corrects", "retracts"]) }),
  ),
  Result.getOrThrow,
);

/** Splits a question into search terms; trigram FTS needs 3+ characters, shorter terms use LIKE. */
export function searchTerms(query: string) {
  const terms = EffectArray.dedupe(
    query.split(/[\s,.;:!?()[\]{}"'`]+/u).filter((term) => term.length >= 2),
  );
  return {
    trigram: terms.filter((term) => term.length >= 3),
    short: terms.filter((term) => term.length === 2),
  };
}

/** What the recall evaluation varies; the app searches with {@link searchTuning}. */
export interface SearchTuning {
  /** Rank by trigram and short substring matches too. */
  readonly text: boolean;
  /**
   * Whether a query that names something exactly ({@link namesSomethingExactly}) puts the text
   * ranking first, so it wins ties, weighted by `exactTextWeight` against 1 for the others.
   */
  readonly exactFirst: boolean;
  readonly exactTextWeight: number;
}

export const searchTuning: SearchTuning = {
  text: true,
  exactFirst: true,
  exactTextWeight: 2,
};

const make = (tuning: SearchTuning) =>
  Effect.gen(function* () {
    const { sqlite } = yield* Database;
    const embedder = yield* Embedder;
    const vectors = yield* VectorIndex;
    const graph = yield* Graph;
    const analyzer = yield* MorphAnalyzer;
    const supersededBy = sqlite.prepare(`
    SELECT e.from_id, e.kind FROM edges e
    JOIN nodes n ON n.id = e.from_id JOIN nodes t ON t.id = e.to_id
    WHERE e.to_id = ? AND e.kind IN ('corrects', 'retracts') AND ${changeAuthoritySql("n", "t")}
    ORDER BY n.seq`);
    // A question later resolved into an applied relation is no longer unconfirmed.
    const unconfirmedOf = sqlite.prepare(`
    SELECT count(*) AS count FROM interpretations i
    JOIN nodes n ON n.id = i.node_id JOIN nodes t ON t.id = i.target_id
    WHERE i.target_id = ? AND i.status = 'unconfirmed' AND i.kind IN ('corrects', 'retracts')
      AND ${changeAuthoritySql("n", "t")}
      AND NOT EXISTS (
        SELECT 1 FROM edges e WHERE e.from_id = i.node_id AND e.to_id = i.target_id AND e.kind = i.kind
      )`);
    const nameOf = sqlite.prepare("SELECT name FROM projects WHERE id = ?");
    const projectName = (projectId: string) => {
      const row = nameOf.get(projectId);
      return isTruthy(row) ? decodeName(row).name : projectId;
    };

    const allowedProjects = (projectId: string, crossProject: boolean) =>
      crossProject
        ? [
            projectId,
            ...sqlite
              .prepare("SELECT id FROM projects WHERE cross_recall_excluded = 0 AND id != ?")
              .all(projectId)
              .map((row) => decodeId(row).id),
          ]
        : [projectId];

    const collectSeeds = Effect.fnUntraced(function* (
      input: FindInput,
      allowed: readonly string[],
      limit: number,
      degraded: ("vector" | "morph")[],
    ) {
      // Model/network stays in the host, outside the publication admission permit.
      const query = yield* embedder.embed([input.query]).pipe(
        Effect.map((values) => values[0]),
        Effect.catch(() => {
          degraded.push("vector");
          return Effect.void;
        }),
      );
      const terms = yield* Effect.gen(function* () {
        if (!analyzer.ready()) {
          analyzer.warm();
          return yield* new MorphAnalysisFailed({ reason: "not_ready" });
        }
        const [tokens = []] = yield* analyzer.terms([input.query]);
        return EffectArray.dedupe(tokens).filter((term) => term.length > 0);
      }).pipe(
        Effect.catch(() => {
          if (analyzer.identity !== "none") degraded.push("morph");
          return Effect.succeed([]);
        }),
      );
      const grouped = searchTerms(input.query);
      const { result } = yield* vectors.backend.read({
        allowedProjects: allowed,
        embedder: embedder.identity,
        query: limit > 0 && query !== undefined ? new Float32Array(query) : undefined,
        trigramTerms: grouped.trigram,
        shortTerms: grouped.short,
        morphTerms: terms,
        vectorK: limit * 4,
        textK: limit * 2,
        morphK: limit * 2,
        textEnabled: tuning.text && limit > 0,
        morphEnabled: limit > 0 && terms.length > 0,
        remainingMs: 2000,
        inputBudgetBytes: 1048576,
        outputBudgetBytes: 1048576,
      });
      switch (result.kind) {
        case "cancelled":
          return yield* Effect.interrupt;
        case "success": {
          if (result.vectorUnavailable && !degraded.includes("vector")) degraded.unshift("vector");
          return {
            byVector: result.vectorIds,
            byText: result.textIds,
            byMorph: result.morphIds,
            coverage: {
              unindexed: result.unindexed,
              uninterpreted: result.uninterpreted,
            },
          };
        }
        default:
          return yield* NativeMemorySearchFailed.make({ reason: result.kind });
      }
    });

    const find = (input: FindInput) =>
      Effect.gen(function* () {
        const limit = input.limit ?? defaultLimit;
        const allowed = allowedProjects(input.projectId, input.crossProject ?? true);
        const degraded: ("vector" | "morph")[] = [];

        const { byVector, byText, byMorph, coverage } = yield* collectSeeds(
          input,
          allowed,
          limit,
          degraded,
        );
        // The vector list is always full, related or not. For a query that names something
        // exactly it would outvote the text match, so the text ranking goes first and counts more.
        const morph = byMorph.length > 0 ? [byMorph] : [];
        const seeds =
          tuning.text && tuning.exactFirst && namesSomethingExactly(input.query)
            ? fuseRanks({
                lists: [byText, ...morph, byVector],
                weights: [tuning.exactTextWeight, ...morph.map(() => 1), 1],
              })
            : fuseRanks({ lists: [byVector, byText, ...morph] });
        const vectorIds = HashSet.fromIterable(byVector);

        const walk = graph.traverse(seeds, {
          budget: limit * 4,
          minUtility: 0.2,
          projectIds: allowed,
          includeEmpty: false,
        });
        const { unindexed, uninterpreted } = coverage;

        const matches: Match[] = [];
        for (const visit of walk.visits) {
          if (matches.length === limit) break;
          let foundBy: Match["foundBy"] = "graph";
          if (visit.path.length === 0)
            foundBy = HashSet.has(vectorIds, visit.node.id) ? "vector" : "text";
          matches.push({
            id: visit.node.id,
            kind: visit.node.kind,
            projectId: visit.node.projectId,
            sessionId: visit.node.sessionId,
            createdAt: visit.node.createdAt,
            snippet: visit.node.text.slice(0, snippetLength),
            utility: Math.round(visit.utility * 1000) / 1000,
            foundBy,
            path: visit.path,
            projectName: projectName(visit.node.projectId),
            fromOtherProject: visit.node.projectId !== input.projectId,
            supersededBy: supersededBy.all(visit.node.id).map((row) => {
              const challenge = decodeChallenge(row);
              return { id: challenge.from_id, relation: challenge.kind };
            }),
            unconfirmedChallenges: decodeCount(unconfirmedOf.get(visit.node.id)).count,
          });
        }
        return {
          matches,
          complete: walk.complete && walk.visits.length <= limit,
          degraded,
          unindexed,
          uninterpreted,
        } satisfies FindResult;
      });

    return { find, allowedProjects };
  });

/** Finds prior messages: vector and text matches seed a graph walk over the memory. */
export class MemorySearch extends Context.Service<
  MemorySearch,
  Effect.Success<ReturnType<typeof make>>
>()("memory-agent/memory/search/MemorySearch") {
  static readonly layer = Layer.effect(MemorySearch, make(searchTuning));
  /** The search with some settings changed, for the recall evaluation. */
  static readonly tuned = (tuning: Partial<SearchTuning>) =>
    Layer.effect(MemorySearch, make({ ...searchTuning, ...tuning }));
}
