import { DateTime, Effect, Schema } from "effect";
import { ProviderId, ProviderRegistry } from "memory-agent";
import { agent } from "~/.server/agent";
import type { Route } from "./+types/models._index";

/** Lists the signed-in subscription provider's catalog and its current global selection. */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function loader({ request }: Route.LoaderArgs) {
  const requested = new URL(request.url).searchParams.get("provider");
  if (requested === null || !Schema.is(ProviderId)(requested))
    return Promise.resolve(Response.json({ error: "invalid_provider" }, { status: 400 }));

  // Native CLI boundary: the stable dev backend is a production bundle without Vite's DEV flag.
  const developmentTiming = import.meta.env.DEV || process.argv.includes("--dev-backend");
  const response = Effect.gen(function* () {
    const started = developmentTiming ? DateTime.toEpochMillis(yield* DateTime.now) : 0;
    const configured = yield* (yield* ProviderRegistry).get(requested);
    const configuredAt = developmentTiming ? DateTime.toEpochMillis(yield* DateTime.now) : 0;
    const status = yield* configured.auth.status;
    const authenticatedAt = developmentTiming ? DateTime.toEpochMillis(yield* DateTime.now) : 0;
    if (status.status !== "signed-in")
      return Response.json({ error: "login_required", auth: status }, { status: 401 });

    const models = yield* configured.models.list;
    const catalogAt = developmentTiming ? DateTime.toEpochMillis(yield* DateTime.now) : 0;
    const selected = yield* configured.models.selected;
    const selectedAt = developmentTiming ? DateTime.toEpochMillis(yield* DateTime.now) : 0;
    const result = Response.json({ models, selected });
    if (developmentTiming)
      result.headers.set(
        "Server-Timing",
        `registry;dur=${configuredAt - started}, auth;dur=${authenticatedAt - configuredAt}, catalog;dur=${catalogAt - authenticatedAt}, selection;dur=${selectedAt - catalogAt}`,
      );
    return result;
  }).pipe(
    Effect.catchTags({
      ProviderUnavailable: () =>
        Effect.succeed(Response.json({ error: "provider_unavailable" }, { status: 404 })),
      ProviderOperationFailed: () =>
        Effect.succeed(Response.json({ error: "model_list_failed" }, { status: 502 })),
    }),
  );
  const boundaryStarted = performance.now();
  return agent.runPromise(response).then((result) => {
    if (developmentTiming)
      result.headers.append(
        "Server-Timing",
        `runtime-boundary;dur=${(performance.now() - boundaryStarted).toFixed(3)}`,
      );
    return result;
  });
}
