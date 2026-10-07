import { isTruthy } from "../../truthy.ts";
import { useEffect, useState } from "react";
import { api, type LeaseView, type SessionRunState } from "../api";
import { useSessionEventScope } from "../events/context";
import { useObservedRunStateQuery } from "../queries/session";

import { orderedLeaseActions } from "./lease-actions";

const runLeaseAction = orderedLeaseActions();
if (import.meta.hot !== undefined) import.meta.hot.dispose(() => runLeaseAction.dispose());
const leaseAction = (sessionId: string, holder: string, action: "claim" | "release") =>
  runLeaseAction(sessionId, () => api.leaseAction(sessionId, holder, action));

const holderKey = "context-agent:page-holder";
/** An owning page renews well inside the server's 90s lease, even with background-tab throttling. */
const renewMs = 20_000;

/**
 * This page's identity for session ownership. Kept in sessionStorage, so a reload is still the same
 * page (and keeps its session), while every other tab or window is a different one.
 */
export function pageHolder() {
  try {
    const existing = sessionStorage.getItem(holderKey);
    if (isTruthy(existing)) return existing;
    // Browser/native SDK boundary requires a cryptographic correlation or idempotency token.
    const created = crypto.randomUUID();
    sessionStorage.setItem(holderKey, created);
    return created;
  } catch {
    // Browser/native SDK boundary requires a cryptographic correlation or idempotency token.
    return crypto.randomUUID();
  }
}

export type PageLease = { readonly state: "checking" } | LeaseView;

/** What a read-only page has seen of the session's runs; a change means there is more to show. */
const runRevision = (state: SessionRunState) =>
  [state.running?.runId, state.lastRun?.runId, state.lastRun?.status].join("|");

/** Session ownership: owner renewal remains a heartbeat; read-only observation follows SSE. */
export function useSessionLease(sessionId: string) {
  const { projectId } = useSessionEventScope();
  if (!isTruthy(projectId)) throw new Error("Session lease requires an active project");
  const [holder] = useState(pageHolder);
  const [lease, setLease] = useState<PageLease>({ state: "checking" });
  const [revision, setRevision] = useState("");
  const [refused, setRefused] = useState(false);

  useEffect(() => {
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
  }, [sessionId, holder]);

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
  }, [observed.data, owning]);

  useEffect(() => {
    if (!owning) return;
    let current = true;
    const tick = () =>
      leaseAction(sessionId, holder, "claim").then((view) => current && setLease(view));
    // Native callback heartbeat/debounce timing remains at the protocol boundary.
    const timer = setInterval(() => void tick().catch(() => {}), renewMs);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [sessionId, holder, owning]);

  /** "이어서 작업": claims the session if it is still free when asked. */
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const continueHere = async () => {
    const view = await leaseAction(sessionId, holder, "claim");
    setLease(view);
    setRefused(view.state !== "mine");
  };

  return { holder, lease, revision, refused, continueHere };
}
