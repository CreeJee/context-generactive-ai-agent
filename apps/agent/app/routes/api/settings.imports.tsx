import { Effect, Either, Schema } from "effect";
import { Importer } from "memory-agent";
import { agent } from "~/.server/agent";
import { readJson, rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/settings.imports";

const ImportAction = Schema.Union(
  Schema.Struct({ action: Schema.Literal("run") }),
  Schema.Struct({ action: Schema.Literal("enable", "disable") }),
  Schema.Struct({ action: Schema.Literal("interpret"), interpret: Schema.Boolean }),
);

/**
 * GET /api/settings/imports: what can be migrated from other coding agents' local transcripts —
 * per source, how many conversations were read, and which working directories are not projects
 * here yet. File paths are shown; transcript contents are not.
 */
export async function loader() {
  return agent.runPromise(
    Effect.flatMap(Importer, (importer) => importer.overview).pipe(
      Effect.map((overview) => Response.json(overview)),
    ),
  );
}

/**
 * POST /api/settings/imports
 * - `enable` / `disable`: keep following the transcripts. Enabling reads what is there now.
 * - `run`: read once, without changing the setting.
 * - `interpret` { interpret }: whether migrated statements are interpreted like statements said here.
 */
export async function action({ request }: Route.ActionArgs) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const body = await readJson(request, ImportAction);
  if (Either.isLeft(body))
    return Response.json({ error: "invalid_import_action" }, { status: 400 });

  return agent.runPromise(
    Effect.gen(function* () {
      const importer = yield* Importer;
      const command = body.right;
      switch (command.action) {
        case "run":
          yield* importer.runAndIndex;
          break;
        case "enable":
        case "disable":
          yield* importer.setEnabled(command.action === "enable");
          break;
        case "interpret":
          yield* importer.setInterpret(command.interpret);
      }
      return Response.json(yield* importer.overview);
    }),
  );
}
