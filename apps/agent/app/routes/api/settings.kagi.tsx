import { Effect, Match, Result, Schema } from "effect";
import { Kagi } from "memory-agent";
import { agent } from "~/.server/agent";
import { readJson, rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/settings.kagi";

const KagiAction = Schema.TaggedUnion({
  register: { key: Schema.Trim.pipe(Schema.check(Schema.isNonEmpty())) },
  remove: {},
  enable: {},
  disable: {},
});

const keychainFailed = (operation: string) =>
  Response.json({ error: "keychain_failed", reason: operation }, { status: 500 });

/** GET /api/settings/kagi: whether a key is registered and Kagi is on. The key is never returned. */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function loader() {
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
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function action({ request }: Route.ActionArgs) {
  return agent.runPromise(
    Effect.gen(function* () {
      const rejected = rejectCrossSite(request);
      if (rejected !== null) return rejected;
      const body = yield* Effect.tryPromise(() => readJson(request, KagiAction));
      if (Result.isFailure(body))
        return Response.json({ error: "invalid_kagi_action" }, { status: 400 });

      const response = Effect.gen(function* () {
        const kagi = yield* Kagi;
        return Response.json(
          yield* Match.valueTags(body.success, {
            register: ({ key }) => kagi.registerKey(key).pipe(Effect.andThen(kagi.status)),
            remove: () => kagi.removeKey.pipe(Effect.andThen(kagi.status)),
            enable: () => kagi.setEnabled(true),
            disable: () => kagi.setEnabled(false),
          }),
        );
      }).pipe(
        Effect.catchTags({
          SecretStoreFailed: (failure) => Effect.succeed(keychainFailed(failure.operation)),
          KagiKeyMissing: () =>
            Effect.succeed(Response.json({ error: "kagi_key_required" }, { status: 409 })),
        }),
      );
      return yield* response;
    }),
  );
}
