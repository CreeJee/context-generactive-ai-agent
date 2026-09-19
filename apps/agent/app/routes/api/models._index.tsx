import { Effect, Schema } from "effect";
import { ProviderId, ProviderRegistry } from "memory-agent";
import { agent } from "~/.server/agent";
import type { Route } from "./+types/models._index";

/** Lists the signed-in subscription provider's catalog and its current global selection. */
export async function loader({ request }: Route.LoaderArgs) {
  const requested = new URL(request.url).searchParams.get("provider");
  if (requested === null || !Schema.is(ProviderId)(requested))
    return Response.json({ error: "invalid_provider" }, { status: 400 });

  const response = Effect.gen(function* () {
    const configured = yield* (yield* ProviderRegistry).get(requested);
    const status = yield* configured.auth.status;
    if (status.status !== "signed-in")
      return Response.json({ error: "login_required", auth: status }, { status: 401 });

    const models = yield* configured.models.list;
    return Response.json({ models, selected: yield* configured.models.selected });
  }).pipe(
    Effect.catchTags({
      ProviderUnavailable: () =>
        Effect.succeed(Response.json({ error: "provider_unavailable" }, { status: 404 })),
      ProviderOperationFailed: () =>
        Effect.succeed(Response.json({ error: "model_list_failed" }, { status: 502 })),
    }),
  );
  return agent.runPromise(response);
}
