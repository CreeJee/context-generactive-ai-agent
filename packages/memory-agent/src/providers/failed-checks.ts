/** A condition that refuses something when it holds, and the reason shown for it. */
export type Check = readonly [failed: boolean, reason: string];

/** The reasons of the checks that failed, in the order they are listed. */
export const failedReasons = (checks: ReadonlyArray<Check>) =>
  checks.filter(([failed]) => failed).map(([, reason]) => reason);
