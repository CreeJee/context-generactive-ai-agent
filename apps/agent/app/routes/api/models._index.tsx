import { Effect } from "effect";
import { CodexAccount, CodexModels } from "memory-agent";
import { agent } from "~/.server/agent";

/** GET /api/models — models the signed-in account offers, and the saved selection. */
export async function loader() {
  const response = Effect.gen(function* () {
    const status = yield* (yield* CodexAccount).status;
    if (status.status !== "signed-in")
      return Response.json({ error: "login_required", auth: status }, { status: 401 });
    const models = yield* CodexModels;
    return Response.json({ models: yield* models.list, selected: yield* models.selected });
  }).pipe(
    Effect.catchTags({
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
