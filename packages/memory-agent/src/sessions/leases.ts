import { Context, Layer } from "effect";
import type { ClaimResult, LeaseView } from "./lease-state.ts";

/**
 * A page renews its lease well within this; one that stops (crashed, asleep) loses it. A closing
 * page releases at once, so this only has to be long enough for browsers slowing timers in
 * background tabs.
 */
export const defaultLeaseTtlMs = 90_000;

interface Lease {
  readonly holder: string;
  readonly since: number;
  renewedAt: number;
}

/**
 * Which page may change each session (R03: a session another window is using opens read-only).
 * Leases live in memory: after a restart the page that still has the session open claims it again
 * with its next renewal, and a read-only page never takes over on its own.
 */
export class SessionLeases extends Context.Tag("memory-agent/SessionLeases")<
  SessionLeases,
  ReturnType<typeof makeLeases>
>() {
  static readonly layer = (ttlMs = defaultLeaseTtlMs) =>
    Layer.sync(SessionLeases, () => makeLeases(ttlMs));
}

export function makeLeases(ttlMs: number, now: () => number = Date.now) {
  const leases = new Map<string, Lease>();
  const live = (sessionId: string) => {
    const lease = leases.get(sessionId);
    return lease && now() - lease.renewedAt < ttlMs ? lease : null;
  };

  return {
    view(sessionId: string, holder: string | null): LeaseView {
      const lease = live(sessionId);
      if (!lease) return { state: "free" };
      return lease.holder === holder ? { state: "mine" } : { state: "other", since: lease.since };
    },

    /**
     * Takes or renews the session for `holder`. Refused while another page's lease is live, so two
     * pages asking at once cannot both win: the loser stays read-only.
     */
    claim(sessionId: string, holder: string): ClaimResult {
      const lease = live(sessionId);
      if (lease && lease.holder !== holder) return { claimed: false, heldSince: lease.since };
      if (lease) lease.renewedAt = now();
      else leases.set(sessionId, { holder, since: now(), renewedAt: now() });
      return { claimed: true };
    },

    release(sessionId: string, holder: string) {
      if (leases.get(sessionId)?.holder === holder) leases.delete(sessionId);
    },

    /**
     * Whether a change from `holder` may go ahead: yes when it owns the session, or when nobody does
     * (callers without pages, like tests and scripts, send no holder).
     */
    permits(sessionId: string, holder: string | null) {
      const lease = live(sessionId);
      return !lease || lease.holder === holder;
    },
  };
}
