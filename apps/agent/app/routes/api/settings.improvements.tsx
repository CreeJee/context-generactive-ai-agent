import { Effect, Option } from "effect";
import { ProjectImprovement } from "memory-agent";
import { agent } from "~/.server/agent";
import { rejectCrossSite } from "~/.server/http";

const scanFailed = (reason: string) =>
  Response.json({ error: "improvement_failed", reason }, { status: 500 });

/** GET /api/settings/improvements: the last recorded scan of the open projects, or null. */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function loader() {
  return agent.runPromise(
    Effect.flatMap(ProjectImprovement, (improvement) => improvement.latest).pipe(
      Effect.map((scan) => Response.json({ scan: Option.getOrNull(scan) })),
      Effect.catchTag("DiscoveryFailed", (failure) => Effect.succeed(scanFailed(failure.reason))),
    ),
  );
}

/** POST /api/settings/improvements: scans the open projects again and records the reports. */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function action({ request }: { request: Request }) {
  const rejected = rejectCrossSite(request);
  if (rejected !== null) return rejected;
  return agent.runPromise(
    Effect.flatMap(ProjectImprovement, (improvement) => improvement.scan()).pipe(
      Effect.map((scan) => Response.json({ scan })),
      Effect.catchTags({
        DiscoveryFailed: (failure) => Effect.succeed(scanFailed(failure.reason)),
        SignalsFailed: () => Effect.succeed(scanFailed("storage")),
        EmbeddingError: () => Effect.succeed(scanFailed("embedding")),
        InterpretationUnavailable: () => Effect.succeed(scanFailed("model_unavailable")),
      }),
    ),
  );
}
