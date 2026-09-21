import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, type LeaseView, type SessionRunState } from "./api";
import { useSessionEventScope } from "./events/providers";
import { appQueryKeys } from "./events/query-keys";

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

/** Session ownership: owner renewal remains a heartbeat; read-only observation follows SSE. */
export function useSessionLease(sessionId: string) {
  const { projectId } = useSessionEventScope();
  if (!projectId) throw new Error("Session lease requires an active project");
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
  const observed = useQuery({
    queryKey: appQueryKeys.session.runState(projectId, sessionId),
    queryFn: () => api.sessionRunState(sessionId, holder),
    enabled: lease.state !== "checking" && !owning,
    staleTime: 0,
  });
  useEffect(() => {
    if (!observed.data || owning) return;
    setLease(observed.data.lease);
    setRevision(runRevision(observed.data));
  }, [observed.data, owning]);

  useEffect(() => {
    if (!owning) return;
    let current = true;
    const tick = () =>
      api.leaseAction(sessionId, holder, "claim").then((view) => current && setLease(view));
    const timer = setInterval(() => void tick().catch(() => {}), renewMs);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [sessionId, holder, owning]);

  /** "이어서 작업": claims the session if it is still free when asked. */
  const continueHere = async () => {
    const view = await api.leaseAction(sessionId, holder, "claim");
    setLease(view);
    setRefused(view.state !== "mine");
  };

  return { holder, lease, revision, refused, continueHere };
}
