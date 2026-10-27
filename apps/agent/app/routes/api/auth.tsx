import { Effect, Result, Option, Schema, Struct } from "effect";
import {
  AppEvents,
  AuthConnectionState,
  OAuthProfiles,
  ProviderConnection,
  ProviderId,
  providerConnection,
  ProviderRegistry,
  logFailure,
} from "memory-agent";
import { agent } from "~/.server/agent";
import { readJson, rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/auth";

const Intent = Schema.Struct({
  intent: Schema.Literals(["login", "cancel", "logout"]),
  provider: Schema.optional(ProviderId),
});

const providerFrom = (request: Request) => {
  const value = new URL(request.url).searchParams.get("provider");
  if (value === null) return undefined;
  return Schema.is(ProviderId)(value) ? value : null;
};

const browserState = (state: AuthConnectionState) =>
  AuthConnectionState.$is("pending")(state)
    ? { ...Struct.omit(state, ["authorizationUrl"]), authUrl: state.authorizationUrl }
    : state;

/** GET /api/auth?provider=... reads one subscription provider's connection state. */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function loader({ request }: Route.LoaderArgs) {
  return agent.runPromise(
    Effect.gen(function* () {
      const provider = providerFrom(request);
      if (provider === null || provider === undefined)
        return Response.json({ error: "invalid_provider" }, { status: 400 });

      const response = Effect.gen(function* () {
        const configured = yield* (yield* ProviderRegistry).get(provider);
        // Migrate when the sidebar first checks this provider. If the vault is unavailable,
        // keep the legacy connection usable; the next status request can retry the copy.
        yield* ProviderConnection.match(providerConnection(provider), {
          subscription: ({ accountProvider }) =>
            Effect.gen(function* () {
              yield* (yield* OAuthProfiles).importLegacy(accountProvider);
            }).pipe(Effect.catch(logFailure("Legacy OAuth account import failed"))),
          "compatible-endpoint": () => Effect.void,
        });
        return Response.json(browserState(yield* configured.auth.status));
      }).pipe(
        Effect.catchTags({
          ProviderUnavailable: () =>
            Effect.succeed(Response.json({ error: "provider_unavailable" }, { status: 404 })),
          ProviderOperationFailed: () =>
            Effect.succeed(Response.json({ error: "auth_failed" }, { status: 502 })),
        }),
        Effect.timeoutOption("10 seconds"),
        Effect.map((result) =>
          Option.getOrElse(result, () =>
            Response.json({ error: "auth_failed", reason: "auth_status_timeout" }, { status: 504 }),
          ),
        ),
      );
      return yield* response;
    }),
  );
}

/** Starts, cancels or disconnects one explicit subscription provider. */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function action({ request }: Route.ActionArgs) {
  return agent.runPromise(
    Effect.gen(function* () {
      const rejected = rejectCrossSite(request);
      if (rejected !== null) return rejected;
      const body = yield* Effect.tryPromise(() => readJson(request, Intent));
      if (Result.isFailure(body))
        return Response.json({ error: "invalid_intent" }, { status: 400 });
      const { intent, provider } = body.success;
      if (
        provider === undefined ||
        !ProviderConnection.isAnyOf(["subscription"])(providerConnection(provider))
      )
        return Response.json({ error: "invalid_provider" }, { status: 400 });

      const response = Effect.gen(function* () {
        const configured = yield* (yield* ProviderRegistry).get(provider);
        const operation =
          intent === "login"
            ? configured.auth.connect
            : intent === "logout"
              ? configured.auth.disconnect
              : configured.auth.cancel;
        const state = yield* operation;
        const events = yield* AppEvents;
        yield* events.publishGlobal("auth");
        if (AuthConnectionState.$is("pending")(state))
          yield* Effect.forkDetach(
            Effect.gen(function* () {
              for (;;) {
                yield* Effect.sleep("250 millis");
                if (!AuthConnectionState.$is("pending")(yield* configured.auth.status)) break;
              }
            }).pipe(
              Effect.catch(logFailure("OAuth login status polling stopped")),
              // Pages re-read the state however the wait ended.
              Effect.ensuring(events.publishGlobal("auth")),
            ),
          );
        return Response.json(browserState(state));
      }).pipe(
        Effect.catchTags({
          ProviderUnavailable: () =>
            Effect.succeed(Response.json({ error: "provider_unavailable" }, { status: 404 })),
          ProviderOperationFailed: () =>
            Effect.succeed(Response.json({ error: "auth_failed" }, { status: 502 })),
        }),
      );
      return yield* response;
    }),
  );
}
