import { Effect, Array as EffectArray, Schema } from "effect";
import { Embedder } from "../memory/embedding/embedder.ts";
import { sha256 } from "../runtime/synchronous-crypto.ts";
import { Signal } from "./signals.ts";

/** One thing to improve in one repository and the evidence for it. */
export const ImprovementItem = Schema.Struct({
  /** Stable for the same repository, source and grouping key, so a rerun finds the same item. */
  id: Schema.String,
  repository: Schema.String,
  source: Schema.Literals(["correction", "tool_failure", "card_failure"]),
  title: Schema.String,
  /** How many signals it groups; a card counts its failures and replans. */
  count: Schema.Int,
  /** Node ids, or `goal/card` ids for cards; the newest first, at most {@link grouping.evidence}. */
  evidence: Schema.Array(Schema.String),
  excerpts: Schema.Array(Schema.String),
  latestAt: Schema.NullOr(Schema.String),
});
export type ImprovementItem = typeof ImprovementItem.Type;

/** How much repetition makes a signal worth an improvement, and how much evidence an item keeps. */
export const grouping = {
  toolFailureRepeats: 3,
  correctionRepeats: 2,
  /**
   * Cosine similarity of two corrections about the same thing; vectors are L2-normalized. Short
   * Korean messages sit close together: on real use, 0.75 put 103 of 125 corrections in one group,
   * while 0.85 kept groups to one topic.
   */
  correctionSimilarity: 0.85,
  evidence: 20,
  excerpts: 5,
  /**
   * The most repeated items of each kind the model reads in a repository; each costs one model
   * call. Per kind, so frequent tool failures cannot crowd out the corrections. This is the only
   * cut: every item the model reads and keeps goes into the report.
   */
  candidatesPerSource: 5,
} as const;

const itemId = (repository: string, source: ImprovementItem["source"], key: string) =>
  sha256(`${repository}\n${source}\n${key}`).slice(0, 16);

const dot = (a: Float32Array, b: Float32Array) =>
  a.reduce((sum, value, i) => sum + value * b[i], 0);

/**
 * Groups by leader: each vector joins the first group whose first member is similar enough,
 * otherwise it starts a group. Returns member indexes per group, in input order.
 */
export const clusterByVector = (vectors: readonly Float32Array[], threshold: number) =>
  vectors.reduce<number[][]>((groups, vector, index) => {
    const home = groups.find((group) => dot(vectors[group[0]], vector) >= threshold);
    return home === undefined
      ? [...groups, [index]]
      : groups.map((group) => (group === home ? [...group, index] : group));
  }, []);

type Correction = typeof Signal.cases.correction.Type;
type ToolFailure = typeof Signal.cases.tool_failure.Type;
type CardFailure = typeof Signal.cases.card_failure.Type;

const newestFirst = <A extends { readonly createdAt: string }>(signals: readonly A[]) =>
  [...signals].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

const toolFailureItems = (repository: string, failures: readonly ToolFailure[]) =>
  Object.values(
    EffectArray.groupBy(failures, (failure) => `${failure.toolName}\n${failure.signature}`),
  )
    .filter((group) => group.length >= grouping.toolFailureRepeats)
    .map((group): ImprovementItem => {
      const sorted = newestFirst(group);
      return {
        id: itemId(repository, "tool_failure", `${sorted[0].toolName}\n${sorted[0].signature}`),
        repository,
        source: "tool_failure",
        title: `${sorted[0].toolName}: ${sorted[0].signature}`,
        count: group.length,
        evidence: sorted.slice(0, grouping.evidence).map((failure) => failure.nodeId),
        excerpts: sorted.slice(0, grouping.excerpts).map((failure) => failure.excerpt),
        latestAt: sorted[0].createdAt,
      };
    });

const cardItems = (repository: string, cards: readonly CardFailure[]) =>
  cards.map((card): ImprovementItem => ({
    id: itemId(repository, "card_failure", `${card.goalInstanceId}/${card.cardId}`),
    repository,
    source: "card_failure",
    title: card.reason ?? `card ${card.cardId}`,
    count: card.failureStreak + card.replans,
    evidence: [`${card.goalInstanceId}/${card.cardId}`],
    excerpts: card.reason === null ? [] : [card.reason],
    latestAt: null,
  }));

/** Corrections that say the same thing, found by the meaning of what the user wrote. */
const correctionItems = Effect.fn("Improve.correctionItems")(function* (
  repository: string,
  corrections: readonly Correction[],
) {
  const embedder = yield* Embedder;
  const vectors = yield* embedder.embed(corrections.map((correction) => correction.text));
  return clusterByVector(vectors, grouping.correctionSimilarity)
    .filter((group) => group.length >= grouping.correctionRepeats)
    .map((group): ImprovementItem => {
      const sorted = newestFirst(group.map((index) => corrections[index]));
      // The group's first member decided who joined it, so it names the group.
      const leader = corrections[group[0]];
      return {
        id: itemId(repository, "correction", leader.nodeId),
        repository,
        source: "correction",
        title: leader.text.split("\n")[0].slice(0, 120),
        count: group.length,
        evidence: sorted.slice(0, grouping.evidence).map((correction) => correction.nodeId),
        excerpts: sorted
          .slice(0, grouping.excerpts)
          .map((correction) => `${correction.text}\n— 정정 대상: ${correction.corrected}`),
        latestAt: sorted[0].createdAt,
      };
    });
});

/** The improvement items of one repository, the most repeated first. */
export const improvementItems = Effect.fn("Improve.improvementItems")(function* (
  repository: string,
  signals: readonly Signal[],
) {
  const corrections = signals.filter(Signal.guards.correction);
  const fromCorrections = EffectArray.isReadonlyArrayNonEmpty(corrections)
    ? yield* correctionItems(repository, corrections)
    : [];
  return [
    ...fromCorrections,
    ...toolFailureItems(repository, signals.filter(Signal.guards.tool_failure)),
    ...cardItems(repository, signals.filter(Signal.guards.card_failure)),
  ].sort((a, b) => b.count - a.count);
});
