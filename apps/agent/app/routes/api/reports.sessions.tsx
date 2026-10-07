import { Effect, Result, Schema } from "effect";
import { AppEvents, Database } from "memory-agent";
import { agent } from "~/.server/agent";
import { readJson, rejectCrossSite } from "~/.server/http";
import { openReportSession } from "~/.server/report-sessions";
import type { Route } from "./+types/reports.sessions";

const OpenReport = Schema.Struct({
  projectId: Schema.NonEmptyString,
  sourceSessionId: Schema.NonEmptyString,
});

/** Explicit same-origin opening; no chat run or original-session mutation. */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function action({ request }: Route.ActionArgs) {
  return agent.runPromise(
    Effect.gen(function* () {
      const rejected = rejectCrossSite(request);
      if (rejected !== null) return rejected;
      const decoded = yield* Effect.tryPromise(() => readJson(request, OpenReport));
      if (Result.isFailure(decoded))
        return Response.json({ error: "invalid_report_source" }, { status: 400 });
      const { projectId, sourceSessionId } = decoded.success;
      if (projectId.length > 256 || sourceSessionId.length > 256)
        return Response.json({ error: "invalid_report_source" }, { status: 400 });
      return yield* Effect.gen(function* () {
        const { sqlite } = yield* Database;
        const result = yield* openReportSession(sqlite, projectId, sourceSessionId);
        if (!(result !== null))
          return Response.json({ error: "report_source_not_found" }, { status: 404 });
        (yield* AppEvents).publishProject(projectId, "sessions");
        return Response.json(result, { headers: { "Cache-Control": "no-store" } });
      });
    }),
  );
}
