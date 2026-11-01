import { Function as EffectFunction } from "effect";

/** What a page knows when it decides whether to read a run it did not start. */
export interface RunSight {
  /**
   * The server's newest run of the session: the one going, else the one that ended last. Null when
   * the session has none, undefined until the page has the run state.
   */
  readonly latest: string | null | undefined;
  /** The page has read the conversation once. */
  readonly opened: boolean;
  /** The run the page is reading now. */
  readonly reading: string | null;
  /** A turn or an answer of this page is on its way, and reads its own run. */
  readonly sending: boolean;
}

/** The runs a page has read; null until it has seen what its first read covered. */
export type ReadRuns = ReadonlySet<string> | null;

/** What `followRuns` leaves the page with: the runs it has read, and whether it reads again. */
export interface FollowStep {
  readonly read: ReadRuns;
  readonly open: boolean;
}

/**
 * Whether the page reads the conversation again, for a run another tab or the server itself
 * started. The newest run at the page's first sight is what its first read covered. After that, a
 * run the page has not read is read once the page is neither reading nor sending: one still going
 * is joined, and one that already ended shows in the newest page. Each run is tried once, so a run
 * the page cannot join is left to the run notice.
 */
export const followRuns: {
  (sight: RunSight): (read: ReadRuns) => ReturnType<typeof followRunsBody>;
} & typeof followRunsBody = EffectFunction.dual(2, followRunsBody);
function followRunsBody(
  read: ReadRuns,
  { latest, opened, reading, sending }: RunSight,
): FollowStep {
  if (latest === undefined || !opened) return { read, open: false };
  const seen = new Set([
    ...(read ?? (latest === null ? [] : [latest])),
    ...(reading === null ? [] : [reading]),
  ]);
  if (read === null || sending || reading !== null || latest === null || seen.has(latest))
    return { read: seen, open: false };
  return { read: new Set([...seen, latest]), open: true };
}
