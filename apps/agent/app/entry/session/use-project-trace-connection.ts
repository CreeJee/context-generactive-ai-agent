import { isTruthy } from "../../truthy.ts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useState } from "react";
import { api } from "../api";
import { projectQueries } from "../queries/project";
import type { TraceConnection } from "./work-trace";

/** Keep the project trace query current while the live panel is visible. */
// Fixed-arity application/SDK contract; these arguments are not a data-last collection API.
// @effect-diagnostics-next-line missingPipeableSignature:off
export function useProjectTraceConnection(
  projectId: string,
  sessionId: string | null,
  live: boolean,
) {
  const client = useQueryClient();
  const [connection, setConnection] = useState<TraceConnection>("connecting");
  const refresh = useEffectEvent(() =>
    client.invalidateQueries({ queryKey: projectQueries.trace(projectId).queryKey }),
  );

  useEffect(() => {
    if (!isTruthy(sessionId) || !live) {
      setConnection("connecting");
      return;
    }
    let source: EventSource | null = null;
    const changed = () => void refresh();
    const visibilityChanged = () => {
      source?.close();
      source = null;
      if (document.hidden) {
        setConnection("connecting");
        return;
      }
      source = new EventSource(api.workTraceStreamUrl(sessionId));
      source.addEventListener("open", () => setConnection("live"));
      source.addEventListener("trace", changed);
      source.addEventListener("snapshot", changed);
      source.addEventListener("error", () => setConnection("reconnecting"));
      changed();
    };
    document.addEventListener("visibilitychange", visibilityChanged);
    visibilityChanged();
    return () => {
      document.removeEventListener("visibilitychange", visibilityChanged);
      source?.close();
    };
  }, [live, sessionId]);

  return connection;
}
