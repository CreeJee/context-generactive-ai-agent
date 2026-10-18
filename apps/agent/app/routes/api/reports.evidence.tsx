import { isTruthy } from "../../truthy.ts";
import { WorkTraceStore } from "memory-agent";
import { Effect } from "effect";
import { agent } from "~/.server/agent";
import { reportEvidenceItemResponse, reportEvidenceResponse } from "~/.server/report-evidence";
import type { Route } from "./+types/reports.evidence";

/** Local-server-only, bounded, read-only report evidence. Query identifiers are never authority. */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function loader({ request }: Route.LoaderArgs) {
  return agent.runPromise(
    Effect.gen(function* () {
      const url = new URL(request.url);
      const projectId = url.searchParams.get("project");
      const sessionId = url.searchParams.get("session");
      if (
        !isTruthy(projectId) ||
        !isTruthy(sessionId) ||
        projectId.length > 256 ||
        sessionId.length > 256
      )
        return Response.json({ error: "project_and_session_required" }, { status: 400 });
      const itemId = url.searchParams.get("item");
      if (itemId !== null) {
        if (!(itemId.length > 0) || itemId.length > 256)
          return Response.json({ error: "project_session_item_required" }, { status: 400 });
        return yield* reportEvidenceItemResponse(request);
      }

      const trace = yield* WorkTraceStore;
      // Read inside the guarded section: a failed trace read marks only that section failed.
      return yield* reportEvidenceResponse(request, (id) =>
        trace.taskTree(id).pipe(
          Effect.map((tasks) =>
            tasks
              .sort((a, b) => b.updatedAt - a.updatedAt)
              .slice(0, 6)
              .map((task) => ({
                id: task.id,
                status: task.status,
                parentRunId: task.parentRunId,
                parentToolCallId: task.parentToolCallId,
                updatedAt: task.updatedAt,
              })),
          ),
        ),
      );
    }),
  );
}
