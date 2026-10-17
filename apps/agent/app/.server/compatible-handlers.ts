import { Effect, Schema } from "effect";
import {
  CompatibleConnectionInput,
  CompatibleModelInput,
  OpenAICompatibleSettings,
  type GlobalConfigFailed,
  type OpenAICompatibleFailed,
  type OpenAICompatibleStatus,
} from "memory-agent";

const AccountId = Schema.String.check(Schema.isMaxLength(128));
const provider = Schema.Literal("openai-compatible");
/** `/api/accounts` commands for compatible endpoints; shared intents keep the subscription names. */
export const CompatibleAccountCommand = Schema.Union([
  Schema.Struct({
    provider,
    intent: Schema.Literal("create"),
    label: Schema.optional(Schema.String),
    ...CompatibleConnectionInput.fields,
  }),
  Schema.Struct({
    provider,
    intent: Schema.Literal("connect"),
    accountId: AccountId,
    ...CompatibleConnectionInput.fields,
  }),
  Schema.Struct({
    provider,
    intent: Schema.Literal("rename"),
    accountId: AccountId,
    label: Schema.String,
  }),
  Schema.Struct({
    provider,
    intent: Schema.Literal("save-model"),
    accountId: AccountId,
    model: CompatibleModelInput,
  }),
  Schema.Struct({
    provider,
    intent: Schema.Literals(["remove-model", "test"]),
    accountId: AccountId,
    modelId: Schema.String,
  }),
  Schema.Struct({
    provider,
    intent: Schema.Literals(["select", "remove", "discover"]),
    accountId: AccountId,
  }),
]);
export type CompatibleAccountCommand = typeof CompatibleAccountCommand.Type;

const reply = <A>(value: A, status = 200) =>
  Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
const view = (status: OpenAICompatibleStatus) =>
  reply({ type: "compatible-endpoint" as const, ...status });

const respond = (
  effect: Effect.Effect<
    Response,
    OpenAICompatibleFailed | GlobalConfigFailed,
    OpenAICompatibleSettings
  >,
) =>
  effect.pipe(
    Effect.catchTags({
      GlobalConfigFailed: () => Effect.succeed(reply({ error: "settings_unavailable" }, 500)),
      OpenAICompatibleFailed: (failure) => {
        switch (failure.operation) {
          case "validation":
            return Effect.succeed(reply({ error: "invalid_settings" }, 400));
          case "missing":
            return Effect.succeed(reply({ error: "account_not_found" }, 404));
          case "keychain":
            return Effect.succeed(reply({ error: "keychain_failed" }, 500));
          case "partial":
            return Effect.succeed(reply({ error: "settings_partially_saved" }, 409));
          case "test":
          case "models":
            return Effect.succeed(reply({ error: "provider_unavailable" }, 502));
        }
      },
    }),
  );

/** GET `/api/accounts?provider=openai-compatible`: every endpoint and its catalog, no secrets. */
export const compatibleAccounts = respond(
  Effect.flatMap(OpenAICompatibleSettings, (settings) => Effect.map(settings.status, view)),
);

/** POST `/api/accounts` for a compatible endpoint; the route decodes and checks the request. */
export const compatibleAccountAction = (command: CompatibleAccountCommand) =>
  respond(
    Effect.gen(function* () {
      const settings = yield* OpenAICompatibleSettings;
      switch (command.intent) {
        case "create":
          return view(yield* settings.create(command));
        case "connect":
          return view(yield* settings.connect(command.accountId, command));
        case "rename":
          return view(yield* settings.rename(command.accountId, command.label));
        case "save-model":
          return view(yield* settings.saveModel(command.accountId, command.model));
        case "remove-model":
          return view(yield* settings.removeModel(command.accountId, command.modelId));
        case "select":
          return view(yield* settings.select(command.accountId));
        case "remove":
          return view(yield* settings.remove(command.accountId));
        case "test":
          return reply(yield* settings.test(command.accountId, command.modelId));
        case "discover":
          return reply({
            models: (yield* settings.discover(command.accountId)).map((id) => ({ id })),
          });
      }
    }),
  );
