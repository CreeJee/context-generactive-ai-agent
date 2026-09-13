import { Effect, Either, Schema } from "effect";
import { CodexModels } from "memory-agent";
import { agent } from "~/.server/agent";
import { readJson, rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/models.$model";

const Selection = Schema.Struct({ reasoningEffort: Schema.optional(Schema.NonEmptyString) });

/**
 * POST /api/models/:model { reasoningEffort? } — switches the model used for the next chat run.
 * A model the account does not offer is refused, never replaced by another (PRD R02).
 */
export async function action({ request, params }: Route.ActionArgs) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const body = await readJson(request, Selection);
  if (Either.isLeft(body)) return Response.json({ error: "invalid_selection" }, { status: 400 });

  const response = Effect.flatMap(CodexModels, (models) =>
    models.select(params.model, body.right.reasoningEffort),
  ).pipe(
    Effect.map((selection) => Response.json(selection)),
    Effect.catchTags({
      ModelUnavailable: (error) =>
        Effect.succeed(
          Response.json(
            {
              error: "model_unavailable",
              model: error.model,
              reasoningEffort: error.reasoningEffort ?? null,
            },
            { status: 404 },
          ),
        ),
      CodexUnavailable: (error) =>
        Effect.succeed(
          Response.json({ error: "codex_unavailable", reason: error.reason }, { status: 503 }),
        ),
      CodexRequestFailed: () =>
        Effect.succeed(Response.json({ error: "model_list_failed" }, { status: 502 })),
    }),
  );
  return agent.runPromise(response);
}
