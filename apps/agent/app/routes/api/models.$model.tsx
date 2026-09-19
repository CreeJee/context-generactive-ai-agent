import { Effect, Either, Schema } from "effect";
import { ProviderId, ProviderRegistry } from "memory-agent";
import { agent } from "~/.server/agent";
import { readJson, rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/models.$model";

const Selection = Schema.Struct({
  provider: ProviderId,
  reasoningEffort: Schema.optional(Schema.NonEmptyString),
});

interface ModelUnavailableBody {
  error: "model_unavailable";
  provider: "openai" | "anthropic";
  model: string;
  reasoningEffort: string | null;
}

const modelUnavailable = (error: {
  readonly provider: "openai" | "anthropic";
  readonly model: string;
  readonly reasoningEffort?: string;
}) => {
  const body: ModelUnavailableBody = {
    error: "model_unavailable",
    provider: error.provider,
    model: error.model,
    reasoningEffort: error.reasoningEffort ?? null,
  };
  return Response.json(body, { status: 404 });
};

/** Validates and saves an explicit provider/model/effort tuple, with no provider fallback. */
export async function action({ request, params }: Route.ActionArgs) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const body = await readJson(request, Selection);
  if (Either.isLeft(body)) return Response.json({ error: "invalid_selection" }, { status: 400 });

  const { provider, reasoningEffort } = body.right;
  const response = Effect.gen(function* () {
    const configured = yield* (yield* ProviderRegistry).get(provider);
    return yield* configured.models.select(params.model, reasoningEffort);
  }).pipe(
    Effect.map((selection) => Response.json(selection)),
    Effect.catchTags({
      ModelUnavailable: (error) => Effect.succeed(modelUnavailable(error)),
      ProviderUnavailable: () =>
        Effect.succeed(Response.json({ error: "provider_unavailable" }, { status: 404 })),
      ProviderOperationFailed: () =>
        Effect.succeed(Response.json({ error: "model_list_failed" }, { status: 502 })),
    }),
  );
  return agent.runPromise(response);
}
