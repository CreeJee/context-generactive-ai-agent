import { Database, WorkTraceStore } from "memory-agent";
import { Effect } from "effect";
import { agent } from "~/.server/agent";
import { reportEvidenceItemResponse, reportEvidenceResponse } from "~/.server/report-evidence";
import type { Route } from "./+types/reports.evidence";

/** Local-server-only, bounded, read-only report evidence. Query identifiers are never authority. */
export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const projectId = url.searchParams.get("project");
  const sessionId = url.searchParams.get("session");
  if (!projectId || !sessionId || projectId.length > 256 || sessionId.length > 256)
    return Response.json({ error: "project_and_session_required" }, { status: 400 });
  const itemId = url.searchParams.get("item");
  if (itemId !== null) {
    if (!itemId || itemId.length > 256)
      return Response.json({ error: "project_session_item_required" }, { status: 400 });
    return agent.runPromise(
      Effect.gen(function* () {
        const { sqlite } = yield* Database;
        return reportEvidenceItemResponse(sqlite, request);
      }),
    );
  }

  return agent.runPromise(
    Effect.gen(function* () {
      const { sqlite } = yield* Database;
      const trace = yield* WorkTraceStore;
      return reportEvidenceResponse(sqlite, request, (id) =>
        trace
          .taskTree(id)
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, 6)
          .map((task) => ({
            id: task.id,
            status: task.status,
            parentRunId: task.parentRunId,
            parentToolCallId: task.parentToolCallId,
            updatedAt: task.updatedAt,
          })),
      );
    }),
  );
}
