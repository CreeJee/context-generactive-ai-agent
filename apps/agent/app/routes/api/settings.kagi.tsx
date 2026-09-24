import { Effect, Result, Schema } from "effect";
import { Kagi } from "memory-agent";
import { agent } from "~/.server/agent";
import { readJson, rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/settings.kagi";

const KagiAction = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("register"),
    key: Schema.Trim.pipe(Schema.check(Schema.isNonEmpty())),
  }),
  Schema.Struct({ action: Schema.Literals(["remove", "enable", "disable"]) }),
]);

const keychainFailed = (operation: string) =>
  Response.json({ error: "keychain_failed", reason: operation }, { status: 500 });

/** GET /api/settings/kagi: whether a key is registered and Kagi is on. The key is never returned. */
export async function loader() {
  return agent.runPromise(
    Effect.flatMap(Kagi, (kagi) => kagi.status).pipe(
      Effect.map((status) => Response.json(status)),
      Effect.catchTag("SecretStoreFailed", (failure) =>
        Effect.succeed(keychainFailed(failure.operation)),
      ),
    ),
  );
}

/**
 * POST /api/settings/kagi (R19)
 * - `register` { key }: stores the key in the OS keychain; does not turn Kagi on.
 * - `enable` / `disable`: turns Search and Extract on or off for every project.
 * - `remove`: deletes the key and turns Kagi off.
 */
export async function action({ request }: Route.ActionArgs) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const body = await readJson(request, KagiAction);
  if (Result.isFailure(body))
    return Response.json({ error: "invalid_kagi_action" }, { status: 400 });

  const response = Effect.gen(function* () {
    const kagi = yield* Kagi;
    const command = body.success;
    switch (command.action) {
      case "register":
        yield* kagi.registerKey(command.key);
        return Response.json(yield* kagi.status);
      case "remove":
        yield* kagi.removeKey;
        return Response.json(yield* kagi.status);
      case "enable":
      case "disable":
        return Response.json(yield* kagi.setEnabled(command.action === "enable"));
    }
  }).pipe(
    Effect.catchTags({
      SecretStoreFailed: (failure) => Effect.succeed(keychainFailed(failure.operation)),
      KagiKeyMissing: () =>
        Effect.succeed(Response.json({ error: "kagi_key_required" }, { status: 409 })),
    }),
  );
  return agent.runPromise(response);
}
