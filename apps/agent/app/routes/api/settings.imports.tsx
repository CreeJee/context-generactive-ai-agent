import { Effect, Match, Result, Schema } from "effect";
import { Importer } from "memory-agent";
import { agent } from "~/.server/agent";
import { readJson, rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/settings.imports";

const ImportAction = Schema.TaggedUnion({
  run: {},
  restart_watch: {},
  enable: {},
  disable: {},
  interpret: { interpret: Schema.Boolean },
});

/**
 * GET /api/settings/imports: what can be migrated from other coding agents' local transcripts —
 * per source, how many conversations were read, and which working directories are not projects
 * here yet. File paths are shown; transcript contents are not.
 */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function loader() {
  return agent.runPromise(
    Effect.flatMap(Importer, (importer) => importer.overview).pipe(
      Effect.map((overview) => Response.json(overview)),
    ),
  );
}

/**
 * POST /api/settings/imports
 * - `enable` / `disable`: keep following the transcripts. Enabling starts reading what is there now.
 * - `run`: start reading once, without changing the setting.
 * Both answer before the pass ends; `activity` in the overview reports how far it got.
 * - `restart_watch`: start the watcher again after it stopped; `watch` in the overview shows it.
 * - `interpret` { interpret }: whether migrated statements are interpreted like statements said here.
 */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function action({ request }: Route.ActionArgs) {
  return agent.runPromise(
    Effect.gen(function* () {
      const rejected = rejectCrossSite(request);
      if (rejected !== null) return rejected;
      const body = yield* Effect.tryPromise(() => readJson(request, ImportAction));
      if (Result.isFailure(body))
        return Response.json({ error: "invalid_import_action" }, { status: 400 });

      {
        const importer = yield* Importer;
        yield* Match.valueTags(body.success, {
          // Answered at once; the page follows the pass through `activity`.
          run: () => importer.start,
          restart_watch: () => importer.restartWatch,
          enable: () => importer.setEnabled(true),
          disable: () => importer.setEnabled(false),
          interpret: ({ interpret }) => importer.setInterpret(interpret),
        });
        return Response.json(yield* importer.overview);
      }
    }),
  );
}
