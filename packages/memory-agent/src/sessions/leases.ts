import { Array as Arr, Clock, Context, Effect, HashMap, Layer, Option, Ref } from "effect";
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
  readonly renewedAt: number;
}

/**
 * Which page may change each session (R03: a session another window is using opens read-only).
 * Leases live in memory: after a restart the page that still has the session open claims it again
 * with its next renewal. When the owner leaves or stops renewing, a read-only page takes over.
 */
export class SessionLeases extends Context.Service<
  SessionLeases,
  Effect.Success<ReturnType<typeof makeLeases>>
>()("memory-agent/sessions/leases/SessionLeases") {
  static readonly layer = (ttlMs = defaultLeaseTtlMs) =>
    Layer.effect(
      SessionLeases,
      Effect.gen(function* () {
        const leases = yield* makeLeases(ttlMs);
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

export const makeLeases = Effect.fnUntraced(function* (ttlMs: number) {
  const leases = yield* Ref.make(HashMap.empty<string, Lease>());
  const expiredListeners = yield* Ref.make<
    ReadonlyArray<(sessionId: string) => Effect.Effect<void>>
  >([]);
  const liveAt = (now: number) => (lease: Lease) => now - lease.renewedAt < ttlMs;
  /** The session's live lease. An expired one is removed as it is read. */
  const live = (sessionId: string) =>
    Effect.flatMap(Clock.currentTimeMillis, (now) =>
      Ref.modify(leases, (current) => {
        const lease = Option.filter(HashMap.get(current, sessionId), liveAt(now));
        return [lease, Option.isSome(lease) ? current : HashMap.remove(current, sessionId)];
      }),
    );

  return {
    /**
     * Remove leases whose pages stopped renewing, including sessions nobody asks about again, and
     * tell the listeners each session is free.
     */
    sweepExpired: Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const expired = yield* Ref.modify(leases, (current) => {
        const gone = Array.from(
          HashMap.keys(HashMap.filter(current, (lease) => !liveAt(now)(lease))),
        );
        return [gone, HashMap.removeMany(current, gone)];
      });
      const listeners = yield* Ref.get(expiredListeners);
      // Each freed session's listeners run in turn, in the order they registered.
      yield* Effect.forEach(
        expired,
        (sessionId) =>
          Effect.forEach(listeners, (listener) => listener(sessionId), { discard: true }),
        { discard: true },
      );
      return expired;
    }),

    /** Run with each session whose lease the sweep found expired. */
    onExpired: (listener: (sessionId: string) => Effect.Effect<void>) =>
      Ref.update(expiredListeners, Arr.append(listener)),

    view: (sessionId: string, holder: string | null) =>
      Effect.map(
        live(sessionId),
        Option.match({
          onNone: (): LeaseView => ({ state: "free" }),
          onSome: (lease): LeaseView =>
            lease.holder === holder ? { state: "mine" } : { state: "other", since: lease.since },
        }),
      ),

    /**
     * Takes or renews the session for `holder`. Refused while another page's lease is live, so two
     * pages asking at once cannot both win: the loser stays read-only.
     */
    claim: (sessionId: string, holder: string) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        Ref.modify(leases, (current): [ClaimResult, HashMap.HashMap<string, Lease>] =>
          Option.match(Option.filter(HashMap.get(current, sessionId), liveAt(now)), {
            onNone: () => [
              { claimed: true },
              HashMap.set(current, sessionId, { holder, since: now, renewedAt: now }),
            ],
            onSome: (lease) =>
              lease.holder === holder
                ? [{ claimed: true }, HashMap.set(current, sessionId, { ...lease, renewedAt: now })]
                : [{ claimed: false, heldSince: lease.since }, current],
          }),
        ),
      ),

    release: (sessionId: string, holder: string) =>
      Ref.update(leases, (current) =>
        Option.exists(HashMap.get(current, sessionId), (lease) => lease.holder === holder)
          ? HashMap.remove(current, sessionId)
          : current,
      ),

    /**
     * Whether a change from `holder` may go ahead: yes when it owns the session, or when nobody does
     * (callers without pages, like tests and scripts, send no holder).
     */
    permits: (sessionId: string, holder: string | null) =>
      Effect.map(
        live(sessionId),
        Option.match({
          onNone: () => true,
          onSome: (lease) => lease.holder === holder,
        }),
      ),
  };
});
