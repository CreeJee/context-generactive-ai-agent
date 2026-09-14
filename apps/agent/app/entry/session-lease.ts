import { useEffect, useState } from "react";
import { api, type LeaseView, type SessionRunState } from "./api";

const holderKey = "context-agent:page-holder";
/** An owning page renews well inside the server's 90s lease, even with background-tab throttling. */
const renewMs = 20_000;
/** A read-only page checks this often for the owner leaving and for new runs to follow. */
const watchMs = 3_000;

/**
 * This page's identity for session ownership. Kept in sessionStorage, so a reload is still the same
 * page (and keeps its session), while every other tab or window is a different one.
 */
function pageHolder() {
  try {
    const existing = sessionStorage.getItem(holderKey);
    if (existing) return existing;
    const created = crypto.randomUUID();
    sessionStorage.setItem(holderKey, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}

export type PageLease = { readonly state: "checking" } | LeaseView;

/** What a read-only page has seen of the session's runs; a change means there is more to show. */
const runRevision = (state: SessionRunState) =>
  [state.running?.runId, state.lastRun?.runId, state.lastRun?.status].join("|");

/**
 * Ownership of one session for this page (R03). Opening claims it when nobody else is using it; if
 * another page is, this one stays read-only and never takes over on its own, even after the owner
 * leaves: the user chooses to continue, and the claim is checked again then.
 */
export function useSessionLease(sessionId: string) {
  const [holder] = useState(pageHolder);
  const [lease, setLease] = useState<PageLease>({ state: "checking" });
  const [revision, setRevision] = useState("");
  const [refused, setRefused] = useState(false);

  useEffect(() => {
    let current = true;
    setLease({ state: "checking" });
    void api.leaseAction(sessionId, holder, "claim").then(
      (view) => current && setLease(view),
      () => {},
    );
    // A closing page gives the session up at once instead of making others wait for expiry.
    const leave = () =>
      navigator.sendBeacon(
        `/api/sessions/${encodeURIComponent(sessionId)}/lease`,
        new Blob([JSON.stringify({ holder, action: "release" })], { type: "application/json" }),
      );
    window.addEventListener("pagehide", leave);
    return () => {
      current = false;
      window.removeEventListener("pagehide", leave);
      void api.leaseAction(sessionId, holder, "release").catch(() => {});
    };
  }, [sessionId, holder]);

  const owning = lease.state === "mine";
  useEffect(() => {
    if (lease.state === "checking") return;
    let current = true;
    const tick = owning
      ? // Renewing: a page that was asleep past expiry may find someone else holds it now.
        () => api.leaseAction(sessionId, holder, "claim").then((view) => current && setLease(view))
      : () =>
          api.sessionRunState(sessionId, holder).then((state) => {
            if (!current) return;
            setLease(state.lease);
            setRevision(runRevision(state));
          });
    const timer = setInterval(() => void tick().catch(() => {}), owning ? renewMs : watchMs);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [sessionId, holder, owning, lease.state]);

  /** "이어서 작업": claims the session if it is still free when asked. */
  const continueHere = async () => {
    const view = await api.leaseAction(sessionId, holder, "claim");
    setLease(view);
    setRefused(view.state !== "mine");
  };

  return { holder, lease, revision, refused, continueHere };
}
