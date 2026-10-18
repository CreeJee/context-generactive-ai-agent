import { browserCrypto } from "../shared/browser-crypto";
import { Effect, Fiber, Schedule } from "effect";
import { runUiEffect, uiPromise } from "../shared/ui-effect";
import { isTruthy } from "../../truthy.ts";
import { useEffect, useState } from "react";
import { api, type LeaseView, type SessionRunState } from "../api";
import { useProjectScope } from "../events/context";
import { useObservedRunStateQuery } from "../queries/session";

import { orderedLeaseActions } from "./lease-actions";

const runLeaseAction = orderedLeaseActions();
if (import.meta.hot !== undefined) import.meta.hot.dispose(() => runLeaseAction.dispose());
const leaseAction = (sessionId: string, holder: string, action: "claim" | "release") =>
  runLeaseAction(sessionId, () => api.leaseAction(sessionId, holder, action));

const holderKey = "context-agent:page-holder";
/** An owning page renews well inside the server's 90s lease, even with background-tab throttling. */
const renewMs = 20_000;

const newHolder = () => {
  // Browser boundary: session ownership requires a cryptographic token.
  const created = Effect.runSync(browserCrypto.randomUUIDv4());
  try {
    sessionStorage.setItem(holderKey, created);
  } catch {}
  return created;
};

/**
 * This page's identity for session ownership. Kept in sessionStorage, so a reload is still the same
 * page (and keeps its session), while every other tab or window is a different one. A duplicated
 * tab starts with a copy of it until `pageIdentity` gives it its own.
 */
export function pageHolder() {
  try {
    const existing = sessionStorage.getItem(holderKey);
    if (isTruthy(existing)) return existing;
  } catch {}
  return newHolder();
}

/** Holds a lock named after `holder` for the page's lifetime; false if another page holds it. */
const holdIdentity = (holder: string) =>
  Effect.callback<boolean>((resume) => {
    void navigator.locks.request(
      `context-agent:holder:${holder}`,
      { ifAvailable: true },
      (lock) => {
        resume(Effect.succeed(lock !== null));
        // Released only when the page goes away.
        return lock === null ? undefined : Effect.runPromise(Effect.never);
      },
    );
  });

let identity: Promise<string> | null = null;
/**
 * This page's holder once no other open page shares it. Duplicating a tab copies sessionStorage,
 * so the copy finds the original's lock taken and switches to a new holder of its own. A reload
 * is the same page: the old document's lock is gone by then.
 */
export function pageIdentity() {
  identity ??= runUiEffect(
    Effect.gen(function* () {
      const holder = pageHolder();
      if (typeof navigator === "undefined" || navigator.locks === undefined) return holder;
      if (yield* holdIdentity(holder)) return holder;
      const fresh = newHolder();
      yield* holdIdentity(fresh);
      return fresh;
    }),
  );
  return identity;
}

export type PageLease = { readonly state: "checking" } | LeaseView;

/** What a read-only page has seen of the session's runs; a change means there is more to show. */
const runRevision = (state: SessionRunState) =>
  [state.running?.runId, state.lastRun?.runId, state.lastRun?.status].join("|");

/**
 * Session ownership: owner renewal remains a heartbeat; read-only observation follows SSE. A
 * read-only page takes the session over as soon as it is free.
 */
export function useSessionLease(sessionId: string) {
  const projectId = useProjectScope("session_lease");
  const [holder, setHolder] = useState(pageHolder);
  const [identified, setIdentified] = useState(false);
  const [lease, setLease] = useState<PageLease>({ state: "checking" });
  const [revision, setRevision] = useState("");
  const [refused, setRefused] = useState(false);

  useEffect(() => {
    let current = true;
    void pageIdentity().then((own) => {
      if (!current) return;
      setHolder(own);
      setIdentified(true);
    });
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    if (!identified) return;
    let current = true;
    setLease({ state: "checking" });
    void leaseAction(sessionId, holder, "claim").then(
      (view) => current && setLease(view),
      () => {},
    );
    const leave = () =>
      navigator.sendBeacon(
        `/api/sessions/${encodeURIComponent(sessionId)}/lease`,
        new Blob([JSON.stringify({ holder, action: "release" })], { type: "application/json" }),
      );
    window.addEventListener("pagehide", leave);
    return () => {
      current = false;
      window.removeEventListener("pagehide", leave);
      void leaseAction(sessionId, holder, "release").catch(() => {});
    };
  }, [sessionId, holder, identified]);

  const owning = lease.state === "mine";
  const observed = useObservedRunStateQuery(
    projectId,
    sessionId,
    holder,
    lease.state !== "checking" && !owning,
  );
  useEffect(() => {
    if (!isTruthy(observed.data) || owning) return;
    setLease(observed.data.lease);
    setRevision(runRevision(observed.data));
    if (observed.data.lease.state !== "free") return;
    // The owner left or stopped renewing. Pages racing for it ask the server; one wins.
    let current = true;
    void leaseAction(sessionId, holder, "claim").then(
      (view) => current && setLease(view),
      () => {},
    );
    return () => {
      current = false;
    };
  }, [observed.data, owning, sessionId, holder]);

  useEffect(() => {
    if (!owning) return;
    let current = true;
    const tick = () =>
      leaseAction(sessionId, holder, "claim").then((view) => current && setLease(view));
    const task = Effect.runFork(
      uiPromise(tick).pipe(
        // A missed renewal is retried on the next tick; the lease view shows who holds it.
        Effect.catchTag("UnknownError", () => Effect.void),
        Effect.forkChild,
        Effect.repeat(Schedule.spaced(renewMs)),
        Effect.delay(renewMs),
      ),
    );
    return () => {
      current = false;
      void Effect.runFork(Fiber.interrupt(task));
    };
  }, [sessionId, holder, owning]);

  /** "이어서 작업": claims the session if it is still free when asked. */
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const continueHere = () =>
    runUiEffect(
      Effect.gen(function* () {
        const view = yield* uiPromise(() => leaseAction(sessionId, holder, "claim"));
        setLease(view);
        setRefused(view.state !== "mine");
      }),
    );

  return { holder, lease, revision, refused, continueHere };
}
