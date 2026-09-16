import { Effect, Either, Schema } from "effect";
import { EmbeddingChoice, EmbeddingSetup } from "memory-agent";
import { agent } from "~/.server/agent";
import { readJson, rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/settings.embedding";

const EmbeddingAction = Schema.Union(
  Schema.Struct({ action: Schema.Literal("choose"), choice: EmbeddingChoice }),
  Schema.Struct({ action: Schema.Literal("check") }),
);

/**
 * GET /api/settings/embedding: how the embedding model runs now and from the next start, the
 * machine's memory, whether WebGPU works, and how many nodes wait to be embedded.
 */
export async function loader() {
  return agent.runPromise(
    Effect.flatMap(EmbeddingSetup, (setup) => setup.overview).pipe(
      Effect.map((overview) => Response.json(overview)),
    ),
  );
}

/**
 * POST /api/settings/embedding
 * - `choose` { choice }: `auto`, `cpu` or `gpu`; takes effect when the app next starts.
 * - `check`: checks WebGPU again, in the background.
 */
export async function action({ request }: Route.ActionArgs) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const body = await readJson(request, EmbeddingAction);
  if (Either.isLeft(body))
    return Response.json({ error: "invalid_embedding_action" }, { status: 400 });

  return agent.runPromise(
    Effect.gen(function* () {
      const setup = yield* EmbeddingSetup;
      const command = body.right;
      switch (command.action) {
        case "choose":
          return Response.json(yield* setup.choose(command.choice));
        case "check":
          return Response.json(yield* setup.recheck);
      }
    }),
  );
}
