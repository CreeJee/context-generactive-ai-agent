import { Context, Effect, Layer, Schema } from "effect";
import { Database } from "../db/database.ts";
import { Embedder } from "./embedding/embedder.ts";
import { VectorIndex } from "./embedding/vector-index.ts";
import { MorphAnalysisFailed, MorphAnalyzer } from "./morph/analyzer.ts";
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
  /** Nodes not embedded yet; they are only reachable by text match or graph edges. */
  readonly unindexed: number;
  /**
   * Statements not interpreted yet (or whose interpretation failed): they have no topics and no
   * correction links, so a missing correction there proves nothing.
   */
  readonly uninterpreted: number;
}

const snippetLength = 300;
const defaultLimit = 12;
/** Standard Reciprocal Rank Fusion constant; damps the gap between neighbouring ranks. */
const fusionK = 60;

/**
 * Merges ranked id lists by Reciprocal Rank Fusion. Cosine and BM25 scores are not comparable,
 * so only ranks are used. A node first in every list gets 1; first in one of two lists gets 0.5.
 */
export function fuseRanks(lists: readonly (readonly string[])[]): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists)
    list.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (fusionK + rank + 1)));
  const best = lists.length / (fusionK + 1);
  return new Map([...scores].map(([id, score]) => [id, score / best]));
}

const IdProject = Schema.Struct({ id: Schema.String, project_id: Schema.String });
const decodeIdProject = Schema.decodeUnknownSync(IdProject);
const Id = Schema.Struct({ id: Schema.String });
const decodeId = Schema.decodeUnknownSync(Id);
const Count = Schema.Struct({ count: Schema.Number });
const decodeCount = Schema.decodeUnknownSync(Count);
const decodeName = Schema.decodeUnknownSync(Schema.Struct({ name: Schema.String }));
const decodeChallenge = Schema.decodeUnknownSync(
  Schema.Struct({ from_id: Schema.String, kind: Schema.Literal("corrects", "retracts") }),
);

/** Splits a question into search terms; trigram FTS needs 3+ characters, shorter terms use LIKE. */
export function searchTerms(query: string) {
  const terms = [
    ...new Set(query.split(/[\s,.;:!?()[\]{}"'`]+/u).filter((term) => term.length >= 2)),
  ];
  return {
    trigram: terms.filter((term) => term.length >= 3),
    short: terms.filter((term) => term.length === 2),
  };
}

const make = Effect.gen(function* () {
  const { sqlite } = yield* Database;
  const embedder = yield* Embedder;
  const vectors = yield* VectorIndex;
  const graph = yield* Graph;
  const analyzer = yield* MorphAnalyzer;
  const supersededBy = sqlite.prepare(`
    SELECT e.from_id, e.kind FROM edges e JOIN nodes n ON n.id = e.from_id
    WHERE e.to_id = ? AND e.kind IN ('corrects', 'retracts') ORDER BY n.seq`);
  const unconfirmedOf = sqlite.prepare(
    "SELECT count(*) AS count FROM interpretations WHERE target_id = ? AND status = 'unconfirmed'",
  );
  const nameOf = sqlite.prepare("SELECT name FROM projects WHERE id = ?");
  const projectName = (projectId: string) => {
    const row = nameOf.get(projectId);
    return row ? decodeName(row).name : projectId;
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

  /** Node ids ranked by cosine similarity to the query, best first. */
  const vectorRanking = (query: string, allowed: ReadonlySet<string>, k: number) =>
    Effect.gen(function* () {
      const [queryVector] = yield* embedder.embed([query]);
      if (!queryVector) return [];
      const hits = yield* vectors.search(queryVector, k);
      const bySeq = sqlite.prepare("SELECT id, project_id FROM nodes WHERE seq = ?");
      return hits.flatMap((hit) => {
        const row = bySeq.get(hit.seq);
        if (!row) return [];
        const node = decodeIdProject(row);
        return allowed.has(node.project_id) ? [node.id] : [];
      });
    });

  /**
   * Node ids ranked by morpheme terms (BM25): "로그 형식을 정했었지" meets "로그 포맷은 … 하기로 했다"
   * through 로그, and particles or endings no longer decide the match.
   */
  const morphRanking = (query: string, allowed: readonly string[], k: number) =>
    Effect.gen(function* () {
      if (!analyzer.ready()) {
        analyzer.warm();
        return yield* new MorphAnalysisFailed({ reason: "not_ready" });
      }
      const [terms = []] = yield* analyzer.terms([query]);
      const unique = [...new Set(terms)].filter((term) => term.length > 0);
      if (unique.length === 0) return [];
      const match = unique.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
      const projects = allowed.map(() => "?").join(", ");
      return sqlite
        .prepare(`
          SELECT n.id, n.project_id FROM nodes_morph f JOIN nodes n ON n.seq = f.rowid
          WHERE nodes_morph MATCH ? AND n.project_id IN (${projects})
          ORDER BY bm25(nodes_morph) LIMIT ?`)
        .all(match, ...allowed, k)
        .map((row) => decodeIdProject(row).id);
    });

  /** Node ids ranked by text match: trigram BM25 first, then 2-character substring hits. */
  function textRanking(query: string, allowed: readonly string[], k: number) {
    const { trigram, short } = searchTerms(query);
    const projects = allowed.map(() => "?").join(", ");
    const ranked: string[] = [];
    if (trigram.length > 0) {
      const match = trigram.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
      const rows = sqlite
        .prepare(`
          SELECT n.id, n.project_id FROM nodes_fts f JOIN nodes n ON n.seq = f.rowid
          WHERE nodes_fts MATCH ? AND n.project_id IN (${projects})
          ORDER BY bm25(nodes_fts) LIMIT ?`)
        .all(match, ...allowed, k);
      for (const row of rows) ranked.push(decodeIdProject(row).id);
    }
    for (const term of short) {
      const rows = sqlite
        .prepare(`
          SELECT id, project_id FROM nodes
          WHERE instr(text, ?) > 0 AND project_id IN (${projects})
          ORDER BY seq DESC LIMIT ?`)
        .all(term, ...allowed, k);
      for (const row of rows) {
        const id = decodeIdProject(row).id;
        if (!ranked.includes(id)) ranked.push(id);
      }
    }
    return ranked;
  }

  const find = (input: FindInput) =>
    Effect.gen(function* () {
      const limit = input.limit ?? defaultLimit;
      const allowed = allowedProjects(input.projectId, input.crossProject ?? true);
      const degraded: ("vector" | "morph")[] = [];

      const byVector = yield* vectorRanking(input.query, new Set(allowed), limit * 4).pipe(
        Effect.catchAll(() => {
          degraded.push("vector");
          return Effect.succeed([]);
        }),
      );
      const byText = textRanking(input.query, allowed, limit * 2);
      const byMorph = yield* morphRanking(input.query, allowed, limit * 2).pipe(
        Effect.catchAll(() => {
          if (analyzer.identity !== "none") degraded.push("morph");
          return Effect.succeed([]);
        }),
      );
      const seeds = fuseRanks(
        byMorph.length > 0 ? [byVector, byText, byMorph] : [byVector, byText],
      );
      const vectorIds = new Set(byVector);

      const walk = graph.traverse(seeds, {
        budget: limit * 4,
        minUtility: 0.2,
        projectIds: allowed,
      });
      const unindexed = Schema.decodeUnknownSync(Count)(
        sqlite
          .prepare(`
            SELECT count(*) AS count FROM nodes n
            LEFT JOIN node_vectors v ON v.node_seq = n.seq AND v.embedder = ?
            WHERE v.node_seq IS NULL AND length(n.text) > 0`)
          .get(embedder.identity),
      ).count;

      const uninterpreted = Schema.decodeUnknownSync(Count)(
        sqlite
          .prepare(`
            SELECT count(*) AS count FROM interpret_jobs j JOIN nodes n ON n.id = j.node_id
            WHERE j.status != 'done' AND n.project_id IN (${allowed.map(() => "?").join(", ")})`)
          .get(...allowed),
      ).count;

      const matches = walk.visits.slice(0, limit).map((visit): Match => {
        let foundBy: Match["foundBy"] = "graph";
        if (visit.path.length === 0) foundBy = vectorIds.has(visit.node.id) ? "vector" : "text";
        return {
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
          supersededBy: supersededBy
            .all(visit.node.id)
            .map((row) => decodeChallenge(row))
            .map((challenge) => ({ id: challenge.from_id, relation: challenge.kind })),
          unconfirmedChallenges: decodeCount(unconfirmedOf.get(visit.node.id)).count,
        };
      });
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
export class MemorySearch extends Context.Tag("memory-agent/MemorySearch")<
  MemorySearch,
  Effect.Effect.Success<typeof make>
>() {
  static readonly layer = Layer.effect(MemorySearch, make);
}
