import { Array as EffectArray, Effect, HashSet, Order } from "effect";

export type ChangeRelation = "corrects" | "retracts";

/** A later statement that an applied relation says corrects or retracts the one it was read for. */
export interface AppliedChange {
  readonly sourceId: string;
  readonly relation: ChangeRelation;
}

export interface ChainSource {
  readonly id: string;
  readonly seq: number;
  readonly text: string;
  readonly createdAt: string;
}

/** Storage reads the walk needs. The owner converts its own failures into `E`. */
export interface ChainReads<E> {
  /** Applied changes that satisfy the change-authority rule, oldest first. */
  readonly appliedChanges: (id: string) => Effect.Effect<readonly AppliedChange[], E>;
  readonly hasUnconfirmed: (id: string) => Effect.Effect<boolean, E>;
  readonly source: (id: string) => Effect.Effect<ChainSource, E>;
}

/** A statement that no later applied correction or retraction has changed. */
export interface LatestHead {
  readonly id: string;
  /** How the previous statement in the chain reached this one. */
  readonly relation: ChangeRelation;
  readonly createdAt: string;
  readonly snippet: string;
  /** Changes between the match and this statement. */
  readonly depth: number;
}

/** One end of a branched history; 1 is the most recently recorded. */
export interface BranchHead extends LatestHead {
  readonly recordedRank: number;
}

interface ChainState {
  /** A statement after the match has an unresolved possible change. */
  readonly unconfirmedAfter: boolean;
  /** The walk stopped at its depth limit; a listed head may have later changes. */
  readonly truncated: boolean;
}

/**
 * Where the applied correction/retraction chain of a statement ends. Interpretations are not user
 * confirmation, so a head is a lead to read, not the current truth. One fact holds one value at a
 * time, so `branched` is an anomaly: a misattached correction, a message that bundles several
 * facts, or a real contradiction. Only the originals tell which, so no branch is picked here.
 */
export type LatestEvidence =
  | { readonly kind: "unchanged" }
  | ({ readonly kind: "changed"; readonly head: LatestHead } & ChainState)
  | ({ readonly kind: "branched"; readonly heads: readonly BranchHead[] } & ChainState);

interface ChainEnd {
  readonly change: AppliedChange;
  readonly depth: number;
  /** Statements on the way here, including the match; guards against cycles. */
  readonly path: HashSet.HashSet<string>;
  readonly truncated: boolean;
}

const depthLimit = 6;
const snippetLength = 300;
const newestFirst = Order.mapInput(
  Order.flip(Order.Number),
  (entry: { readonly source: ChainSource }) => entry.source.seq,
);

/** Follows each change until nothing changes it further, the path loops, or the depth runs out. */
function followChanges<E>(
  reads: ChainReads<E>,
  changes: readonly AppliedChange[],
  depth: number,
  path: HashSet.HashSet<string>,
): Effect.Effect<readonly ChainEnd[], E> {
  return Effect.forEach(changes, (change) => {
    const here = HashSet.add(path, change.sourceId);
    const end = (truncated: boolean): readonly ChainEnd[] => [
      { change, depth: depth + 1, path: here, truncated },
    ];
    return reads.appliedChanges(change.sourceId).pipe(
      Effect.map(EffectArray.filter((next) => !HashSet.has(here, next.sourceId))),
      Effect.flatMap(
        EffectArray.match({
          onEmpty: () => Effect.succeed(end(false)),
          onNonEmpty: (next) =>
            depth + 1 < depthLimit
              ? followChanges(reads, next, depth + 1, here)
              : Effect.succeed(end(true)),
        }),
      ),
    );
  }).pipe(Effect.map(EffectArray.flatten));
}

/** Resolves where the recorded changes of a statement end, through the owner's storage reads. */
export const latestResolver = <E>(reads: ChainReads<E>) =>
  Effect.fnUntraced(function* (id: string) {
    const root = HashSet.make(id);
    const ends = EffectArray.dedupeWith(
      yield* Effect.flatMap(reads.appliedChanges(id), (changes) =>
        followChanges(reads, changes, 0, root),
      ),
      (a, b) => a.change.sourceId === b.change.sourceId,
    );
    return yield* EffectArray.match(ends, {
      onEmpty: () => Effect.succeed<LatestEvidence>({ kind: "unchanged" }),
      onNonEmpty: (found) => {
        const after = HashSet.difference(
          EffectArray.reduce(found, HashSet.empty<string>(), (all, end) =>
            HashSet.union(all, end.path),
          ),
          root,
        );
        return Effect.all({
          heads: Effect.forEach(found, (end) =>
            Effect.map(reads.source(end.change.sourceId), (source) => ({ end, source })),
          ),
          unconfirmedAfter: Effect.map(
            Effect.forEach(after, reads.hasUnconfirmed),
            EffectArray.some((pending) => pending),
          ),
        }).pipe(
          Effect.map(({ heads, unconfirmedAfter }): LatestEvidence => {
            const state = { unconfirmedAfter, truncated: found.some((end) => end.truncated) };
            const sorted = EffectArray.map(
              EffectArray.sort(heads, newestFirst),
              ({ end, source }): LatestHead => ({
                id: source.id,
                relation: end.change.relation,
                createdAt: source.createdAt,
                snippet: source.text.slice(0, snippetLength),
                depth: end.depth,
              }),
            );
            return EffectArray.match(EffectArray.tailNonEmpty(sorted), {
              onEmpty: () => ({
                kind: "changed",
                head: EffectArray.headNonEmpty(sorted),
                ...state,
              }),
              onNonEmpty: () => ({
                kind: "branched",
                heads: EffectArray.map(sorted, (head, index) => ({
                  ...head,
                  recordedRank: index + 1,
                })),
                ...state,
              }),
            });
          }),
        );
      },
    });
  });
