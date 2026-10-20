import { Effect, Match, Option, Result, Schema } from "effect";
import { ProjectImprovement } from "memory-agent";
import { agent } from "~/.server/agent";
import { readJson, rejectCrossSite } from "~/.server/http";

const ScanCommand = Schema.Struct({ action: Schema.Literals(["start", "stop"]) });

/**
 * GET /api/settings/improvements: where the background scan stands and the last recorded scan of
 * the open projects, or null before the first.
 */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function loader() {
  return agent.runPromise(
    Effect.flatMap(ProjectImprovement, (improvement) => improvement.status).pipe(
      Effect.map(({ state, scan }) => Response.json({ state, scan: Option.getOrNull(scan) })),
      Effect.catchTag("DiscoveryFailed", (failure) =>
        Effect.succeed(
          Response.json({ error: "improvement_failed", reason: failure.reason }, { status: 500 }),
        ),
      ),
    ),
  );
}

/** POST /api/settings/improvements `{ action: "start" | "stop" }`: answers the scan state. */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function action({ request }: { request: Request }) {
  const rejected = rejectCrossSite(request);
  if (rejected !== null) return rejected;
  return agent.runPromise(
    Effect.gen(function* () {
      const decoded = yield* Effect.tryPromise(() => readJson(request, ScanCommand)).pipe(
        Effect.map(Result.getSuccess),
        // A body that cannot be read answers the same as one that does not decode.
        Effect.catchTag("UnknownError", () => Effect.succeedNone),
      );
      if (Option.isNone(decoded))
        return Response.json({ error: "invalid_command" }, { status: 400 });
      const improvement = yield* ProjectImprovement;
      const state = yield* Match.value(decoded.value).pipe(
        Match.discriminatorsExhaustive("action")({
          start: () => improvement.start,
          stop: () => improvement.stop,
        }),
      );
      return Response.json({ state });
    }),
  );
}
