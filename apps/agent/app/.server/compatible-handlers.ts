import { Data, Effect, Result, Schema } from "effect";
import { OpenAICompatibleSettings } from "memory-agent";
import { readJson, rejectCrossSite } from "~/.server/http";

const Command = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("update"),
    baseUrl: Schema.String,
    model: Schema.String,
    contextWindow: Schema.Int,
    outputBudget: Schema.Int,
    toolCalling: Schema.Boolean,
    apiKey: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  Schema.Struct({ action: Schema.Literals(["test", "list"]) }),
]);
class InvalidCommand extends Data.TaggedError("InvalidCommand") {}

const respond = <A>(
  effect: Effect.Effect<
    A,
    | InvalidCommand
    | { readonly _tag: "OpenAICompatibleFailed"; readonly operation: string }
    | { readonly _tag: "GlobalConfigFailed" },
    OpenAICompatibleSettings
  >,
) =>
  effect.pipe(
    Effect.map((value) => Response.json(value)),
    Effect.catchTags({
      GlobalConfigFailed: () =>
        Effect.succeed(Response.json({ error: "settings_unavailable" }, { status: 500 })),
      InvalidCommand: () =>
        Effect.succeed(Response.json({ error: "invalid_settings" }, { status: 400 })),
      OpenAICompatibleFailed: (failure) => {
        const { error, status } =
          failure.operation === "validation"
            ? { error: "invalid_settings", status: 400 }
            : failure.operation === "keychain"
              ? { error: "keychain_failed", status: 500 }
              : failure.operation === "partial"
                ? { error: "settings_partially_saved", status: 409 }
                : { error: "provider_unavailable", status: 502 };
        return Effect.succeed(Response.json({ error }, { status }));
      },
    }),
  );

interface CompatibleRuntime {
  readonly runPromise: <A, E>(program: Effect.Effect<A, E, OpenAICompatibleSettings>) => Promise<A>;
}
export function makeCompatibleHandlers(agent: CompatibleRuntime) {
  function loader() {
    return agent.runPromise(
      respond(Effect.flatMap(OpenAICompatibleSettings, (settings) => settings.status)),
    );
  }
  function action({ request }: { request: Request }) {
    return agent.runPromise(
      Effect.gen(function* () {
        const rejected = rejectCrossSite(request);
        if (rejected !== null) return rejected;
        return yield* respond(
          Effect.gen(function* () {
            const command = yield* Effect.tryPromise({
              try: () => readJson(request, Command),
              catch: () => new InvalidCommand(),
            });
            if (Result.isFailure(command)) return yield* new InvalidCommand();
            const settings = yield* OpenAICompatibleSettings;
            switch (command.success.action) {
              case "update":
                return yield* settings.update(command.success);
              case "test":
                return yield* settings.test;
              case "list":
                return { models: (yield* settings.listModels).map((id) => ({ id })) };
            }
          }),
        );
      }),
    );
  }

  return { action, loader };
}
