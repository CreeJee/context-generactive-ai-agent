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
import { fallbackLogged, ignoreLogged } from "../runtime/logged-failures.ts";
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

/** How many of the query's words the skill's name or description holds. */
const wordMatches = (queryWords: readonly string[], skill: Skill) => {
  const text = `${skill.name} ${skill.description}`.toLowerCase();
  return EffectArray.countBy(queryWords, (word) => text.includes(word));
};

/** Vectors are L2-normalized, so their dot product is their cosine. */
const similarity = (left: Float32Array, right: Float32Array) =>
  left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);

const bytesOf = (vector: Float32Array) =>
  new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
/** Copied, so the floats start on a 4-byte boundary whatever buffer the row came in. */
const vectorOf = (bytes: Uint8Array) => new Float32Array(bytes.slice().buffer);

const VectorRow = Schema.Struct({ textSha256: Schema.String, vector: Schema.Uint8Array });

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

  /** Embeds and stores the vectors of the catalog's skills that have none yet. */
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

  /** Whether a query embeds without first waiting for the local model to load. */
  const modelLoaded = () =>
    EmbedderRuntime.$match(embedder.runtime(), {
      local: ({ device }) => device !== null,
      other: () => true,
    });

  /** Embeds the missing vectors in the background; nothing waits for it. */
  const inBackground = <E extends { readonly _tag: string }>(work: Effect.Effect<void, E>) =>
    Effect.asVoid(Effect.forkIn(work.pipe(ignoreLogged("Skill vectors not made")), scope));

  /**
   * The skills of `catalog` that fit `query` best, at most `limit`: the ones naming its words and
   * the ones closest in meaning, by reciprocal rank fusion. A skill with no vector yet is ranked by
   * its words alone, and every skill is when the query cannot be embedded, or, unless
   * `waitForModel`, while the embedding model is not loaded yet.
   */
  const rank = Effect.fn("SkillSearch.rank")(function* (
    catalog: readonly Skill[],
    query: string,
    limit: number,
    waitForModel: boolean,
  ) {
    const queryWords = words(query);
    const byWords = catalog.flatMap((skill) => {
      const score = wordMatches(queryWords, skill);
      return score > 0 ? [{ skill, score }] : [];
    });
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
    const byMeaning = Option.match(queryVector, {
      onNone: () => [],
      onSome: (vector) =>
        catalog.flatMap((skill) =>
          Option.toArray(
            Option.map(
              Option.flatMap(HashMap.get(hashOf, embeddedText(skill)), (hash) =>
                HashMap.get(stored, hash),
              ),
              (skillVector) => ({ skill, score: similarity(vector, skillVector) }),
            ),
          ),
        ),
    });
    const fused = [byWords, byMeaning].reduce(
      (scores, ranking) =>
        EffectArray.sort(
          ranking,
          Order.mapInput(Order.flip(Order.Number), ({ score }: { score: number }) => score),
        ).reduce(
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
      catalog.filter((skill) => HashMap.has(fused, skill.name)),
      Order.mapInput(Order.flip(Order.Number), (skill: Skill) =>
        Option.getOrElse(HashMap.get(fused, skill.name), () => 0),
      ),
    ).slice(0, limit);
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
     * Without `waitForModel`, a model still loading leaves the meaning out instead of waiting.
     */
    find: Effect.fn("SkillSearch.find")(function* (
      project: Fenced<Project>,
      sessionId: string,
      query: string,
      limit: number,
      waitForModel = true,
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
