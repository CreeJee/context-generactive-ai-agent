import { Context, Effect, Layer } from "effect";
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
export class SessionLeases extends Context.Service<SessionLeases, ReturnType<typeof makeLeases>>()(
  "memory-agent/SessionLeases",
) {
  static readonly layer = (ttlMs = defaultLeaseTtlMs) =>
    Layer.effect(
      SessionLeases,
      Effect.gen(function* () {
        const leases = makeLeases(ttlMs);
        yield* Effect.forkScoped(
          Effect.forever(
            Effect.sleep(Math.max(1_000, ttlMs)).pipe(
              Effect.andThen(Effect.sync(() => leases.sweepExpired())),
            ),
          ),
        );
        return leases;
      }),
    );
}

export function makeLeases(ttlMs: number, now: () => number = Date.now) {
  const leases = new Map<string, Lease>();
  const live = (sessionId: string) => {
    const lease = leases.get(sessionId);
    if (!lease) return null;
    if (now() - lease.renewedAt < ttlMs) return lease;
    leases.delete(sessionId);
    return null;
  };

  return {
    /** Remove leases whose pages stopped renewing, including sessions nobody asks about again. */
    sweepExpired() {
      const current = now();
      let removed = 0;
      for (const [sessionId, lease] of leases)
        if (current - lease.renewedAt >= ttlMs) {
          leases.delete(sessionId);
          removed += 1;
        }
      return removed;
    },

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
