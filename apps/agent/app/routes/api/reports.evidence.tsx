import { Effect } from "effect";
import { Projects, collectReportBundle } from "memory-agent";
import { agent } from "~/.server/agent";
import { answerDefect } from "~/.server/http";
import { reportBundleResponse } from "~/.server/report-evidence";
import type { Route } from "./+types/reports.evidence";

/**
 * The evidence bundle of a session for the report page: collected whole, redacted and cut to its
 * limits. Local-server-only and read-only; query identifiers are never authority.
 */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function loader({ request }: Route.LoaderArgs) {
  return agent.runPromise(
    reportBundleResponse(request, (session) =>
      Effect.gen(function* () {
        const project = yield* (yield* Projects).get(session.projectId);
        return yield* collectReportBundle(project, session);
      }),
    ).pipe(
      Effect.catchTags({
        ProjectNotFound: () =>
          Effect.succeed(Response.json({ error: "session_not_found" }, { status: 404 })),
        SqlError: () =>
          Effect.succeed(Response.json({ error: "evidence_unavailable" }, { status: 503 })),
        SchemaError: () =>
          Effect.succeed(Response.json({ error: "evidence_unavailable" }, { status: 503 })),
      }),
      answerDefect,
    ),
  );
}
