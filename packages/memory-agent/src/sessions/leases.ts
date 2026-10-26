import {
  Clock,
  DateTime,
  Function as EffectFunction,
  MutableHashMap,
  Option,
  Context,
  Effect,
  Layer,
  Schema,
} from "effect";
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
 * with its next renewal. When the owner leaves or stops renewing, a read-only page takes over.
 */
export class SessionLeases extends Context.Service<SessionLeases, ReturnType<typeof makeLeases>>()(
  "memory-agent/sessions/leases/SessionLeases",
) {
  static readonly layer = (ttlMs = defaultLeaseTtlMs) =>
    Layer.effect(
      SessionLeases,
      Effect.gen(function* () {
        const clock = yield* Clock.Clock;
        const leases = makeLeases(ttlMs, () => clock.currentTimeMillisUnsafe());
        // Swept often, so a read-only page hears soon that a vanished owner's session is free.
        yield* Effect.forkScoped(
          Effect.forever(
            Effect.sleep(Math.max(1_000, Math.min(ttlMs, 5_000))).pipe(
              Effect.andThen(leases.sweepExpired),
            ),
          ),
        );
        return leases;
      }),
    );
}

export const makeLeases: {
  (now: () => number): (ttlMs: number) => ReturnType<typeof makeLeasesBody>;
  (ttlMs: number): ReturnType<typeof makeLeasesBody>;
  (ttlMs: number, now: () => number): ReturnType<typeof makeLeasesBody>;
} = EffectFunction.dual((args) => Schema.is(Schema.Finite)(args[0]), makeLeasesBody);
function makeLeasesBody(
  ttlMs: number,
  now: () => number = () => DateTime.toEpochMillis(DateTime.nowUnsafe()),
) {
  const leases = MutableHashMap.empty<string, Lease>();
  const expiredListeners: Array<(sessionId: string) => Effect.Effect<void>> = [];
  const live = (sessionId: string): Option.Option<Lease> =>
    Option.flatMap(MutableHashMap.get(leases, sessionId), (lease) => {
      if (now() - lease.renewedAt < ttlMs) return Option.some(lease);
      MutableHashMap.remove(leases, sessionId);
      return Option.none();
    });

  return {
    /**
     * Remove leases whose pages stopped renewing, including sessions nobody asks about again, and
     * tell the listeners each session is free.
     */
    sweepExpired: Effect.suspend(() => {
      const current = now();
      const expired = Array.from(leases)
        .filter(([, lease]) => current - lease.renewedAt >= ttlMs)
        .map(([sessionId]) => sessionId);
      expired.forEach((sessionId) => MutableHashMap.remove(leases, sessionId));
      // Each freed session's listeners run in turn, in the order they registered.
      return Effect.forEach(
        expired,
        (sessionId) =>
          Effect.forEach(expiredListeners, (listener) => listener(sessionId), { discard: true }),
        { discard: true },
      ).pipe(Effect.as(expired));
    }),

    /** Run with each session whose lease the sweep found expired. */
    onExpired(listener: (sessionId: string) => Effect.Effect<void>) {
      expiredListeners.push(listener);
    },

    view(sessionId: string, holder: string | null): LeaseView {
      return Option.match(live(sessionId), {
        onNone: (): LeaseView => ({ state: "free" }),
        onSome: (lease): LeaseView =>
          lease.holder === holder ? { state: "mine" } : { state: "other", since: lease.since },
      });
    },

    /**
     * Takes or renews the session for `holder`. Refused while another page's lease is live, so two
     * pages asking at once cannot both win: the loser stays read-only.
     */
    claim(sessionId: string, holder: string): ClaimResult {
      return Option.match(live(sessionId), {
        onNone: (): ClaimResult => {
          MutableHashMap.set(leases, sessionId, { holder, since: now(), renewedAt: now() });
          return { claimed: true };
        },
        onSome: (lease): ClaimResult => {
          if (lease.holder !== holder) return { claimed: false, heldSince: lease.since };
          lease.renewedAt = now();
          return { claimed: true };
        },
      });
    },

    release(sessionId: string, holder: string) {
      if (Option.exists(MutableHashMap.get(leases, sessionId), (lease) => lease.holder === holder))
        MutableHashMap.remove(leases, sessionId);
    },

    /**
     * Whether a change from `holder` may go ahead: yes when it owns the session, or when nobody does
     * (callers without pages, like tests and scripts, send no holder).
     */
    permits(sessionId: string, holder: string | null) {
      return Option.match(live(sessionId), {
        onNone: () => true,
        onSome: (lease) => lease.holder === holder,
      });
    },
  };
}
