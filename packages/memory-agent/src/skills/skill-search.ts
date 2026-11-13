import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  Array as EffectArray,
  Context,
  Effect,
  HashMap,
  Iterable,
  Layer,
  Option,
  Order,
  Schema,
  Semaphore,
} from "effect";
import { Digest } from "effect/crypto";
import { Hex } from "effect/encoding";
import { SqlClient, SqlSchema } from "effect/sql";
import type { Fenced } from "../files/paths.ts";
import { Embedder, EmbedderRuntime } from "../memory/embedding/embedder.ts";
import type { Project } from "../projects/projects.ts";
import { fallbackLogged, logFailure } from "../runtime/logged-failures.ts";
import { ProjectSkills } from "./project-skills.ts";
import type { Skill } from "./skills.ts";

/** What a skill's vector is made from: what the model reads of it before reading the skill. */
const embeddedText = (skill: Skill) => `${skill.name}: ${skill.description}`;

/**
 * Reciprocal rank fusion's constant (Cormack et al., 2009): a skill's score from each ranking is
 * 1 / (k + rank), so the word match and the meaning match add up without comparing their scores.
 */
const fusionK = 60;

/** Hashes per statement, below SQLite's variable limit. */
const hashesPerStatement = 500;

/** The words of a text, lowercased; one-character words match too much to count. */
const words = (text: string) =>
  EffectArray.dedupe(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 1),
  );

/**
 * Whether a query word is a skill's word: the same, or the skill's word with an ending, as a Korean
 * particle (테스트를) or an English inflection (tests) adds one.
 */
const sameWord = (queryWord: string, skillWord: string) => queryWord.startsWith(skillWord);

/**
 * The skills that share words with the query, each scored by the BM25 inverse document frequency
 * of the words it shares: a word most skills have, such as "the" or "run", counts for little.
 */
const byWords = (catalog: readonly Skill[], query: string) => {
  const skillWords = catalog.map((skill) => words(`${skill.name} ${skill.description}`));
  const holds = (index: number, word: string) =>
    (skillWords[index] ?? []).some((skillWord) => sameWord(word, skillWord));
  const weights = words(query).map((word) => {
    const holding = EffectArray.countBy(skillWords, (_, index) => holds(index, word));
    return {
      word,
      weight: Math.log((catalog.length - holding + 0.5) / (holding + 0.5) + 1),
    };
  });
  return catalog.flatMap((skill, index) => {
    const shared = weights.filter(({ word }) => holds(index, word));
    return shared.length === 0
      ? []
      : [{ skill, score: shared.reduce((sum, { weight }) => sum + weight, 0) }];
  });
};

/** Vectors are L2-normalized, so their dot product is their cosine. */
const similarity = (left: Float32Array, right: Float32Array) =>
  left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);

const byScore = Order.mapInput(
  Order.flip(Order.Number),
  ({ score }: { readonly score: number }) => score,
);

/**
 * The skills of `catalog` that fit `query` best, at most `limit`: the ones sharing its words and,
 * when there is a query vector, the ones closest in meaning, fused by reciprocal rank. A skill
 * without a vector is ranked by its words alone.
 */
export const rankSkills = (input: {
  readonly catalog: readonly Skill[];
  readonly query: string;
  readonly queryVector: Option.Option<Float32Array>;
  readonly vectorOf: (skill: Skill) => Option.Option<Float32Array>;
  readonly limit: number;
}): readonly Skill[] => {
  const { catalog, query, queryVector, vectorOf, limit } = input;
  const byMeaning = Option.match(queryVector, {
    onNone: () => [],
    onSome: (vector) =>
      catalog.flatMap((skill) =>
        Option.toArray(
          Option.map(vectorOf(skill), (skillVector) => ({
            skill,
            score: similarity(vector, skillVector),
          })),
        ),
      ),
  });
  const fused = [byWords(catalog, query), byMeaning].reduce(
    (scores, ranking) =>
      EffectArray.sort(ranking, byScore).reduce(
        (sum, { skill }, index) =>
          HashMap.set(
            sum,
            skill.name,
            Option.getOrElse(HashMap.get(sum, skill.name), () => 0) + 1 / (fusionK + index + 1),
          ),
        scores,
      ),
    HashMap.empty<string, number>(),
  );
  return EffectArray.sort(
    catalog.flatMap((skill) =>
      Option.toArray(Option.map(HashMap.get(fused, skill.name), (score) => ({ skill, score }))),
    ),
    byScore,
  )
    .slice(0, limit)
    .map(({ skill }) => skill);
};

const bytesOf = (vector: Float32Array) =>
  new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
/**
 * Copied out of the row's buffer, which may be a larger shared pool (a Node Buffer), so the floats
 * are only the row's and start on a 4-byte boundary.
 */
const vectorOf = (bytes: Uint8Array) =>
  new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

const VectorRow = Schema.Struct({ textSha256: Schema.String, vector: Schema.Uint8Array });

/** What a search found, and how many skills it compared by words only, their meaning not. */
export interface FoundSkills {
  readonly skills: readonly Skill[];
  readonly wordsOnly: number;
}

const make = Effect.gen(function* () {
  const skills = yield* ProjectSkills;
  const embedder = yield* Embedder;
  const sql = yield* SqlClient.SqlClient;
  const digest = yield* Digest.Digest;
  const scope = yield* Effect.scope;
  // One embedding of missing vectors at a time: runs started together find the same ones missing.
  const oneAtATime = yield* Semaphore.make(1);

  const hashed = (catalog: readonly Skill[]) =>
    Effect.forEach(EffectArray.dedupe(catalog.map(embeddedText)), (text) =>
      Effect.map(
        digest.digest(Digest.sha256, new TextEncoder().encode(text)),
        (hash) => ({ text, hash: Hex.encode(hash) }) as const,
      ),
    );

  const selectVectors = SqlSchema.findAll({
    Request: Schema.Array(Schema.String),
    Result: VectorRow,
    execute: (hashes) => sql`
      SELECT text_sha256 AS textSha256, vector FROM skill_vectors
      WHERE embedder = ${embedder.identity} AND text_sha256 IN ${sql.in(hashes)}`,
  });

  /** The stored vectors of these texts, by the text's hash. */
  const storedVectors = (hashes: readonly string[]) =>
    Effect.map(
      Effect.forEach(Iterable.chunksOf(hashes, hashesPerStatement), selectVectors),
      (rows) =>
        HashMap.fromIterable(
          Iterable.map(rows.flat(), (row) => [row.textSha256, vectorOf(row.vector)] as const),
        ),
    );

  /**
   * Embeds and stores the vectors of the catalog's skills that have none yet, in the background:
   * nothing waits for it. Long descriptions take their time: this project's 122 skills took over
   * three minutes on the CPU.
   */
  const embedMissing = Effect.fn("SkillSearch.embedMissing")(function* (catalog: readonly Skill[]) {
    const texts = yield* hashed(catalog);
    const stored = yield* storedVectors(texts.map(({ hash }) => hash));
    const missing = texts.filter(({ hash }) => !HashMap.has(stored, hash));
    if (!EffectArray.isReadonlyArrayNonEmpty(missing)) return;
    const vectors = yield* embedder.embed(
      missing.map(({ text }) => text),
      "document",
      "background",
    );
    yield* sql.withTransaction(
      Effect.andThen(
        Effect.forEach(
          EffectArray.zip(missing, vectors),
          ([{ hash }, vector]) => sql`
            INSERT OR REPLACE INTO skill_vectors (embedder, text_sha256, vector)
            VALUES (${embedder.identity}, ${hash}, ${bytesOf(vector)})`,
          { discard: true },
        ),
        sql`DELETE FROM skill_vectors WHERE embedder <> ${embedder.identity}`,
      ),
    );
  }, oneAtATime.withPermits(1));

  /** Without them, searches compare words only, so a failure is a warning. */
  const inBackground = <E extends { readonly _tag: string }>(work: Effect.Effect<void, E>) =>
    Effect.asVoid(Effect.forkIn(Effect.catch(work, logFailure("Skill vectors not made")), scope));

  /** Whether a query embeds without first waiting for the local model to load. */
  const modelLoaded = () =>
    EmbedderRuntime.$match(embedder.runtime(), {
      local: ({ device }) => device !== null,
      other: () => true,
    });

  /**
   * The skills of `catalog` that fit `query` best, by their stored vectors. Every skill is ranked by
   * its words alone when the query cannot be embedded, or, unless `waitForModel`, while the
   * embedding model is not loaded yet.
   */
  const rank = Effect.fn("SkillSearch.rank")(function* (
    catalog: readonly Skill[],
    query: string,
    limit: number,
    waitForModel: boolean,
  ) {
    const texts = yield* hashed(catalog);
    const hashOf = HashMap.fromIterable(
      Iterable.map(texts, ({ text, hash }) => [text, hash] as const),
    );
    const { stored, queryVector } = yield* Effect.all(
      {
        stored: storedVectors(texts.map(({ hash }) => hash)),
        queryVector:
          waitForModel || modelLoaded()
            ? Effect.map(embedder.embed([query], "query"), EffectArray.head)
            : Effect.succeedNone,
      },
      { concurrency: "unbounded" },
    ).pipe(
      fallbackLogged("Skill search by meaning unavailable", () => ({
        stored: HashMap.empty<string, Float32Array>(),
        queryVector: Option.none<Float32Array>(),
      })),
    );
    const vectorOf = (skill: Skill) =>
      Option.flatMap(HashMap.get(hashOf, embeddedText(skill)), (hash) => HashMap.get(stored, hash));
    return {
      skills: rankSkills({ catalog, query, queryVector, vectorOf, limit }),
      wordsOnly: Option.isSome(queryVector)
        ? EffectArray.countBy(catalog, (skill) => Option.isNone(vectorOf(skill)))
        : catalog.length,
    } satisfies FoundSkills;
  });

  return {
    /** Starts embedding the vectors a run's skills miss, so its first search finds them made. */
    prepare: (project: Fenced<Project>, sessionId: string) =>
      inBackground(
        Effect.flatMap(skills.catalog(project, sessionId), ({ skills: catalog }) =>
          embedMissing(catalog),
        ),
      ),

    /**
     * The skills a run of `sessionId` can use now that fit `query` best. The catalog is read as it
     * is at the call, so a skill deleted meanwhile is never found and one saved meanwhile is.
     * The vectors its skills miss are made in the background, and they are compared by words until
     * then. Without `waitForModel`, as for a suggestion before a model call, a model still loading
     * leaves the meaning out instead of being waited for.
     */
    find: Effect.fn("SkillSearch.find")(function* (
      project: Fenced<Project>,
      sessionId: string,
      query: string,
      limit: number,
      waitForModel: boolean = true,
    ) {
      const { skills: catalog } = yield* skills.catalog(project, sessionId);
      yield* inBackground(embedMissing(catalog));
      return yield* rank(catalog, query, limit, waitForModel);
    }),
  };
});

/**
 * Finds the skills that fit a task among the ones a run can use (decisions.md "스킬은 목록으로
 * 보이지 않고 find_skill로 찾는다 (2026-11-13)").
 */
export class SkillSearch extends Context.Service<SkillSearch, Effect.Success<typeof make>>()(
  "memory-agent/skills/skill-search/SkillSearch",
) {
  static readonly layer = Layer.effect(SkillSearch, make).pipe(Layer.provide(NodeCrypto.layer));
}
