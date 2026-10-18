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
import { SqlClient, SqlSchema } from "effect/sql";
import { Embedder } from "./embedding/embedder.ts";
import { VectorIndex } from "./embedding/vector-index.ts";
import { MorphAnalysisFailed, MorphAnalyzer } from "./morph/analyzer.ts";
import { changeAuthoritySql } from "./changes.ts";
import { Graph, type Hop } from "./graph.ts";
import { latestResolver, type LatestEvidence } from "./latest.ts";
import type { NodeKind } from "./nodes.ts";
import { ChunkSpan } from "./embedding/chunks.ts";
import { optionalProperty } from "../optional-property.ts";

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
  /** Matched chunk's start, or original text's start. Read evidence before relying on it. */
  readonly snippet: string;
  /** Exact original UTF-16 span. Pass start as read_evidence's offset. */
  readonly matchedSpan?: ChunkSpan & { readonly unit: "utf16" };
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
  /** Where the recorded corrections/retractions of this statement end. */
  readonly latest: LatestEvidence;
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

const Challenge = Schema.Struct({
  from_id: Schema.String,
  kind: Schema.Literals(["corrects", "retracts"]),
});
const ChainSource = Schema.Struct({
  id: Schema.String,
  seq: Schema.Finite,
  text: Schema.String,
  created_at: Schema.String,
});

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
    const sql = yield* SqlClient.SqlClient;
    const embedder = yield* Embedder;
    const vectors = yield* VectorIndex;
    const graph = yield* Graph;
    const analyzer = yield* MorphAnalyzer;
    const authority = sql.literal(changeAuthoritySql("n", "t"));
    const supersededBy = SqlSchema.findAll({
      Request: Schema.String,
      Result: Challenge,
      execute: (id) => sql`
        SELECT e.from_id, e.kind FROM edges e
        JOIN nodes n ON n.id = e.from_id JOIN nodes t ON t.id = e.to_id
        WHERE e.to_id = ${id} AND e.kind IN ('corrects', 'retracts') AND ${authority}
        ORDER BY n.seq`,
    });
    // A question later resolved into an applied relation is no longer unconfirmed.
    const unconfirmedOf = SqlSchema.findOne({
      Request: Schema.String,
      Result: Schema.Struct({ count: Schema.Finite }),
      execute: (id) => sql`
        SELECT count(*) AS count FROM interpretations i
        JOIN nodes n ON n.id = i.node_id JOIN nodes t ON t.id = i.target_id
        WHERE i.target_id = ${id} AND i.status = 'unconfirmed'
          AND i.kind IN ('corrects', 'retracts') AND ${authority}
          AND NOT EXISTS (SELECT 1 FROM edges e
            WHERE e.from_id = i.node_id AND e.to_id = i.target_id AND e.kind = i.kind)`,
    });
    const sourceRow = SqlSchema.findOne({
      Request: Schema.String,
      Result: ChainSource,
      execute: (id) => sql`SELECT id, seq, text, created_at FROM nodes WHERE id = ${id}`,
    });
    // A failed read stops the search instead of hiding later changes.
    const storageRead = <A, E>(read: Effect.Effect<A, E>) =>
      Effect.mapError(read, () => NativeMemorySearchFailed.make({ reason: "read-failed" }));
    const appliedChanges = (id: string) => storageRead(supersededBy(id));
    const unconfirmedCount = (id: string) =>
      storageRead(Effect.map(unconfirmedOf(id), (row) => row.count));
    const latest = latestResolver({
      appliedChanges: (id) =>
        Effect.map(appliedChanges(id), (rows) =>
          rows.map((change) => ({ sourceId: change.from_id, relation: change.kind })),
        ),
      hasUnconfirmed: (id) => Effect.map(unconfirmedCount(id), (count) => count > 0),
      source: (id) =>
        storageRead(sourceRow(id)).pipe(
          Effect.map((row) => ({
            id: row.id,
            seq: row.seq,
            text: row.text,
            createdAt: row.created_at,
          })),
        ),
    });

    const nameOf = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Schema.Struct({ name: Schema.String }),
      execute: (projectId) => sql`SELECT name FROM projects WHERE id = ${projectId}`,
    });
    const otherProjects = SqlSchema.findAll({
      Request: Schema.String,
      Result: Schema.Struct({ id: Schema.String }),
      execute: (projectId) =>
        sql`SELECT id FROM projects WHERE cross_recall_excluded = 0 AND id != ${projectId}`,
    });
    const ChunkSpans = Schema.Array(
      Schema.Struct({ vector_id: Schema.Finite, ...ChunkSpan.fields }),
    );
    /** Spans of the matched chunk ids, in one read; one-vector nodes have none. */
    const chunkSpans = (vectorIds: readonly number[]) =>
      vectorIds.length === 0
        ? Effect.succeed([])
        : sql`SELECT vector_id, start_offset AS start, end_offset AS end FROM node_vector_chunks
            WHERE embedder = ${embedder.identity} AND vector_id IN ${sql.in(vectorIds)}`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(ChunkSpans)),
          );
    const projectName = (projectId: string) =>
      storageRead(
        Effect.map(
          nameOf(projectId),
          Option.match({ onNone: () => projectId, onSome: (row) => row.name }),
        ),
      );

    const allowedProjects = (projectId: string, crossProject: boolean) =>
      crossProject
        ? storageRead(
            Effect.map(otherProjects(projectId), (rows) => [
              projectId,
              ...rows.map((row) => row.id),
            ]),
          )
        : Effect.succeed([projectId]);

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
          const spanOf = new Map(
            (yield* chunkSpans(result.vectorSeqs.map(Number)).pipe(
              Effect.mapError(() => NativeMemorySearchFailed.make({ reason: "read-failed" })),
            )).map(({ vector_id, start, end }) => [vector_id, { start, end }] as const),
          );
          // Best-ranked chunk per node, keyed by node id. Hits arrive best first, so the first
          // span stored for a node wins.
          const spans = result.vectorSeqs.reduce((spans, seq, index) => {
            const id = result.vectorIds[index]!;
            const span = spanOf.get(Number(seq));
            if (span !== undefined && !MutableHashMap.has(spans, id))
              MutableHashMap.set(spans, id, span);
            return spans;
          }, MutableHashMap.empty<string, ChunkSpan>());
          return {
            byVector: result.vectorIds,
            byText: result.textIds,
            byMorph: result.morphIds,
            spans,
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
        const allowed = yield* allowedProjects(input.projectId, input.crossProject ?? true);
        const degraded: ("vector" | "morph")[] = [];

        const { byVector, byText, byMorph, coverage, spans } = yield* collectSeeds(
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

        const walk = yield* graph.traverse(seeds, {
          budget: limit * 4,
          minUtility: 0.2,
          projectIds: allowed,
          includeEmpty: false,
        });
        const { unindexed, uninterpreted } = coverage;

        const matches = yield* Effect.forEach(walk.visits.slice(0, limit), (visit) =>
          Effect.all({
            latest: latest(visit.node.id),
            projectName: projectName(visit.node.projectId),
            supersededBy: appliedChanges(visit.node.id),
            unconfirmedChallenges: unconfirmedCount(visit.node.id),
          }).pipe(
            Effect.map(({ latest, projectName, supersededBy, unconfirmedChallenges }): Match => {
              const matched = Option.getOrUndefined(MutableHashMap.get(spans, visit.node.id));
              const start = matched?.start ?? 0;
              return {
                id: visit.node.id,
                kind: visit.node.kind,
                projectId: visit.node.projectId,
                sessionId: visit.node.sessionId,
                createdAt: visit.node.createdAt,
                snippet: visit.node.text.slice(start, start + snippetLength),
                ...optionalProperty(
                  "matchedSpan",
                  matched === undefined ? undefined : { ...matched, unit: "utf16" as const },
                ),
                utility: Math.round(visit.utility * 1000) / 1000,
                foundBy:
                  visit.path.length > 0
                    ? "graph"
                    : HashSet.has(vectorIds, visit.node.id)
                      ? "vector"
                      : "text",
                path: visit.path,
                projectName,
                fromOtherProject: visit.node.projectId !== input.projectId,
                supersededBy: supersededBy.map((change) => ({
                  id: change.from_id,
                  relation: change.kind,
                })),
                unconfirmedChallenges,
                latest,
              };
            }),
          ),
        );
        return {
          matches,
          complete: walk.complete && walk.visits.length <= limit,
          degraded,
          unindexed,
          uninterpreted,
        } satisfies FindResult;
      });

    return { find, allowedProjects, latest };
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
