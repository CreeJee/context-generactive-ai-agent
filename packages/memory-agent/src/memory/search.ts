import {
  MutableHashMap,
  HashSet,
  Array as EffectArray,
  Function as EffectFunction,
  Option,
  Context,
  Effect,
  Layer,
  Match,
  Result,
  Schema,
} from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { Embedder } from "./embedding/embedder.ts";
import { Reranker } from "./rerank/reranker.ts";
import { VectorIndex } from "./embedding/vector-index.ts";
import { changeAuthoritySql } from "./changes.ts";
import { Graph, type Hop } from "./graph.ts";
import { latestResolver, type LatestEvidence } from "./latest.ts";
import type { NodeKind } from "./nodes.ts";
import { ChunkSpan } from "./embedding/chunks.ts";
import { maxVectorK, type NativeReadInput, ReadStage } from "./native-search/read-protocol.ts";
import { NativeOwnerFailed } from "./native-search/worker-protocol.ts";
import { optionalProperty } from "../optional-property.ts";

export interface FindInput {
  readonly query: string;
  /** The project the conversation belongs to. */
  readonly projectId: string;
  /** Also search projects that have not opted out of cross-project recall. Default true. */
  readonly crossProject?: boolean;
  readonly limit?: number;
  /**
   * Only nodes stored before this seq are found or reached: what memory held when that node was
   * stored, as interpreting a past statement needs. The matches' corrections are still today's.
   */
  readonly beforeSeq?: number;
  /**
   * Orders the top matches by the local reranker when it runs. Measured on find_memory questions
   * and on recall questions (recent user statements joined, as compaction's retrieval asks).
   * Interpretation keeps the fused order: its background searches would hold the worker that the
   * user's searches wait for.
   */
  readonly rerank?: boolean;
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
  /**
   * Search paths that failed and were skipped, e.g. vector search without the model, text matching
   * that ran past its share of the time, or the other projects when reading them ran out of time.
   */
  readonly degraded: readonly ("vector" | "text" | "other-projects")[];
  /** Why the other projects were skipped, when `degraded` names them. */
  readonly otherProjectsSkipped?: SkippedRead;
  /**
   * Statements not embedded yet; they are only reachable by text match or graph edges, as tool calls
   * and results always are.
   */
  readonly unindexed: number;
  /**
   * Node changes the text index has not taken in yet, over every project: text and morph matching
   * miss those nodes until it does. After a rebuild of the index this counts every node.
   */
  readonly textUnindexed: number;
  /**
   * Statements not interpreted yet (or whose interpretation failed): they have no topics and no
   * correction links, so a missing correction there proves nothing.
   */
  readonly uninterpreted: number;
}

export class NativeMemorySearchFailed extends Schema.TaggedError<
  NativeMemorySearchFailed,
  { readonly brand: unique symbol }
>()("NativeMemorySearchFailed", {
  reason: Schema.Literals(["budget-exceeded", "invalid-input", "read-failed", "index-failed"]),
  /** The stage the native read stopped in, when it got that far. */
  stage: Schema.optional(ReadStage),
  /** How long the native read ran before it stopped. */
  elapsedMs: Schema.optional(Schema.Finite),
}) {
  // The model and logs read the reason; without it a failed search looks like an empty one.
  override get message() {
    const where = this.stage === undefined ? "" : ` in the ${this.stage} stage`;
    const after = this.elapsedMs === undefined ? "" : ` after ${Math.round(this.elapsedMs)} ms`;
    return `Memory search stopped (${this.reason})${where}${after}.`;
  }
}

/** A read the search went on without: its failure's reason, and where and when it stopped. */
export interface SkippedRead {
  readonly reason: NativeMemorySearchFailed["reason"] | NativeOwnerFailed["reason"];
  readonly stage?: NativeMemorySearchFailed["stage"];
  readonly elapsedMs?: number;
}

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
 * The seeds with the fused scores of `ranked` handed out again in its order: the reranker decides
 * the order among its candidates, and the fusion keeps the scale the graph walk's utility floor
 * reads.
 */
function reorderSeeds(
  seeds: MutableHashMap.MutableHashMap<string, number>,
  ranked: readonly string[],
): MutableHashMap.MutableHashMap<string, number> {
  const scores = ranked
    .map((id) => Option.getOrElse(MutableHashMap.get(seeds, id), () => 0))
    .toSorted((left, right) => right - left);
  const reordered = MutableHashMap.fromIterable(seeds);
  ranked.forEach((id, index) => MutableHashMap.set(reordered, id, scores[index]!));
  return reordered;
}

/**
 * Ids the reranker scores from the top of each channel's list, in turns: the setting measured
 * (docs/memory-search-measurements.md).
 */
const rerankDepth = 10;

/** The lists' ids in turns: every list's first, then every list's second, and so on. */
const alternate = (lists: readonly (readonly string[])[]) =>
  Array.from({ length: Math.max(0, ...lists.map((list) => list.length)) }, (_, rank) =>
    lists.flatMap((list) => list.slice(rank, rank + 1)),
  ).flat();

/** How per-project rank lists join into one: alternating, own first, or appended per project. */
const mergeRanks = (
  lists: readonly (readonly string[])[],
  merge: SearchTuning["otherProjectMerge"],
) => (merge === "append" ? lists.flat() : alternate(lists));

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

/**
 * How many text terms of each kind one search sends. A recall question joins recent turns (up to
 * 6000 characters) into hundreds of terms, and each one widened the text query, so long questions
 * ran out of the 2 s budget (docs/memory-search-measurements.md). Real find_memory questions have
 * at most 8 of each. Morph terms are not capped: the lexical index splits the question itself and
 * scores them in one pass.
 */
export const maxSearchTerms = { trigram: 24, short: 8 } as const;

/** Looks like a name: code, a path, a version, an issue number, or a Latin-script acronym. */
const nameLike = /[0-9_./#@:-]|[a-z][A-Z]|^[A-Z]{2,}$/u;

/**
 * The terms worth searching first: names before words, then longer before shorter (rarer, so
 * they discriminate more), then in question order.
 */
export const keepTerms: {
  (max: number): (terms: readonly string[]) => string[];
} & typeof keepTermsBody = EffectFunction.dual(2, keepTermsBody);
function keepTermsBody(terms: readonly string[], max: number): string[] {
  return terms.length <= max
    ? [...terms]
    : terms
        .map((term, index) => ({ term, index, name: nameLike.test(term) }))
        .sort(
          (a, b) =>
            Number(b.name) - Number(a.name) || b.term.length - a.term.length || a.index - b.index,
        )
        .slice(0, max)
        .sort((a, b) => a.index - b.index)
        .map(({ term }) => term);
}

/**
 * Splits a question into text search terms: 3+ characters are searched as trigram phrases, two
 * characters by the grams that start or end with them.
 */
export function searchTerms(query: string) {
  const terms = EffectArray.dedupe(
    query.split(/[\s,.;:!?()[\]{}"'`]+/u).filter((term) => term.length >= 2),
  );
  return {
    trigram: keepTerms(
      terms.filter((term) => term.length >= 3),
      maxSearchTerms.trigram,
    ),
    short: keepTerms(
      terms.filter((term) => term.length === 2),
      maxSearchTerms.short,
    ),
  };
}

/** What the recall evaluation varies; the app searches with {@link searchTuning}. */
export interface SearchTuning {
  /** Rank by trigram and short substring matches too. */
  readonly text: boolean;
  /** Rank by the question's morph terms too. */
  readonly morph: boolean;
  /**
   * Whether a query that names something exactly ({@link namesSomethingExactly}) puts the text
   * ranking first, so it wins ties, weighted by `exactTextWeight` against 1 for the others.
   */
  readonly exactFirst: boolean;
  readonly exactTextWeight: number;
  /**
   * Drop vector hits scoring more than this below the best vector hit (cosine gap). The vector
   * list is always full, related or not; a cut trims the tail the other channels must outvote.
   * 0 keeps every hit.
   */
  readonly vectorCut: number;
  /** RRF weights of the channels in the ordinary (not exact-first) fusion. */
  readonly vectorWeight: number;
  readonly textWeight: number;
  readonly morphWeight: number;
  /** How the other projects' text and morph ranks join the own project's: alternating, own first. */
  readonly otherProjectMerge: "alternate" | "append";
}

/**
 * The app's tuning, measured against the real-use relevance set and eval:recall
 * (docs/memory-search-measurements.md S8, 2026-10-30): a heavier vector channel revived
 * related nodes the other channels pushed out of the top ranks; the appended merge of the
 * other projects' ranks passed alone but lost MRR when combined with the heavier vector
 * channel, so it stays alternating.
 */
export const searchTuning: SearchTuning = {
  text: true,
  morph: true,
  exactFirst: true,
  exactTextWeight: 2,
  vectorCut: 0,
  vectorWeight: 2,
  textWeight: 1,
  morphWeight: 1,
  otherProjectMerge: "alternate",
};

const make = (tuning: SearchTuning) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const embedder = yield* Embedder;
    const reranker = yield* Reranker;
    const vectors = yield* VectorIndex;
    const graph = yield* Graph;
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
    const NodeText = Schema.Struct({ id: Schema.String, text: Schema.String });
    const nodeTexts = SqlSchema.findAll({
      Request: Schema.Array(Schema.String),
      Result: NodeText,
      execute: (ids) => sql`SELECT id, text FROM nodes WHERE id IN ${sql.in(ids)}`,
    });
    /**
     * The seeds reordered by the reranker over each channel's first ids; the fused order when the
     * reranker does not answer.
     */
    const rerankSeeds = Effect.fn("MemorySearch.rerank")(function* (
      query: string,
      seeds: MutableHashMap.MutableHashMap<string, number>,
      lists: readonly (readonly string[])[],
    ) {
      const candidates = EffectArray.dedupe(
        alternate(lists.map((list) => list.slice(0, rerankDepth))),
      );
      if (candidates.length === 0) return seeds;
      const textOf = new Map(
        (yield* storageRead(nodeTexts(candidates))).map((row) => [row.id, row.text] as const),
      );
      const present = candidates.flatMap((id) =>
        Option.toArray(Option.map(Option.fromNullishOr(textOf.get(id)), (text) => ({ id, text }))),
      );
      const scores = yield* reranker.score(
        query,
        present.map((candidate) => candidate.text),
      );
      yield* Effect.annotateCurrentSpan({
        candidates: present.length,
        reranked: Option.isSome(scores),
      });
      return Option.match(scores, {
        onNone: () => seeds,
        onSome: (scores) =>
          reorderSeeds(
            seeds,
            present
              .map(({ id }, index) => ({ id, score: scores[index] ?? Number.NEGATIVE_INFINITY }))
              .toSorted((left, right) => right.score - left.score)
              .map(({ id }) => id),
          ),
      });
    });

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

    /** One native read of seeds over some of the allowed projects. */
    const readSeeds = Effect.fn("MemorySearch.readSeeds")(function* (input: NativeReadInput) {
      const { result } = yield* vectors.backend.read(input);
      // Where the read's time went, kept on a failed read too: the stage it stopped in is timed
      // up to the failure.
      // A failed read's outcome and the stage it stopped in, as one flag such as
      // `failure.budget-exceeded.morph`: span attributes keep only numbers and flags. First, so a
      // capped attribute list keeps it.
      const failure =
        result.kind === "success"
          ? {}
          : { [`failure.${result.kind}.${result.failedStage ?? "before-read"}`]: true };
      yield* Effect.annotateCurrentSpan({
        ...failure,
        kind: result.kind,
        allowedProjects: input.allowedProjects.length,
        shortTerms: input.shortTerms.length,
        candidateCount: result.candidateCount,
        sqliteExecutions: result.sqliteExecutions,
        candidateMs: result.candidateMs,
        vectorMs: result.vectorMs,
        mappingMs: result.mappingMs,
        textMs: result.textMs,
        morphMs: result.morphMs,
        coverageMs: result.coverageMs,
        // Inside the text stage: the trigram query, then the short terms that finished. A text
        // failure spent the rest of textMs on the short term it stopped in.
        ...optionalProperty("trigramMs", result.trigramMs ?? undefined),
        shortTermMs: result.shortTermMs,
        shortTermMaxMs: result.shortTermMaxMs,
        shortTermsDone: result.shortTermsDone,
        // Waiting before the worker claimed the read; it already counts against the budget.
        queueMs: result.queueMs,
        textUnavailable: result.textUnavailable,
      });
      return yield* Match.value(result.kind).pipe(
        Match.when("cancelled", () => Effect.interrupt),
        Match.when("success", () =>
          chunkSpans(result.vectorSeqs.map(Number)).pipe(
            Effect.mapError(() => NativeMemorySearchFailed.make({ reason: "read-failed" })),
            Effect.map((rows) => {
              const spanOf = new Map(
                rows.map(({ vector_id, start, end }) => [vector_id, { start, end }] as const),
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
                vector: result.vectorIds.map((id, index) => ({
                  id,
                  score: result.vectorScores[index]!,
                })),
                text: result.textIds,
                morph: result.morphIds,
                vectorUnavailable: result.vectorUnavailable,
                textUnavailable: result.textUnavailable,
                spans,
                coverage: {
                  unindexed: result.unindexed,
                  textUnindexed: result.lexicalPending,
                  uninterpreted: result.uninterpreted,
                },
              };
            }),
          ),
        ),
        Match.orElse((reason) =>
          Effect.fail(
            NativeMemorySearchFailed.make({
              reason,
              ...optionalProperty("stage", result.failedStage ?? undefined),
              elapsedMs:
                result.candidateMs +
                result.vectorMs +
                result.mappingMs +
                result.textMs +
                result.morphMs +
                result.coverageMs,
            }),
          ),
        ),
      );
    });

    const collectSeeds = Effect.fn("MemorySearch.collectSeeds")(function* (
      input: FindInput,
      allowed: readonly string[],
      limit: number,
    ) {
      // Model/network stays in the host, outside the publication admission permit.
      const embedded = yield* embedder.embed([input.query], "query").pipe(
        Effect.map((values) => values[0]),
        Effect.option,
      );
      const query = Option.getOrUndefined(embedded);
      const grouped = searchTerms(input.query);
      const readOver = (projects: readonly string[]) =>
        readSeeds({
          allowedProjects: projects,
          embedder: embedder.identity,
          // Each read transfers its vector's buffer to the worker, so each gets its own copy.
          query: limit > 0 && query !== undefined ? new Float32Array(query) : undefined,
          trigramTerms: grouped.trigram,
          shortTerms: grouped.short,
          // The lexical index splits the question into morph terms itself.
          morphQuery: input.query,
          ...optionalProperty("beforeSeq", input.beforeSeq),
          vectorK: Math.min(limit * 4, maxVectorK),
          textK: limit * 2,
          morphK: limit * 2,
          textEnabled: tuning.text && limit > 0,
          morphEnabled: tuning.morph && limit > 0 && input.query.trim().length > 0,
          remainingMs: 2000,
          inputBudgetBytes: 1048576,
          outputBudgetBytes: 1048576,
        });
      // The conversation's own project is read first, on its own budget. The other projects hold
      // most of the memory; a failed read of them leaves the project's matches standing and says
      // why, so the model can judge whether to search again. The own read's failure fails the
      // search.
      const [own, ...others] = allowed;
      const ownSeeds = yield* readOver([own!]);
      const skip = (skipped: SkippedRead) => Effect.succeed(Result.fail(skipped));
      const otherSeeds =
        others.length === 0
          ? Result.succeed(Option.none())
          : yield* readOver(others).pipe(
              Effect.map((seeds) => Result.succeed(Option.some(seeds))),
              Effect.catchTags({
                NativeMemorySearchFailed: ({ reason, stage, elapsedMs }) =>
                  skip({
                    reason,
                    ...optionalProperty("stage", stage),
                    ...optionalProperty("elapsedMs", elapsedMs),
                  }),
                VectorIndexError: ({ cause }) =>
                  skip({
                    reason: Schema.is(NativeOwnerFailed)(cause) ? cause.reason : "index-failed",
                  }),
              }),
            );
      const scopes = [ownSeeds, ...Option.toArray(Option.flatten(Result.getSuccess(otherSeeds)))];
      const degraded: FindResult["degraded"] = [
        ...(Option.isNone(embedded) || scopes.some((scope) => scope.vectorUnavailable)
          ? ["vector" as const]
          : []),
        ...(scopes.some((scope) => scope.textUnavailable) ? ["text" as const] : []),
        ...(Result.isFailure(otherSeeds) ? ["other-projects" as const] : []),
      ];
      // The projects' matches are disjoint. Cosine scores compare across reads, so vectors merge
      // by score; text and morph lists carry only ranks, so their ranks alternate, own first
      // (S8: append passed alone but lost MRR combined with the heavier vector channel).
      const vectorHits = scopes
        .flatMap((scope) => scope.vector)
        .sort((left, right) => right.score - left.score);
      const bestVector = vectorHits[0]?.score ?? 0;
      return {
        byVector: vectorHits
          .filter((hit) => tuning.vectorCut <= 0 || hit.score >= bestVector - tuning.vectorCut)
          .map((hit) => hit.id),
        byText: mergeRanks(
          scopes.map((scope) => scope.text),
          tuning.otherProjectMerge,
        ),
        byMorph: mergeRanks(
          scopes.map((scope) => scope.morph),
          tuning.otherProjectMerge,
        ),
        spans: MutableHashMap.fromIterable(scopes.flatMap((scope) => [...scope.spans])),
        coverage: {
          // Counts over every project, the same in each read.
          unindexed: ownSeeds.coverage.unindexed,
          textUnindexed: ownSeeds.coverage.textUnindexed,
          uninterpreted: scopes.reduce((sum, scope) => sum + scope.coverage.uninterpreted, 0),
        },
        otherProjectsSkipped: Option.getOrUndefined(Result.getFailure(otherSeeds)),
        degraded,
      };
    });

    const find = (input: FindInput) =>
      Effect.gen(function* () {
        const limit = input.limit ?? defaultLimit;
        const allowed = yield* allowedProjects(input.projectId, input.crossProject ?? true);
        const { byVector, byText, byMorph, coverage, spans, otherProjectsSkipped, degraded } =
          yield* collectSeeds(input, allowed, limit);
        // The vector list is always full, related or not. For a query that names something
        // exactly it would outvote the text match, so the text ranking goes first and counts more.
        const morph = byMorph.length > 0 ? [byMorph] : [];
        const fused =
          tuning.text && tuning.exactFirst && namesSomethingExactly(input.query)
            ? fuseRanks({
                lists: [byText, ...morph, byVector],
                weights: [tuning.exactTextWeight, ...morph.map(() => 1), 1],
              })
            : fuseRanks({
                lists: [byVector, byText, ...morph],
                weights: [
                  tuning.vectorWeight,
                  tuning.textWeight,
                  ...morph.map(() => tuning.morphWeight),
                ],
              });
        const seeds =
          input.rerank === true
            ? yield* rerankSeeds(input.query, fused, [byVector, byMorph, byText])
            : fused;
        const vectorIds = HashSet.fromIterable(byVector);

        const walk = yield* graph.traverse(seeds, {
          budget: limit * 4,
          minUtility: 0.2,
          projectIds: allowed,
          includeEmpty: false,
          ...optionalProperty("beforeSeq", input.beforeSeq),
        });
        const { unindexed, textUnindexed, uninterpreted } = coverage;

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
          ...optionalProperty("otherProjectsSkipped", otherProjectsSkipped),
          unindexed,
          textUnindexed,
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
