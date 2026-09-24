import { Effect, Result, Option, Schema } from "effect";
import { AppEvents, ProviderId, ProviderRegistry } from "memory-agent";
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

const browserState = (state: {
  readonly provider: "openai" | "anthropic";
  readonly status: "signed-out" | "pending" | "signed-in" | "error";
  readonly authorizationUrl?: string;
  readonly planType?: string;
  readonly message?: string;
}) =>
  state.status === "pending"
    ? { provider: state.provider, status: state.status, authUrl: state.authorizationUrl }
    : state;

/** GET /api/auth?provider=... reads one subscription provider's connection state. */
export async function loader({ request }: Route.LoaderArgs) {
  const provider = providerFrom(request);
  if (provider === null || provider === undefined)
    return Response.json({ error: "invalid_provider" }, { status: 400 });

  const response = Effect.gen(function* () {
    const configured = yield* (yield* ProviderRegistry).get(provider);
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
  return agent.runPromise(response);
}

/** Starts, cancels or disconnects one explicit subscription provider. */
export async function action({ request }: Route.ActionArgs) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const body = await readJson(request, Intent);
  if (Result.isFailure(body)) return Response.json({ error: "invalid_intent" }, { status: 400 });
  const { intent, provider } = body.success;
  if (provider === undefined) return Response.json({ error: "invalid_provider" }, { status: 400 });

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
    events.publishGlobal("auth");
    if (state.status === "pending")
      yield* Effect.forkDetach(
        Effect.gen(function* () {
          for (;;) {
            yield* Effect.sleep("250 millis");
            if ((yield* configured.auth.status).status !== "pending") break;
          }
          events.publishGlobal("auth");
        }).pipe(
          Effect.catchCause(() =>
            Effect.sync(() => {
              events.publishGlobal("auth");
            }),
          ),
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
  return agent.runPromise(response);
}
